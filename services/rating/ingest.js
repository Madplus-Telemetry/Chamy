// services/rating/ingest.js
// ───────────────────────────────────────────────────────────────────────────
// Lig sonuc kanallarindan yaris sonuclarini toplar (Gemma, resim de okur),
// RaceResult'a yazar, rating'i bastan hesaplar (MadRating).
//
// • Sadece Madcar sunuculari (profil oyunu ya da ad/kanal adinda "Madcar").
// • Kanal: adi result / sonuç / classification / race-report gibi olanlar.
// • Kanal basina imlec (ResultCursor): her mesaj bir kez okunur. Ilk tarama
//   son 60 mesaj (guncel sezon), sonra sadece yeniler.
// • Surucu kimligi: <@id> etiketi -> Discord hesabi; duz ad -> sunucudaki
//   uyelerin gorunen adlariyla eslesirse yine hesap, yoksa ad bazli anahtar.
// ───────────────────────────────────────────────────────────────────────────

const { ChannelType, PermissionsBitField } = require('discord.js');
const RaceResult    = require('../../models/RaceResult');
const MadRating     = require('../../models/MadRating');
const ResultCursor  = require('../../models/ResultCursor');
const ServerProfile = require('../../models/ServerProfile');
const gemma         = require('../../lib/gemma');
const learner       = require('../learner');
const engine        = require('./engine');
const { isRatingEnabled, PAUSED_REASON } = require('./config');

const RESULTS_RE        = /(result|sonu[çc]|classification|klasman|race-?report|yar[ıi][şs]-?sonu)/i;
const MADCAR_RE         = /mad\s*car/i;
// Cok oyunlu sunucularda (M25) Madcar disi liglerin sonuc kanallari.
const OTHER_GAME_RE     = /(f1\s*20\d\d|efootball|minecraft|roblox|gta|fifa|\bfc\s*2\d\b|forza|gran\s*turismo|iracing|assetto)/i;
// Sadece ana sampiyonalar: kupalar, "Road to" merdivenleri, alt seriler sayilmaz.
const SIDE_EVENT_RE     = /(\bcups?\b|road\s*to|karting|\bf3\b|\bf4\b|\bfr\b|\brng\b|gold)/i;
const FIRST_SCAN_LIMIT  = 60;
const MAX_PER_RUN       = 12;   // Gemma free tier dakikalik limitine sigsin

const EXTRACT_SYSTEM = `You read ONE message from a Madcar Racing league's results channel.
Decide whether it contains the FINISHING ORDER of a single race.

Return ONLY valid JSON:
{"isRaceResult": true, "series": "", "track": "", "entries": [{"position": 1, "name": "as written", "userId": "digits or null", "dnf": false}]}

RULES:
- isRaceResult=false for championship standings (points totals), qualifying-only, schedules, announcements, chatter.
- entries in finishing order. Drivers marked DNF/DNS/DSQ go at the END with dnf=true.
- If a driver is written as a Discord mention like <@123456789012345678>, put those digits in userId and the mention text in name.
- Names exactly as written (drop team tags only if clearly separate). Never invent drivers.
- If the message has several races, return only the FIRST race.
- If you can't read an image clearly, return isRaceResult=false.`;

// Isim eslestirme (madplus.js ile ayni): \"K_Møi21\" == \"kmoi21\".
const FOLD = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ß': 'ss', 'ı': 'i', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'þ': 'th' };
const norm = s => String(s || '')
    .normalize('NFKC')
    .replace(/[øØæÆœŒßıłŁđĐþ]/g, c => FOLD[c])
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

function parseJson(raw) {
    const t = raw || '';
    const s = t.indexOf('{');
    const e = t.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

function messageText(msg) {
    let text = msg.content?.trim() || '';
    for (const emb of msg.embeds || []) {
        const parts = [];
        if (emb.title) parts.push(emb.title);
        if (emb.description) parts.push(emb.description);
        for (const f of emb.fields || []) parts.push(`${f.name}: ${f.value}`);
        if (parts.length) text = text ? `${text}\n${parts.join('\n')}` : parts.join('\n');
    }
    return text;
}

function messageImages(msg) {
    const urls = [...msg.attachments.values()]
        .filter(a => a.contentType?.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(a.name || ''))
        .map(a => a.url);
    for (const emb of msg.embeds || []) if (emb.image?.url) urls.push(emb.image.url);
    return urls.slice(0, 2);
}

function looksLikeResult(msg) {
    if (msg.author?.bot && !msg.embeds?.length && !msg.attachments?.size) return false;
    if (messageImages(msg).length) return true;
    const text = messageText(msg);
    return text.split('\n').length >= 3 && /\d/.test(text);
}

async function isMadcarGuild(guild) {
    const p = await ServerProfile.findOne({ guildId: guild.id }, { games: 1 }).lean().catch(() => null);
    if (p?.games?.some(g => MADCAR_RE.test(String(g).normalize('NFKC')))) return true;
    // Profil oyun listesi eksik/yanlis olabilir (M25: "F1 2020, Roblox..." diye
    // ogrenilmis ama adi "Madcar 25"): ad, aciklama ve kanal adlarina da bak.
    const channels = [...guild.channels.cache.values()].map(c => c.name).join(' ');
    return MADCAR_RE.test(`${guild.name} ${guild.description || ''} ${channels}`.normalize('NFKC'));
}

function resultChannels(guild) {
    const me = guild.members.me;
    const F = PermissionsBitField.Flags;
    return [...guild.channels.cache.values()].filter(c =>
        c.isTextBased() && !c.isThread() &&
        c.type !== ChannelType.GuildVoice && c.type !== ChannelType.GuildStageVoice &&
        RESULTS_RE.test(`${c.parent?.name || ''} ${c.name}`) &&
        !OTHER_GAME_RE.test(`${c.parent?.name || ''} ${c.name}`) &&
        !SIDE_EVENT_RE.test(`${c.parent?.name || ''} ${c.name}`) &&
        me && c.permissionsFor(me)?.has([F.ViewChannel, F.ReadMessageHistory]));
}

async function memberIndex(guild) {
    if (guild.memberCount && guild.memberCount <= 5000) await guild.members.fetch().catch(() => {});
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
    const text = messageText(msg);
    const images = [];
    for (const url of messageImages(msg)) {
        const img = await learner.fetchImageAsBase64(url);
        if (img) images.push(img);
    }
    const raw = await gemma.generate(
        EXTRACT_SYSTEM,
        `CHANNEL: #${msg.channel?.name}\nPOSTED: ${msg.createdAt.toISOString()}\nMESSAGE:\n${text || '(no text, see image)'}`,
        images,
        3072,
    );
    const parsed = parseJson(raw);
    if (!parsed?.isRaceResult || !Array.isArray(parsed.entries)) return null;
    return parsed;
}

// Surucu kimligi: <@id> > lig alias tablosu (DriverAlias) > uye adi > ad anahtari.
function toEntries(parsed, index, aliases) {
    const { resolve } = require('./identity');
    const finished = [], dnf = [];
    for (const e of parsed.entries.slice(0, 40)) {
        const who = resolve(e?.name, e?.userId, index, aliases);
        if (!who) continue;
        (e?.dnf ? dnf : finished).push({ ...who, dnf: !!e?.dnf });
    }
    return [...finished, ...dnf].map((e, i) => ({ ...e, position: i + 1 }));
}

/** Bir sunucunun sonuc kanallarindaki YENI mesajlari okur. -> { scanned, added } */
async function ingestGuild(guild) {
    if (!isRatingEnabled()) return { scanned: 0, added: 0, skipped: PAUSED_REASON };
    if (!process.env.GEMINI_API_KEY) return { scanned: 0, added: 0, skipped: 'no GEMINI_API_KEY' };
    if (!(await isMadcarGuild(guild))) return { scanned: 0, added: 0, skipped: 'not a Madcar server' };

    const channels = resultChannels(guild);
    if (!channels.length) return { scanned: 0, added: 0, skipped: 'no results channel' };

    let index = null;
    let scanned = 0, added = 0, budget = MAX_PER_RUN;

    for (const channel of channels) {
        if (budget <= 0) break;
        const cursor = await ResultCursor.findOne({ channelId: channel.id }).lean();
        let messages;
        try {
            const fetched = cursor?.lastMessageId
                ? await channel.messages.fetch({ after: cursor.lastMessageId, limit: 50 })
                : await channel.messages.fetch({ limit: FIRST_SCAN_LIMIT });
            messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        } catch { continue; }

        let lastId = cursor?.lastMessageId || null;
        for (const msg of messages) {
            if (budget <= 0) break;
            lastId = msg.id;
            if (!looksLikeResult(msg)) continue;
            budget--; scanned++;

            const parsed = await extract(msg).catch(err => { console.error('[RATING] extract:', err.message); return null; });
            if (!parsed) continue;
            if (!index) index = await memberIndex(guild);
            const entries = toEntries(parsed, index);
            if (entries.length < 2) continue;

            await RaceResult.updateOne(
                { messageId: msg.id },
                { $setOnInsert: {
                    source: 'league', guildId: guild.id, guildName: guild.name, channelId: channel.id,
                    messageId: msg.id, raceAt: msg.createdAt, series: String(parsed.series || '').slice(0, 80),
                    track: String(parsed.track || '').slice(0, 80), memberCount: guild.memberCount || 0, entries,
                } },
                { upsert: true },
            );
            added++;
        }

        await ResultCursor.updateOne(
            { channelId: channel.id },
            { $set: { guildId: guild.id, lastMessageId: lastId, scannedAt: new Date() } },
            { upsert: true },
        );
    }
    return { scanned, added };
}

/** Lig sonuclari + Mad+ raporlarindan rating'i bastan kurar, MadRating'e yazar. */
async function recomputeAll() {
    if (!isRatingEnabled()) return { players: 0, races: 0, skipped: PAUSED_REASON };
    const leagueRaces = await RaceResult.find({ ignored: { $ne: true } }).lean();
    const races = await require('./madplus').buildRaces(leagueRaces);
    const { players } = engine.recompute(races);

    const ops = [...players.values()].map(p => ({
        updateOne: {
            filter: { key: p.key },
            update: { $set: {
                userId: p.userId, name: p.name, rating: p.rating, level: p.level, races: p.races,
                wins: p.wins, podiums: p.podiums, peak: p.peak, placement: p.placement,
                history: p.history, lastRaceAt: p.lastRaceAt,
            } },
            upsert: true,
        },
    }));
    if (ops.length) await MadRating.bulkWrite(ops, { ordered: false });
    await MadRating.deleteMany({ key: { $nin: [...players.keys()] } });
    return { players: players.size, races: races.length };
}

module.exports = { ingestGuild, recomputeAll, isMadcarGuild, resultChannels };
