// services/serverProfile.js
// ─────────────────────────────────────────────────────────────────────────────
// Chamy — sunucu başına yapılandırılmış profil
//
// learner.js serbest "fact" cümleleri çıkarır; bu dosya her sunucu için tek,
// sorgulanabilir bir profil tutar:
//   • owner, staff                → doğrudan Discord'dan (AI yok)
//   • aktif üyeler, yoğun saatler → events/serverPulse.js'in pasif sayaçları
//   • host'lar, yarış düzeni, ligler, takvim, puan tablosu
//                                 → Discord Scheduled Event'leri + duyuru/takvim/
//                                   puan kanalları, Claude ile JSON'a çıkarılır
//                                   (puan tablosu resimse vision)
//
// refreshServerProfile(guild, opts)  → profili yeniden kurar (1-2 Claude çağrısı)
// getServerProfileContext(guildId)   → ommy.js system prompt'una eklenen özet
// getServerProfile(guildId, section) → get_server_profile tool'unun tam verisi
// ─────────────────────────────────────────────────────────────────────────────

const { ChannelType, PermissionsBitField } = require('discord.js');
const ServerProfile  = require('../models/ServerProfile');
const ServerActivity = require('../models/ServerActivity');
const learner        = require('./learner');

const WEEK_MS   = 7 * 24 * 60 * 60 * 1000;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SCHEDULE_RE  = /(takvim|calendar|schedule|duyuru|announce|event|etkinlik|race|yar[ıi][şs]|lobby|lobi|session|round|fixture|program|host)/i;
const STANDINGS_RE = /(standing|puan|point|tablo|leaderboard|championship|[şs]ampiyona|result|sonu[çc]|classification|wdc|wcc)/i;

const MAX_CHANNELS         = 10;
const MESSAGES_PER_CHANNEL = 50;
const MAX_DUMP_CHARS       = 30000; // ~8k token — Gemma free tier'\u0131n dakikal\u0131k token limitine s\u0131\u011fs\u0131n

// Aynı sunucu için aynı anda iki refresh koşmasın.
const inFlight = new Set();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function currentWeek(t = Date.now()) {
    return Math.floor(t / WEEK_MS);
}

function isValidTimezone(tz) {
    if (!tz || typeof tz !== 'string') return false;
    try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; }
    catch { return false; }
}

function str(v, max = 200) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
}

function toDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

function unix(d) {
    return Math.floor(new Date(d).getTime() / 1000);
}

// Discord <t:unix:X> etiketlerini kesin UTC zamana çevir — model saat dilimi
// tahmin etmek zorunda kalmasın.
function expandDiscordTimestamps(text) {
    return (text || '').replace(/<t:(\d{9,11})(?::[tTdDfFR])?>/g,
        (_, s) => `[${new Date(Number(s) * 1000).toISOString()}]`);
}

function messageText(msg) {
    let text = msg.content?.trim() || '';
    for (const emb of msg.embeds || []) {
        const parts = [];
        if (emb.title)       parts.push(`[${emb.title}]`);
        if (emb.description) parts.push(emb.description);
        for (const f of emb.fields || []) parts.push(`${f.name}: ${f.value}`);
        if (emb.timestamp)   parts.push(`(embed time ${new Date(emb.timestamp).toISOString()})`);
        if (parts.length) text = text ? `${text}\n${parts.join('\n')}` : parts.join('\n');
    }
    return expandDiscordTimestamps(text);
}

function messageImage(msg) {
    const att = [...msg.attachments.values()].find(a =>
        a.contentType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(a.name || ''));
    if (att) return att.url;
    const emb = (msg.embeds || []).find(e => e.image?.url);
    return emb?.image?.url || null;
}

function parseJson(raw) {
    const text = raw || '';
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('no JSON object in model output');
    return JSON.parse(text.slice(s, e + 1));
}

function fmtHours(hours, tz) {
    if (!Array.isArray(hours) || hours.length === 0) return '';
    const base = new Date();
    const useTz = isValidTimezone(tz);
    const out = hours.map(h => {
        const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), h));
        return useTz
            ? d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
            : `${String(h).padStart(2, '0')}:00`;
    });
    return `${out.join(', ')} ${useTz ? `(${tz})` : 'UTC'}`;
}

// ── Discord'dan doğrudan gelenler ─────────────────────────────────────────

async function collectStaff(guild) {
    if (guild.memberCount && guild.memberCount <= 5000) {
        await guild.members.fetch().catch(() => {});
    }
    const F = PermissionsBitField.Flags;
    const roles = [...guild.roles.cache.values()]
        .filter(r => !r.managed && r.id !== guild.id && (
            r.permissions.has(F.Administrator) ||
            r.permissions.has(F.ManageGuild) ||
            r.permissions.has(F.ManageMessages)))
        .sort((a, b) => b.position - a.position);

    const people = new Map();
    for (const role of roles) {
        for (const [, m] of role.members) {
            if (m.user.bot || people.has(m.id) || m.id === guild.ownerId) continue;
            people.set(m.id, { userId: m.id, name: m.displayName, detail: role.name, score: role.position });
        }
    }
    return [...people.values()].slice(0, 20);
}

async function collectScheduledEvents(guild) {
    try {
        const events = await guild.scheduledEvents.fetch();
        return [...events.values()]
            .filter(e => e.scheduledStartTimestamp && e.scheduledStartTimestamp > Date.now() - 3 * 60 * 60 * 1000)
            .sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp)
            .slice(0, 15)
            .map(e => ({
                title:       e.name || '',
                startsAt:    new Date(e.scheduledStartTimestamp),
                host:        e.creator?.globalName || e.creator?.username || '',
                sourceUrl:   e.url || '',
                description: (e.description || '').slice(0, 300),
                location:    e.entityMetadata?.location || e.channel?.name || '',
            }));
    } catch {
        return [];
    }
}

// ── Pasif sayaçlardan (serverPulse) son 2 hafta ───────────────────────────

async function aggregateActivity(guildId) {
    const w = currentWeek();
    const docs = await ServerActivity.find({ guildId, week: { $in: [w, w - 1] } }).lean().catch(() => []);

    const users = new Map();
    const hours = Array(24).fill(0);
    const days  = Array(7).fill(0);

    for (const d of docs) {
        if (d.userId === '__guild__') {
            for (const [h, n] of Object.entries(d.hours || {})) if (hours[+h] !== undefined) hours[+h] += n || 0;
            for (const [k, n] of Object.entries(d.days  || {})) if (days[+k]  !== undefined) days[+k]  += n || 0;
            continue;
        }
        const u = users.get(d.userId) || { userId: d.userId, name: '', count: 0, raceTalk: 0, hostSignals: 0 };
        u.count       += d.count || 0;
        u.raceTalk    += d.raceTalk || 0;
        u.hostSignals += d.hostSignals || 0;
        if (d.name) u.name = d.name;
        users.set(d.userId, u);
    }

    const list   = [...users.values()];
    const active = [...list].sort((a, b) => b.count - a.count).slice(0, 15);
    const hostCandidates = list.filter(u => u.hostSignals >= 2)
        .sort((a, b) => b.hostSignals - a.hostSignals).slice(0, 8);

    const total = hours.reduce((a, b) => a + b, 0);
    const peakHours = total
        ? hours.map((n, h) => [h, n]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(x => x[0]).sort((a, b) => a - b)
        : [];
    const busiestDays = days.some(Boolean)
        ? days.map((n, d) => [d, n]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => DAY_NAMES[x[0]])
        : [];

    return { active, hostCandidates, peakHours, busiestDays, total };
}

// ── Okunacak kanalları seç ────────────────────────────────────────────────

function pickChannels(guild) {
    const me = guild.members.me;
    const F  = PermissionsBitField.Flags;
    const readable = [...guild.channels.cache.values()].filter(c =>
        c.isTextBased() && !c.isThread() &&
        c.type !== ChannelType.GuildVoice && c.type !== ChannelType.GuildStageVoice &&
        me && c.permissionsFor(me)?.has([F.ViewChannel, F.ReadMessageHistory]));

    const label = c => `${c.parent?.name || ''} ${c.name} ${c.topic || ''}`;
    const byPriority = (a, b) => {
        const aAnn = a.type === ChannelType.GuildAnnouncement;
        const bAnn = b.type === ChannelType.GuildAnnouncement;
        if (aAnn !== bAnn) return aAnn ? -1 : 1;
        const x = BigInt(a.lastMessageId || 0);
        const y = BigInt(b.lastMessageId || 0);
        return x > y ? -1 : x < y ? 1 : 0;
    };

    const standings = readable.filter(c => STANDINGS_RE.test(label(c))).sort(byPriority).slice(0, 4);
    const schedule  = readable.filter(c => SCHEDULE_RE.test(label(c)) && !standings.includes(c))
        .sort(byPriority).slice(0, MAX_CHANNELS - standings.length);
    return { schedule, standings };
}

async function readChannel(channel, limit, maxChars) {
    const lines  = [];
    const images = [];
    try {
        const msgs = await channel.messages.fetch({ limit });
        let pinned = [];
        try {
            const p = await channel.messages.fetchPinned();
            pinned = [...p.values()].filter(m => !msgs.has(m.id));
        } catch { /* pinned okunamadı, devam */ }

        const all = [...msgs.values(), ...pinned].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        for (const m of all) {
            const text = messageText(m);
            const img  = messageImage(m);
            if (img) images.push({ url: img, at: m.createdAt.toISOString(), channel: channel.name, caption: text.slice(0, 200) });
            if (text.length < 8) continue;
            const who = m.member?.displayName || m.author.globalName || m.author.username;
            lines.push(`[${m.createdAt.toISOString()}] ${who}${m.pinned ? ' [PINNED]' : ''}${m.author.bot ? ' [BOT]' : ''}: ${text.slice(0, 600)}`);
        }
    } catch { /* erişilemeyen kanal */ }

    // Kanal başına bütçe: en yeni mesajlar kalsın, eskiler düşsün.
    let size = lines.reduce((a, l) => a + l.length + 1, 0);
    while (lines.length && size > maxChars) size -= lines.shift().length + 1;
    return { lines, images };
}

// ── Claude prompt'ları ────────────────────────────────────────────────────

const EXTRACT_SYSTEM = `You build a structured profile of a sim-racing Discord server for its assistant bot (Chamy).
You get: server basics, staff list, activity statistics, Discord scheduled events, and recent messages from the server's schedule/announcement and standings/results channels. Timestamps in [brackets] are exact UTC ISO times.

Return ONLY valid JSON, nothing else:
{
  "games": ["ALL the games this server is actually about — usually one main racing GAME/simulator (e.g. Madcar Racing, GTA 4, FX Racer, Assetto Corsa) PLUS any side/community games it also runs game nights for (e.g. PES, OSM, Among Us, Roblox, Valorant). List every one you see evidence for, not just the first. A game/simulator name here is the game engine/app, NOT a league or season name: a channel or league called 'F1 2020', 'Champmad F1', 'F1 Season 5' etc. is a SERIES INSIDE the main racing game, not a game itself — do not put series/season names here. If the server's own name/branding says a game name (e.g. 'Madcar'), include it even if a side game is discussed more recently. [] if genuinely unclear.", "timezone": "IANA timezone the server clearly uses for its times (e.g. Europe/Istanbul), or null",
  "hosts": [{ "name": "name exactly as written", "detail": "what they host / short evidence", "confidence": 0.8 }],
  "raceSchedule": { "summary": "one sentence, e.g. Races are usually Wednesday and Sunday at 20:00 Turkey time", "days": ["Wed", "Sun"], "times": ["20:00 Europe/Istanbul"] },
  "leagues": [{ "name": "", "format": "e.g. GT3 Sprint, Formula", "status": "active|upcoming|finished" }],
  "calendar": [{ "title": "", "series": "", "track": "", "startsAtUtc": "ISO-8601 UTC or null", "timeText": "time as written", "host": "" }],
  "standings": [{ "series": "", "asOf": "ISO date or null", "rows": [{ "position": 1, "name": "", "team": "", "points": 0 }] }],
  "notes": ["other durable facts a member would ask about, e.g. Lobby codes are posted in #lobby 10 minutes before start"]
}

RULES:
- Return strict, valid JSON only: escape any double-quote character that appears inside a string value as \", no trailing commas, no comments.
- Only what the data actually supports. Never invent people, dates, tracks or points.
- CONSISTENCY: if a calendar entry names a host, that person must also appear in the top-level "hosts" list. If sessions are grouped by series (e.g. "F1", "F2", "GT3 Cup"), each distinct series must also appear in "leagues". Never leave hosts/leagues empty when the calendar/standings already show that information.
- hosts = people who actually open lobbies / run / host races (post lobby codes, say they're hosting, are listed as host). Staff are NOT automatically hosts. HOST SIGNALS are supporting evidence only.
- calendar: only events starting after NOW minus 1 day. Resolve relative dates ("tomorrow 20:00", "yarın", "bu pazar", "this Sunday") against that message's own timestamp. A time without a timezone uses TIMEZONE HINT; if there is no hint, set startsAtUtc null and keep timeText. Max 15, sorted by time. Discord scheduled events are already known — only add them again if the messages give extra detail (series/track).
- standings: only the latest table per series, all visible rows (max 40). Omit if none in the text.
- raceSchedule: only a pattern that actually repeats; otherwise empty summary and arrays.
- Names exactly as they appear. summary/detail/notes in English. Max 8 notes.`;

const VISION_SYSTEM = `You read championship standings / results images posted in a sim-racing Discord server.
Pick the newest standings table per series and transcribe it.

Return ONLY valid JSON:
{ "standings": [{ "series": "", "asOf": "ISO date or null", "rows": [{ "position": 1, "name": "", "team": "", "points": 0 }] }] }

RULES:
- Transcribe what is visible; never guess unreadable names or numbers (leave points null if unreadable).
- Race results with no championship points are not standings — skip them.
- If no image contains standings, return { "standings": [] }.`;

function normalizeStandings(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 6).map(s => ({
        series: str(s?.series, 80),
        asOf:   toDate(s?.asOf),
        rows:   (Array.isArray(s?.rows) ? s.rows : []).slice(0, 40).map(r => ({
            position: num(r?.position),
            name:     str(r?.name, 60),
            team:     str(r?.team, 60),
            points:   num(r?.points),
        })).filter(r => r.name),
    })).filter(s => s.rows.length);
}

// ── Ana iş: profili yeniden kur ───────────────────────────────────────────

async function refreshServerProfile(guild, opts = {}) {
    const notify = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    if (!process.env.GEMINI_API_KEY) return { error: 'GEMINI_API_KEY is not set' };
    if (inFlight.has(guild.id)) return { error: 'a refresh is already running for this server' };
    inFlight.add(guild.id);

    try {
        const existing = await ServerProfile.findOne({ guildId: guild.id }).lean().catch(() => null);
        let timezone       = existing?.timezone || '';
        let timezoneManual = !!existing?.timezoneManual;
        if (opts.timezone) {
            if (!isValidTimezone(opts.timezone)) {
                return { error: `unknown timezone "${opts.timezone}" — use an IANA name like Europe/Istanbul` };
            }
            timezone = opts.timezone;
            timezoneManual = true;
        }
        const tzHint = timezone || (String(guild.preferredLocale || '').startsWith('tr') ? 'Europe/Istanbul' : '');

        await guild.channels.fetch().catch(() => {});
        const owner = await guild.fetchOwner().catch(() => null);
        const [staff, scheduled, activity] = await Promise.all([
            collectStaff(guild),
            collectScheduledEvents(guild),
            aggregateActivity(guild.id),
        ]);

        const { schedule, standings } = pickChannels(guild);
        const channels = [...standings, ...schedule];
        notify(`📡 Profile: reading ${schedule.length} schedule/announcement + ${standings.length} standings channels...`);

        const perChannel = Math.floor(MAX_DUMP_CHARS / Math.max(1, channels.length));
        const dumps = [];
        const standingImages = [];
        for (const ch of channels) {
            const isStandings = standings.includes(ch);
            const { lines, images } = await readChannel(ch, MESSAGES_PER_CHANNEL, perChannel);
            if (lines.length) {
                dumps.push(`### #${ch.name} (${isStandings ? 'STANDINGS/RESULTS' : 'SCHEDULE/ANNOUNCEMENTS'}${ch.parent ? `, category "${ch.parent.name}"` : ''})\n${lines.join('\n')}`);
            }
            if (isStandings) standingImages.push(...images);
            await sleep(300);
        }

        const facts = [
            `NOW (UTC): ${new Date().toISOString()}`,
            `SERVER: ${guild.name} (${guild.memberCount} members, locale ${guild.preferredLocale || 'unknown'})`,
            `SERVER DESCRIPTION: ${guild.description || 'none'}`,
            `CHANNELS: ${[...guild.channels.cache.values()].filter(c => !c.isThread?.()).map(c => c.name).slice(0, 80).join(', ')}`,
            `TIMEZONE HINT: ${tzHint || 'none'}`,
            `OWNER: ${owner ? owner.displayName : 'unknown'}`,
            `STAFF (from Discord roles): ${staff.map(s => `${s.name} [${s.detail}]`).join(', ') || 'none found'}`,
            `MOST ACTIVE (last 2 weeks, message counts): ${activity.active.map(u => `${u.name} ${u.count}`).join(', ') || 'no data yet'}`,
            `HOST SIGNALS (messages about lobbies / room codes / hosting, last 2 weeks): ${activity.hostCandidates.map(u => `${u.name} ${u.hostSignals}`).join(', ') || 'none'}`,
            `DISCORD SCHEDULED EVENTS: ${scheduled.length
                ? scheduled.map(e => `"${e.title}" at [${e.startsAt.toISOString()}] by ${e.host || '?'}${e.location ? ` @ ${e.location}` : ''}${e.description ? ` — ${e.description}` : ''}`).join(' | ')
                : 'none'}`,
        ].join('\n');

        let parsed    = null;
        let lastError = '';
        const extractPrompt = `${facts}\n\n=== CHANNEL MESSAGES ===\n${dumps.join('\n\n') || '(no readable schedule/standings channels)'}`;
        for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
            try {
                const raw = await learner.callClaude(EXTRACT_SYSTEM, extractPrompt, 4096);
                parsed = parseJson(raw);
            } catch (err) {
                lastError = `extract: ${err.message}`.slice(0, 300);
                console.error(`[PROFILE] extract failed (attempt ${attempt + 1}):`, err.message);
            }
        }

        // Metinde tablo yoksa ve puan kanalında resim varsa → vision
        let standingsOut = parsed ? normalizeStandings(parsed.standings) : [];
        if (parsed && standingsOut.length === 0 && standingImages.length > 0) {
            notify('🖼️ Profile: reading standings table images...');
            const latest = [...standingImages].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3);
            const imgs = [];
            const captions = [];
            for (const i of latest) {
                const b64 = await learner.fetchImageAsBase64(i.url);
                if (!b64) continue;
                imgs.push(b64);
                captions.push(`Image ${imgs.length}: #${i.channel}, posted ${i.at}, caption: ${i.caption || '(none)'}`);
            }
            if (imgs.length) {
                try {
                    const vraw = await learner.callClaudeVision(VISION_SYSTEM, captions.join('\n'), imgs);
                    standingsOut = normalizeStandings(parseJson(vraw).standings);
                } catch (err) {
                    console.error('[PROFILE] vision failed:', err.message);
                }
            }
        }

        const base = {
            guildId:        guild.id,
            guildName:      guild.name,
            ownerId:        owner?.id || guild.ownerId || '',
            ownerName:      owner?.displayName || '',
            memberCount:    guild.memberCount || 0,
            staff,
            activeMembers:  activity.active.slice(0, 10).map(u => ({ userId: u.userId, name: u.name, detail: '', score: u.count })),
            peakHoursUtc:   activity.peakHours,
            busiestDays:    activity.busiestDays,
            timezoneManual,
            refreshedAt:    new Date(),
            lastError,
        };

        let learned = {};
        if (parsed) {
            if (!timezoneManual && isValidTimezone(parsed.timezone)) timezone = parsed.timezone;

            const cutoff = Date.now() - 24 * 60 * 60 * 1000;
            const fromDiscord = scheduled.map(e => ({
                title: e.title, series: '', track: '', startsAt: e.startsAt, timeText: '',
                host: e.host, source: 'discord_event', sourceUrl: e.sourceUrl,
            }));
            const fromMessages = (Array.isArray(parsed.calendar) ? parsed.calendar : []).map(e => ({
                title:    str(e?.title, 120),
                series:   str(e?.series, 80),
                track:    str(e?.track, 80),
                startsAt: toDate(e?.startsAtUtc),
                timeText: str(e?.timeText, 80),
                host:     str(e?.host, 60),
                source:   'message',
                sourceUrl: '',
            })).filter(e => (e.title || e.series) && (!e.startsAt || e.startsAt.getTime() > cutoff));

            // Aynı yarış hem Discord event'i hem mesaj olarak gelmesin (±30 dk)
            const calendar = [...fromDiscord];
            for (const e of fromMessages) {
                if (e.startsAt && fromDiscord.some(d => Math.abs(d.startsAt - e.startsAt) < 30 * 60 * 1000)) continue;
                calendar.push(e);
            }
            calendar.sort((a, b) => (a.startsAt ? a.startsAt.getTime() : Infinity) - (b.startsAt ? b.startsAt.getTime() : Infinity));

            const rs = parsed.raceSchedule || {};
            const normName = s => String(s || '').trim().toLowerCase();

            // Model bazen F1/F2 gibi oturumlara host yazıyor ama üstteki özet
            // hosts/leagues listesini boş bırakıyor. Takvimden ve puan
            // tablolarından geriye doğru dolduruyoruz, aynı isim/lig iki kez
            // girmesin.
            const explicitHosts = (Array.isArray(parsed.hosts) ? parsed.hosts : []).slice(0, 10).map(h => ({
                userId: '', name: str(h?.name, 60), detail: str(h?.detail, 160), score: num(h?.confidence) ?? 0.7,
            })).filter(h => h.name);
            const knownHostKeys = new Set(explicitHosts.map(h => normName(h.name)));
            const hostSeries = new Map(); // normalized name -> { name, series: Set }
            for (const e of calendar) {
                if (!e.host || knownHostKeys.has(normName(e.host))) continue;
                const key = normName(e.host);
                const entry = hostSeries.get(key) || { name: e.host, series: new Set() };
                if (e.series) entry.series.add(e.series);
                hostSeries.set(key, entry);
            }
            const backfilledHosts = [...hostSeries.values()]
                .slice(0, Math.max(0, 10 - explicitHosts.length))
                .map(v => ({
                    userId: '', name: v.name, score: 0.6,
                    detail: v.series.size ? `Hosts ${[...v.series].join(', ')} sessions` : 'Hosts sessions on the calendar',
                }));

            const explicitLeagues = (Array.isArray(parsed.leagues) ? parsed.leagues : []).slice(0, 8).map(l => ({
                name: str(l?.name, 80), format: str(l?.format, 80), status: str(l?.status, 20),
            })).filter(l => l.name);
            const knownLeagueKeys = new Set(explicitLeagues.map(l => normName(l.name)));
            const seriesNames = new Set();
            for (const e of calendar) if (e.series) seriesNames.add(e.series);
            for (const s of standingsOut) if (s.series) seriesNames.add(s.series);
            const backfilledLeagues = [...seriesNames]
                .filter(name => !knownLeagueKeys.has(normName(name)))
                .slice(0, Math.max(0, 8 - explicitLeagues.length))
                .map(name => ({ name, format: '', status: 'active' }));

            learned = {
                games: (Array.isArray(parsed.games) ? parsed.games : []).map(g => str(g, 60)).filter(Boolean).slice(0, 6),
                hosts: [...explicitHosts, ...backfilledHosts].slice(0, 10),
                raceSchedule: {
                    summary: str(rs.summary, 300),
                    days:    (Array.isArray(rs.days)  ? rs.days  : []).map(d => str(d, 20)).filter(Boolean).slice(0, 7),
                    times:   (Array.isArray(rs.times) ? rs.times : []).map(t => str(t, 40)).filter(Boolean).slice(0, 6),
                },
                leagues: [...explicitLeagues, ...backfilledLeagues].slice(0, 8),
                calendar: calendar.slice(0, 20),
                standings: standingsOut,
                notes: (Array.isArray(parsed.notes) ? parsed.notes : []).map(n => str(n, 300)).filter(Boolean).slice(0, 8),
            };
        } else if (scheduled.length) {
            // Çıkarım başarısız olsa bile Discord event'leri kesin bilgi — takvimi onlarla güncelle.
            learned.calendar = scheduled.map(e => ({
                title: e.title, series: '', track: '', startsAt: e.startsAt, timeText: '',
                host: e.host, source: 'discord_event', sourceUrl: e.sourceUrl,
            }));
        }

        await ServerProfile.findOneAndUpdate(
            { guildId: guild.id },
            { $set: { ...base, ...learned, timezone } },
            { upsert: true }
        );

        return {
            success:   true,
            staff:     staff.length,
            hosts:     (learned.hosts || existing?.hosts || []).length,
            events:    (learned.calendar || existing?.calendar || []).length,
            standings: (learned.standings || existing?.standings || []).length,
            timezone,
            warning:   lastError || undefined,
        };
    } catch (err) {
        console.error('[PROFILE] refresh failed:', err.message);
        return { error: err.message };
    } finally {
        inFlight.delete(guild.id);
    }
}

// ── Okuma tarafı ──────────────────────────────────────────────────────────

async function getServerProfileContext(guildId) {
    try {
        const p = await ServerProfile.findOne({ guildId }).lean();
        if (!p) return '';

        const L = [];
        L.push(`Server: ${p.guildName} — ${p.memberCount} members. Owner: ${p.ownerName || 'unknown'}.`);
        if (p.timezone) L.push(`Server timezone: ${p.timezone}.`);
        if (p.staff?.length) L.push(`Staff: ${p.staff.map(s => `${s.name} (${s.detail})`).join(', ')}.`);
        if (p.hosts?.length) L.push(`Race hosts: ${p.hosts.map(h => h.detail ? `${h.name} — ${h.detail}` : h.name).join('; ')}.`);
        if (p.raceSchedule?.summary) L.push(`Usual race schedule: ${p.raceSchedule.summary}`);
        if (p.leagues?.length) L.push(`Leagues/series: ${p.leagues.map(l => [l.name, l.format, l.status].filter(Boolean).join(' / ')).join('; ')}.`);

        const upcoming = (p.calendar || [])
            .filter(e => !e.startsAt || new Date(e.startsAt).getTime() > Date.now() - 2 * 60 * 60 * 1000)
            .slice(0, 6);
        if (upcoming.length) {
            L.push('Upcoming:');
            for (const e of upcoming) {
                const what = [e.title, e.series, e.track].filter(Boolean).join(' — ');
                const when = e.startsAt ? `<t:${unix(e.startsAt)}:F> (<t:${unix(e.startsAt)}:R>)` : (e.timeText || 'time unknown');
                L.push(`• ${what} — ${when}${e.host ? `, host ${e.host}` : ''}`);
            }
        }

        for (const s of (p.standings || []).slice(0, 3)) {
            const head = `Standings${s.series ? ` — ${s.series}` : ''}${s.asOf ? ` (as of ${new Date(s.asOf).toISOString().slice(0, 10)})` : ''}`;
            const rows = s.rows.slice(0, 10).map(r => `P${r.position ?? '?'} ${r.name}${r.points != null ? ` ${r.points}pts` : ''}`).join(', ');
            L.push(`${head}: ${rows}${s.rows.length > 10 ? ` … (+${s.rows.length - 10} more — get_server_profile)` : ''}`);
        }

        if (p.activeMembers?.length) L.push(`Most active lately: ${p.activeMembers.slice(0, 8).map(m => m.name).join(', ')}.`);
        if (p.peakHoursUtc?.length) {
            L.push(`Busiest hours: ${fmtHours(p.peakHoursUtc, p.timezone)}${p.busiestDays?.length ? `; busiest days ${p.busiestDays.join(', ')}` : ''}.`);
        }
        for (const n of (p.notes || []).slice(0, 6)) L.push(`• ${n}`);

        const ageH = p.refreshedAt ? Math.round((Date.now() - new Date(p.refreshedAt).getTime()) / 3600000) : null;
        const age  = ageH == null ? 'unknown' : ageH < 1 ? 'just now' : `${ageH}h ago`;
        return `\n\n---\n📋 SERVER PROFILE (learned ${age}; <t:...> values are Discord timestamps — paste them as-is, Discord shows each reader their own local time):\n${L.join('\n')}\n---\n`;
    } catch (err) {
        console.error('[PROFILE] context failed:', err.message);
        return '';
    }
}

// ── Elle duzeltilen ligler ────────────────────────────────────────────────
const LEAGUE_STATUSES = ['active', 'upcoming', 'finished'];
const leagueKey = s => String(s || '').trim().toLowerCase();

// Otomatik cikarilan listeye yonetici duzeltmelerini uygular:
// ayni isim -> durum/format ezilir, 'removed' -> listeden silinir, yeni isim -> eklenir.
function applyLeagueOverrides(leagues, overrides) {
    const out = (leagues || []).map(l => ({ name: l.name, format: l.format || '', status: l.status || '' }));
    for (const o of overrides || []) {
        const k = leagueKey(o.name);
        const i = out.findIndex(l => leagueKey(l.name) === k);
        if (o.status === 'removed') { if (i >= 0) out.splice(i, 1); continue; }
        if (i >= 0) {
            out[i].status = o.status;
            if (o.format) out[i].format = o.format;
        } else {
            out.push({ name: o.name, format: o.format || '', status: o.status });
        }
    }
    return out;
}

// Yoneticinin istegini kaydeder (yenilemelerde korunur) ve gorunen listeyi hemen gunceller.
async function setLeagueStatus(guildId, { name, status, format }) {
    const clean = String(name || '').trim().slice(0, 80);
    if (!clean) return { error: 'missing_name', message: 'Tell me which championship/series to change.' };
    const st = String(status || '').trim().toLowerCase();
    if (![...LEAGUE_STATUSES, 'removed'].includes(st)) {
        return { error: 'invalid_status', message: 'Status must be active, upcoming, finished, or removed.' };
    }
    const fmt = String(format || '').trim().slice(0, 80);
    const p = await ServerProfile.findOne({ guildId });
    if (!p) return { error: 'no_profile', message: 'No profile learned for this server yet. Ask the Commander to refresh the server profile first.' };

    const k = leagueKey(clean);
    const overrides = (p.leagueOverrides || []).filter(o => leagueKey(o.name) !== k).map(o => ({ name: o.name, format: o.format, status: o.status }));
    overrides.push({ name: clean, format: fmt, status: st });
    p.leagueOverrides = overrides;
    p.leagues = applyLeagueOverrides(p.leagues.map(l => ({ name: l.name, format: l.format, status: l.status })), [overrides[overrides.length - 1]]);
    await p.save();
    return { success: true, name: clean, status: st, leagues: p.leagues.map(l => ({ name: l.name, status: l.status })) };
}

async function getServerProfile(guildId, section = 'all') {
    const p = await ServerProfile.findOne({ guildId }).lean().catch(() => null);
    if (!p) return null;

    const when = d => d ? { iso: new Date(d).toISOString(), discord: `<t:${unix(d)}:F>`, relative: `<t:${unix(d)}:R>` } : null;

    const base = {
        server:       p.guildName,
        members:      p.memberCount,
        timezone:     p.timezone || null,
        learnedAt:    p.refreshedAt ? new Date(p.refreshedAt).toISOString() : null,
        raceSchedule: p.raceSchedule || null,
        leagues:      p.leagues || [],
        notes:        p.notes || [],
    };
    const people = {
        owner:         p.ownerName || null,
        staff:         (p.staff || []).map(s => ({ name: s.name, role: s.detail })),
        hosts:         (p.hosts || []).map(h => ({ name: h.name, detail: h.detail })),
        activeMembers: (p.activeMembers || []).map(m => ({ name: m.name, messagesLast2Weeks: m.score })),
        busiestHours:  fmtHours(p.peakHoursUtc, p.timezone) || null,
        busiestDays:   p.busiestDays || [],
    };
    const calendar = (p.calendar || []).map(e => ({
        title: e.title, series: e.series, track: e.track, host: e.host,
        when: when(e.startsAt), timeText: e.timeText || null, source: e.source,
    }));
    const standings = (p.standings || []).map(s => ({
        series: s.series, asOf: s.asOf ? new Date(s.asOf).toISOString().slice(0, 10) : null,
        rows: s.rows.map(r => ({ position: r.position, name: r.name, team: r.team, points: r.points })),
    }));

    if (section === 'calendar')  return { ...base, calendar };
    if (section === 'standings') return { ...base, standings };
    if (section === 'people')    return { ...base, people };
    return { ...base, people, calendar, standings };
}

module.exports = {
    WEEK_MS,
    currentWeek,
    refreshServerProfile,
    getServerProfileContext,
    getServerProfile,
};
