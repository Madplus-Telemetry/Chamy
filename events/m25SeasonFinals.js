// events/m25SeasonFinals.js
// ───────────────────────────────────────────────────────────────────────────
// TEK SEFERLIK: M25'in bitmis sezonlarinin FINAL WDC tablolarini okuyup
// Mad+ rating'e sezon basina bir "yaris" olarak ekler (F1 + F2).
//
// • WCC sayilmaz (takim siralamasi, surucu rating'i degil).
// • Her WDC kanali bastan sona okunur; sezonlar "SEASON N" ayiraclari ve
//   "Final ... standings" mesajlariyla bolunur, her sezonun SON tablosu alinir.
// • Kanalin devam eden son sezonu (ayiracla/final ile kapanmamis) alinmaz.
// • Tablo kanalinda olmayan sezonlar icin #wall-of-champions ilk 3'u yedek.
// • Bittiginde onetimejobs koleksiyonuna isaret birakir, bir daha calismaz.
//   Tekrar calistirmak icin: o dokumani sil (key: JOB_KEY) ve botu yeniden baslat.
// • Rating su an kapaliysa sadece RaceResult'a yazar; rating acilinca
//   recompute bu kayitlari da tarih sirasiyla oynatir.
// ───────────────────────────────────────────────────────────────────────────

const mongoose     = require('mongoose');
const RaceResult   = require('../models/RaceResult');
const gemma        = require('../lib/gemma');
const learner      = require('../services/learner');

const JOB_KEY  = 'm25-season-final-wdc-v1';
const M25_GUILD = '1264284618727886858';

// WDC tablo kanallari (WCC bilerek yok).
const CHANNELS = [
    { id: '1264656991750590514', league: 'F1' }, // eski F1 wdc-standings (S1..S8)
    { id: '1458588955778875525', league: 'F1' }, // yeni F1 wdc-standings (S9..)
    { id: '1458589969445552300', league: 'F2' }, // F2 wdc-standings
];

const GAP_MS      = 7000;                 // Gemma free tier dakika limiti
const ACTIVE_MS   = 60 * 24 * 60 * 60 * 1000; // son mesaj bundan yeniyse son sezon "devam ediyor"
const SEPARATOR_RE = /^[#\s=\-*_]*season\s*(\d+)[\s=\-*_]*$/i;
const SEASON_IN_TITLE_RE = /\bS(?:eason\s*)?(\d{1,2})\b/i;
const FINAL_RE     = /\bfinal\b/i;
const WCC_RE       = /\bwcc\b|constructor/i;

const sleep = ms => new Promise(r => setTimeout(r, ms));

const EXTRACT_SYSTEM = `You read ONE post from a Madcar Racing league's DRIVERS' championship (WDC) standings channel.
It shows the championship table: drivers ranked by total points.

Return ONLY valid JSON:
{"isDriverStandings": true, "season": null, "entries": [{"position": 1, "name": "as written", "userId": "digits or null", "points": 0}]}

RULES:
- isDriverStandings=false if this is a constructors/teams table, a single race result, or not a standings table.
- entries ordered by championship position, ALL drivers you can read (not only the top 3).
- If a driver is a Discord mention like <@123456789012345678>, put the digits in userId.
- Names exactly as written; drop team names/logos. Never invent drivers.
- season: the season number if written (e.g. "S7" -> 7), else null.
- If you can't read the image clearly, return isDriverStandings=false.`;

// ingest.js ile ayni isim normalizasyonu
const FOLD = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ß': 'ss', 'ı': 'i', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'þ': 'th' };
const norm = s => String(s || '')
    .normalize('NFKC')
    .replace(/[øØæÆœŒßıłŁđĐþ]/g, c => FOLD[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

function parseJson(raw) {
    const t = raw || '';
    const s = t.indexOf('{'); const e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

function images(msg) {
    const urls = [...msg.attachments.values()]
        .filter(a => a.contentType?.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(a.name || ''))
        .map(a => a.url);
    for (const emb of msg.embeds || []) if (emb.image?.url) urls.push(emb.image.url);
    return urls.slice(0, 2);
}

function isStandingsPost(msg) {
    const text = msg.content || '';
    if (WCC_RE.test(text)) return false;
    if (images(msg).length) return true;
    // metin tablolari (S7 gibi): en az 5 satir "2nd - ... / 60p"
    return text.split('\n').filter(l => /\d/.test(l)).length >= 5 && /standing|wdc|championship/i.test(text);
}

async function fetchAll(channel) {
    const out = [];
    let before;
    for (;;) {
        const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!batch.size) break;
        out.push(...batch.values());
        before = batch.last().id;
        if (batch.size < 100) break;
    }
    return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

/** Kanal mesajlarini sezonlara boler, her bitmis sezonun son tablosunu dondurur. */
function seasonFinals(messages) {
    const segments = [];            // { season, posts: [], closed }
    let cur = { season: null, posts: [], closed: false };
    const close = () => { cur.closed = true; segments.push(cur); };

    for (const msg of messages) {
        const text = (msg.content || '').trim();
        const sep = text.match(SEPARATOR_RE);
        if (sep && !images(msg).length) {
            if (cur.posts.length) close();
            cur = { season: Number(sep[1]), posts: [], closed: false };
            continue;
        }
        if (!isStandingsPost(msg)) continue;
        const inTitle = text.split('\n')[0].match(SEASON_IN_TITLE_RE);
        if (inTitle && cur.season == null) cur.season = Number(inTitle[1]);
        cur.posts.push(msg);
        if (FINAL_RE.test(text.split('\n')[0])) {
            close();
            cur = { season: null, posts: [], closed: false };
        }
    }
    // Kapanmamis son parca: kanal uzun suredir sessizse sezon bitmis sayilir.
    if (cur.posts.length) {
        const last = cur.posts[cur.posts.length - 1];
        if (Date.now() - last.createdTimestamp > ACTIVE_MS) close();
    }
    return segments.filter(s => s.closed && s.posts.length).map(s => ({ season: s.season, msg: s.posts[s.posts.length - 1] }));
}

async function memberIndex(guild) {
    await guild.members.fetch().catch(() => {});
    const index = new Map();
    for (const [, m] of guild.members.cache) {
        if (m.user.bot) continue;
        for (const n of [m.displayName, m.user.globalName, m.user.username]) {
            const k = norm(n);
            if (k && !index.has(k)) index.set(k, m.id);
        }
    }
    return index;
}

async function extract(msg) {
    const imgs = [];
    for (const url of images(msg)) {
        const img = await learner.fetchImageAsBase64(url);
        if (img) imgs.push(img);
    }
    const raw = await gemma.generate(
        EXTRACT_SYSTEM,
        `CHANNEL: #${msg.channel?.name}\nPOSTED: ${msg.createdAt.toISOString()}\nMESSAGE:\n${msg.content?.trim() || '(no text, see image)'}`,
        imgs,
        4096,
    );
    const parsed = parseJson(raw);
    if (!parsed?.isDriverStandings || !Array.isArray(parsed.entries)) return null;
    return parsed;
}

function toEntries(parsed, index) {
    const out = [];
    const seen = new Set();
    for (const e of parsed.entries.slice(0, 60)) {
        const name = String(e?.name || '').trim().slice(0, 60);
        const mention = String(e?.userId || name).match(/\d{15,21}/)?.[0] || null;
        const userId = mention || index.get(norm(name)) || null;
        const key = userId ? `u:${userId}` : (norm(name) ? `n:${norm(name)}` : null);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push({ key, userId, name: name.replace(/<@!?\d+>/g, '').trim() || name, dnf: false });
    }
    return out.map((e, i) => ({ ...e, position: i + 1 }));
}

// ── Yedek: #wall-of-champions (sadece ilk 3, tablo kanalinda olmayan sezonlar icin)
const WALL_CHANNEL = '1436834302150053998';

/** "S3 ~ 🏆 - <@id> 164 PTS / 2nd ~ <@id> / 3rd ~ @Name" bloklarini okur. */
function parseWall(text) {
    const league = /\*\*F2\*\*/.test(text) ? 'F2' : /\*\*F1\*\*/.test(text) ? 'F1' : null;
    if (!league) return [];
    const seasons = [];
    let cur = null;
    const who = line => {
        const body = line.replace(/<:[^>]+>|<@&\d+>/g, ' ').replace(/^\s*(S\d+|2nd|3rd|🥈|🥉)\s*[~\-]?/i, ' ');
        const m = body.match(/<@!?(\d{15,21})>/);
        if (m) return { userId: m[1], name: '' };
        const n = body.match(/@([^\s\-~]+)/);
        return n ? { userId: null, name: n[1] } : null;
    };
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const s = line.match(/^S(\d+)\b/);
        if (s) { cur = { league, season: Number(s[1]), drivers: [] }; seasons.push(cur); }
        if (!cur) continue;
        if (s || /^(2nd|3rd|🥈|🥉)/.test(line) || (cur.drivers.length === 0 && /<@|@\w/.test(line))) {
            const d = who(line);
            if (d) cur.drivers.push(d);
        }
    }
    return seasons.filter(x => x.drivers.length >= 2);
}

/** Tarihi olmayan sezon icin tahmin: diger ligin ayni sezonu, yoksa komsu sezonlardan ara deger. */
function estimateDate(dates, league, season) {
    const other = dates[league === 'F1' ? 'F2' : 'F1'].get(season);
    if (other) return new Date(other.getTime() + 60 * 60 * 1000);
    const own = [...dates[league].entries()].sort((a, b) => a[0] - b[0]);
    const lo = [...own].reverse().find(([n]) => n < season);
    const hi = own.find(([n]) => n > season);
    if (lo && hi) return new Date(lo[1].getTime() + (hi[1] - lo[1]) * (season - lo[0]) / (hi[0] - lo[0]));
    // Tek taraf varsa ortalama sezon suresiyle geriye/ileriye uzat.
    const all = [...dates.F1.entries(), ...dates.F2.entries()].sort((a, b) => a[0] - b[0]);
    const span = all.length >= 2 ? (all[all.length - 1][1] - all[0][1]) / Math.max(1, all[all.length - 1][0] - all[0][0]) : 0;
    if (span > 0 && hi) return new Date(hi[1].getTime() - span * (hi[0] - season));
    if (span > 0 && lo) return new Date(lo[1].getTime() + span * (season - lo[0]));
    return null;
}

async function run(client) {
    const jobs = mongoose.connection.collection('onetimejobs');
    if (await jobs.findOne({ key: JOB_KEY })) return;
    if (!process.env.GEMINI_API_KEY) { console.log('[M25-FINALS] no GEMINI_API_KEY, skipped'); return; }

    const guild = client.guilds.cache.get(M25_GUILD);
    if (!guild) { console.log('[M25-FINALS] Chamy is not in M25, skipped'); return; }

    console.log('[M25-FINALS] starting one-time season-final WDC scan');
    const index = await memberIndex(guild);
    const report = [];
    let added = 0;
    const dates = { F1: new Map(), F2: new Map() };   // sezon -> final tarihi (bulunanlar)
    const unlabeled = { F1: [], F2: [] };              // sezon numarasi okunamayan finaller

    for (const { id, league } of CHANNELS) {
        const channel = await guild.channels.fetch(id).catch(() => null);
        if (!channel?.isTextBased?.()) { report.push(`${league} ${id}: channel not readable`); continue; }

        let finals;
        try { finals = seasonFinals(await fetchAll(channel)); }
        catch (err) { report.push(`${league} #${channel.name}: fetch failed (${err.message})`); continue; }

        for (const { season, msg } of finals) {
            await sleep(GAP_MS);
            const parsed = await extract(msg).catch(err => { console.error('[M25-FINALS] extract:', err.message); return null; });
            const s = season ?? (Number(parsed?.season) || null);
            const label = `M25 ${league} ${s ? `S${s}` : 'S?'} WDC final`;
            if (!parsed) { report.push(`${label}: unreadable (${msg.url})`); continue; }
            const entries = toEntries(parsed, index);
            if (entries.length < 2) { report.push(`${label}: <2 drivers`); continue; }

            const res = await RaceResult.updateOne(
                { messageId: msg.id },
                { $setOnInsert: {
                    source: 'league', guildId: guild.id, guildName: guild.name, channelId: channel.id,
                    messageId: msg.id, raceAt: msg.createdAt, series: label, track: 'Season standings',
                    memberCount: guild.memberCount || 0, entries,
                } },
                { upsert: true },
            );
            if (res.upsertedCount) added++;
            if (s) dates[league].set(s, msg.createdAt); else unlabeled[league].push(msg.createdAt);
            report.push(`${label}: ${entries.length} drivers, P1 ${entries[0].name}${res.upsertedCount ? '' : ' (already stored)'}`);
        }
    }

    // Yedek: tablo kanallarinda olmayan sezonlar icin #wall-of-champions ilk 3'u.
    const wall = await guild.channels.fetch(WALL_CHANNEL).catch(() => null);
    if (wall?.isTextBased?.()) {
        const wallMsgs = await fetchAll(wall).catch(() => []);
        for (const msg of wallMsgs) {
            for (const { league, season, drivers } of parseWall(msg.content || '')) {
                if (dates[league].has(season)) continue;
                const at = estimateDate(dates, league, season);
                const label = `M25 ${league} S${season} WDC final (top 3)`;
                if (!at) { report.push(`${label}: no date estimate, skipped`); continue; }
                // Numarasiz okunan bir tablo bu sezona denk geliyorsa ikinci kez ekleme.
                if (unlabeled[league].some(d => Math.abs(d - at) < 45 * 24 * 60 * 60 * 1000)) {
                    report.push(`${label}: probably already stored (unlabeled table), skipped`); continue;
                }
                const entries = [];
                const seen = new Set();
                for (const d of drivers) {
                    const userId = d.userId || index.get(norm(d.name)) || null;
                    const key = userId ? `u:${userId}` : (norm(d.name) ? `n:${norm(d.name)}` : null);
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    const member = userId ? guild.members.cache.get(userId) : null;
                    entries.push({ key, userId, name: member?.displayName || d.name || '', dnf: false, position: entries.length + 1 });
                }
                if (entries.length < 2) continue;
                const res = await RaceResult.updateOne(
                    { messageId: `${msg.id}:${league}:S${season}` },
                    { $setOnInsert: {
                        source: 'league', guildId: guild.id, guildName: guild.name, channelId: wall.id,
                        messageId: `${msg.id}:${league}:S${season}`, raceAt: at, series: label,
                        track: 'Season standings', memberCount: guild.memberCount || 0, entries,
                    } },
                    { upsert: true },
                );
                if (res.upsertedCount) added++;
                dates[league].set(season, at);
                report.push(`${label}: ${entries.length} drivers, date ~${at.toISOString().slice(0, 10)}`);
            }
        }
    }

    await jobs.updateOne({ key: JOB_KEY }, { $set: { key: JOB_KEY, doneAt: new Date(), added, report } }, { upsert: true });
    console.log(`[M25-FINALS] done, ${added} season finals stored\n  ${report.join('\n  ')}`);
}

module.exports = (client) => {
    const start = () => {
        // Diger acilis islerinin onunu kesmesin
        setTimeout(() => {
            const go = () => run(client).catch(err => console.error('[M25-FINALS] failed:', err.message));
            if (mongoose.connection.readyState === 1) go();
            else mongoose.connection.once('connected', go);
        }, 2 * 60 * 1000).unref?.();
    };
    if (client.isReady?.()) start();
    else client.once('ready', start);
};
