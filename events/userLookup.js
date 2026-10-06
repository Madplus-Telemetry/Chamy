// events/userLookup.js
// Staff-only kullanici arama kanali: /setup lookup ile secilen kanala bir isim
// (veya Discord ID / @mention) yazilir, bot Mad+ lobi veritabanindan o kullanicinin
// verilerini embed + grafik + tam veri dosyasi (JSON) olarak yollar. Kanali sadece
// bot sahibi + LOOKUP_USER_IDS (varsayilan: afhaam) secebilir; kanala erisimi olan
// herkes arama yapabilir. JSON dosyasi Lap Trace Inspector artifact'ine yuklenir.

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
let createCanvas = null;
try { ({ createCanvas } = require('@napi-rs/canvas')); } catch { /* grafik opsiyonel */ }
const mongoose = require('mongoose');
const GuildConfig = require('../models/GuildConfig');
const MadRating = require('../models/MadRating');
const MadcarLink = require('../models/MadcarLink');
const perms = require('../lib/perms');

const SETTING_KEY = 'channels:userLookup';
const DEFAULT_ALLOWED = '804202467780722688'; // afhaam

const ALLOWED = new Set(
    String(process.env.LOOKUP_USER_IDS || DEFAULT_ALLOWED)
        .split(',').map(s => s.trim()).filter(Boolean)
);

function isAllowed(userId) {
    return !!userId && (perms.isOwner(userId) || ALLOWED.has(String(userId)));
}

// guildId -> { id, at }
const channelCache = new Map();
const TTL_MS = 30_000;

async function getLookupChannel(guildId) {
    const hit = channelCache.get(guildId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.id;
    let id = null;
    try {
        const doc = await GuildConfig.findOne({ guildId }).lean();
        id = doc?.settings?.[SETTING_KEY] || null;
    } catch (err) {
        if (hit) return hit.id;
        console.error('[userLookup] config load failed:', err.message);
    }
    channelCache.set(guildId, { id, at: Date.now() });
    return id;
}

function invalidate(guildId) {
    channelCache.delete(guildId);
}

function lobbyDb() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.client.db(process.env.LOBBY_DB_NAME || 'madplus');
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fmtMs(ms) {
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${m}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

async function findAccountIds(db, query) {
    const ids = new Set();
    const mention = query.match(/^<@!?(\d{15,20})>$/);
    const raw = mention ? mention[1] : query;

    if (/^\d{15,20}$/.test(raw)) {
        ids.add(`discord:${raw}`);
        return [...ids];
    }

    const rx = new RegExp(escapeRegex(raw), 'i');
    const proj = { projection: { accountId: 1 } };
    const [a, b, c] = await Promise.all([
        db.collection('app_session_laps').find({ driverName: rx }, proj).limit(50).toArray(),
        db.collection('lap_traces').find({ driverName: rx }, proj).limit(50).toArray(),
        db.collection('discord_account_data').find({ 'data.profile.inGameName': rx }, proj).limit(50).toArray(),
    ]);
    [...a, ...b, ...c].forEach(r => r.accountId && ids.add(r.accountId));

    const ratings = await MadRating.find({ name: rx, userId: { $ne: null } }).select('userId').limit(20).lean();
    ratings.forEach(r => ids.add(`discord:${r.userId}`));
    const links = await MadcarLink.find({ nick: rx }).select('discordId').limit(20).lean();
    links.forEach(l => ids.add(`discord:${l.discordId}`));

    return [...ids];
}

async function loadAccount(db, accountId) {
    const discordId = accountId.replace(/^discord:/, '');
    const [sessionLaps, traces, accountData, rating] = await Promise.all([
        db.collection('app_session_laps').find({ accountId }).toArray(),
        db.collection('lap_traces').find({ accountId }).toArray(),
        db.collection('discord_account_data').findOne(
            { accountId },
            { projection: { 'data.profile': 1, 'data.sessions': 1 } }
        ),
        MadRating.findOne({ userId: discordId }).select('-history').lean(),
    ]);
    return { accountId, discordId, sessionLaps, traces, accountData, rating };
}


function parseTrace(str) {
    try { return typeof str === 'string' ? JSON.parse(str) : str; } catch { return null; }
}

// Ayni pist+sinifta baska surucunun en iyi temiz (kesme/mod supheli degil) izi.
async function loadBenchmark(db, accountId, trackId, carClass) {
    const doc = await db.collection('lap_traces').find({
        trackId, carClass, verified: true,
        accountId: { $ne: accountId },
        cutSuspect: { $ne: true },
        modded: { $ne: true },
    }).sort({ lapTimeMs: 1 }).limit(1).next();
    if (!doc) return null;
    const trace = parseTrace(doc.trace);
    if (!trace) return null;
    return { driverName: doc.driverName, lapTimeMs: doc.lapTimeMs, trace };
}

// Tam veri paketi: artifact'e yuklenir.
async function buildExport(db, acc, laps) {
    const { discordId, accountData, rating } = acc;
    const profile = accountData?.data?.profile || {};
    const sessions = accountData?.data?.sessions || [];
    const recentTraced = laps.filter(l => l.traceDoc)
        .sort((a, b) => new Date(b.traceDoc.updatedAt || 0) - new Date(a.traceDoc.updatedAt || 0))
        .slice(0, 12);
    const withTrace = new Set(recentTraced.map(l => l.key));

    const outLaps = [];
    for (const l of laps) {
        const item = {
            trackId: l.track, carClass: l.cls, lapTimeMs: l.ms,
            modded: l.modded ?? null, cutSuspect: l.cut ?? null, cutMaxDevM: l.dev ?? null,
            penalizedRawMs: l.penalized ?? null, hasTrace: !!l.traceDoc,
            trace: null, benchmark: null,
        };
        if (withTrace.has(l.key)) {
            item.trace = parseTrace(l.traceDoc.trace);
            item.benchmark = await loadBenchmark(db, acc.accountId, l.track, l.cls).catch(() => null);
        }
        outLaps.push(item);
    }
    return {
        discordId,
        names: acc.names,
        profile,
        rating: rating ? {
            rating: rating.rating, level: rating.level, races: rating.races, wins: rating.wins,
            podiums: rating.podiums, peak: rating.peak, placement: rating.placement,
        } : null,
        sessions: sessions.map(s => ({
            trackId: s.trackId, carId: s.carId ?? null, startedAt: s.startedAt, endedAt: s.endedAt,
            laps: s.laps || [], fullThrottlePct: s.fullThrottlePct, brakingPct: s.brakingPct,
        })),
        laps: outLaps,
    };
}

// Kullanicinin en son izi ile benchmark'i: harita + hiz + zaman farki.
function drawChart(user, bench, label) {
    if (!createCanvas || !user?.samples?.length) return null;
    const W = 1200, H = 640;
    const canvas = createCanvas(W, H);
    const g = canvas.getContext('2d');
    g.fillStyle = '#0f1218'; g.fillRect(0, 0, W, H);
    const RED = '#ff4d4d', ORG = '#ffb02e', GRID = '#252b36', TXT = '#aab3c2';

    g.fillStyle = '#e8ecf3'; g.font = 'bold 22px sans-serif';
    g.fillText(label, 24, 36);
    g.font = '14px sans-serif'; g.fillStyle = TXT;
    g.fillText(`you ${fmtMs(user.lapTimeMs)}` + (bench ? `   benchmark ${bench.driverName} ${fmtMs(bench.lapTimeMs)}` : ''), 24, 58);
    g.fillStyle = RED; g.fillRect(W - 250, 24, 14, 4);
    g.fillStyle = TXT; g.fillText('your lap', W - 230, 30);
    if (bench) { g.fillStyle = ORG; g.fillRect(W - 150, 24, 14, 4); g.fillStyle = TXT; g.fillText('benchmark', W - 130, 30); }

    // --- harita (x,z) ---
    const mx = 24, my = 80, mw = 520, mh = 536;
    const all = user.samples.concat(bench?.trace?.samples || []);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of all) { minX = Math.min(minX, p[2]); maxX = Math.max(maxX, p[2]); minZ = Math.min(minZ, p[4]); maxZ = Math.max(maxZ, p[4]); }
    const sc = Math.min(mw / ((maxX - minX) || 1), mh / ((maxZ - minZ) || 1)) * 0.92;
    const ox = mx + (mw - (maxX - minX) * sc) / 2, oz = my + (mh - (maxZ - minZ) * sc) / 2;
    const proj = p => [ox + (p[2] - minX) * sc, oz + (p[4] - minZ) * sc];
    const line = (samples, color, width) => {
        g.beginPath();
        samples.forEach((p, i) => { const [x, y] = proj(p); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.strokeStyle = color; g.lineWidth = width; g.lineJoin = 'round'; g.stroke();
    };
    if (bench) line(bench.trace.samples, ORG, 4);
    line(user.samples, RED, 2);

    // --- hiz vs mesafe ---
    const px = 580, pw = W - px - 24;
    const panel = (y0, h, title) => {
        g.strokeStyle = GRID; g.lineWidth = 1; g.strokeRect(px, y0, pw, h);
        g.fillStyle = TXT; g.font = '13px sans-serif'; g.fillText(title, px + 8, y0 + 18);
    };
    const sy0 = 80, sh = 300;
    panel(sy0, sh, 'Speed (km/h) vs lap distance');
    const maxV = Math.max(...all.map(p => p[5]), 100);
    const sx = d => px + d * pw;
    const syv = v => sy0 + sh - 8 - (v / maxV) * (sh - 34);
    for (let v = 0; v <= maxV; v += 100) {
        g.strokeStyle = GRID; g.beginPath(); g.moveTo(px, syv(v)); g.lineTo(px + pw, syv(v)); g.stroke();
        g.fillStyle = TXT; g.fillText(String(v), px + 4, syv(v) - 3);
    }
    const speedLine = (samples, color, width) => {
        g.beginPath();
        samples.forEach((p, i) => { const x = sx(p[0]), y = syv(p[5]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.strokeStyle = color; g.lineWidth = width; g.stroke();
    };
    if (bench) speedLine(bench.trace.samples, ORG, 2.5);
    speedLine(user.samples, RED, 1.8);

    // --- zaman farki ---
    const dy0 = 400, dh = 216;
    panel(dy0, dh, bench ? `Time delta vs ${bench.driverName} (s, + = slower)` : 'No benchmark available');
    if (bench) {
        const bs = bench.trace.samples;
        const at = (samples, d) => {
            let lo = 0, hi = samples.length - 1;
            while (lo < hi) { const m = (lo + hi) >> 1; if (samples[m][0] < d) lo = m + 1; else hi = m; }
            return samples[lo][1];
        };
        const deltas = user.samples.map(p => at(bs, p[0]) ? p[1] - at(bs, p[0]) : 0);
        const lim = Math.max(0.5, ...deltas.map(Math.abs));
        const dyv = v => dy0 + dh / 2 - (v / lim) * (dh / 2 - 22);
        g.strokeStyle = GRID; g.beginPath(); g.moveTo(px, dyv(0)); g.lineTo(px + pw, dyv(0)); g.stroke();
        g.fillStyle = TXT; g.fillText(`+${lim.toFixed(1)}`, px + 4, dyv(lim) + 12); g.fillText(`-${lim.toFixed(1)}`, px + 4, dyv(-lim) - 4);
        g.beginPath();
        user.samples.forEach((p, i) => { const x = sx(p[0]), y = dyv(deltas[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); });
        g.strokeStyle = RED; g.lineWidth = 2; g.stroke();
    }
    return canvas.toBuffer('image/png');
}

function buildEmbed(acc) {
    const { accountId, discordId, sessionLaps, traces, accountData, rating } = acc;
    const profile = accountData?.data?.profile || {};
    const sessions = accountData?.data?.sessions || [];

    // Gorulen isimler (en yeniden eskiye)
    const named = [...sessionLaps, ...traces]
        .filter(r => r.driverName)
        .sort((x, y) => new Date(y.updatedAt || 0) - new Date(x.updatedAt || 0));
    const names = [...new Set([profile.inGameName, ...named.map(r => r.driverName), rating?.name].filter(Boolean))];

    // Pist+sinif basina en iyi tur (iz kaydi esitlikte tercih edilir)
    const best = new Map();
    const consider = (rec, isTrace) => {
        if (!rec.trackId || !rec.carClass || typeof rec.lapTimeMs !== 'number') return;
        const key = `${rec.trackId}|${rec.carClass}`;
        const cur = best.get(key);
        if (!cur || rec.lapTimeMs < cur.ms || (rec.lapTimeMs === cur.ms && isTrace)) {
            best.set(key, {
                key, track: rec.trackId, cls: rec.carClass, ms: rec.lapTimeMs,
                modded: rec.modded, cut: rec.cutSuspect, dev: rec.cutMaxDevM,
                penalized: rec.penalizedRawMs, trace: isTrace,
                traceDoc: isTrace ? rec : (cur && cur.traceDoc && cur.ms === rec.lapTimeMs ? cur.traceDoc : null),
            });
        }
    };
    sessionLaps.forEach(r => consider(r, false));
    traces.forEach(r => consider(r, true));

    const rows = [...best.values()].sort((x, y) => x.track.localeCompare(y.track) || x.cls.localeCompare(y.cls));
    const lines = [];
    let used = 0;
    for (const r of rows) {
        let line = `\`${r.track}\` ${r.cls} — **${fmtMs(r.ms)}**`;
        if (r.modded === true) line += ' 🛠 modded';
        if (r.cut === true) line += ` ⚠️ cut? (${r.dev}m)`;
        if (r.penalized) line += ` ⛔ ceza (ham ${fmtMs(r.penalized)})`;
        if (!r.trace) line += ' · iz yok';
        if (used + line.length > 950) break;
        lines.push(line);
        used += line.length + 1;
    }
    const more = rows.length - lines.length;

    const totalLaps = sessions.reduce((n, s) => n + (Array.isArray(s.laps) ? s.laps.length : 0), 0);
    const lastSession = sessions.reduce((m, s) => Math.max(m, s.endedAt || s.startedAt || 0), 0);
    const lastUpload = [...sessionLaps, ...traces]
        .reduce((m, r) => Math.max(m, r.updatedAt ? new Date(r.updatedAt).getTime() : 0), 0);

    const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(names[0] || 'Unknown driver')
        .setDescription(`<@${discordId}> · \`${discordId}\``)
        .setFooter({ text: 'Mad+ user lookup' })
        .setTimestamp();

    if (names.length > 1) {
        embed.addFields({ name: 'Also seen as', value: names.slice(1, 8).join(', ').slice(0, 1000) });
    }

    const profileBits = [];
    if (profile.racingNumber != null) profileBits.push(`#${profile.racingNumber}`);
    if (profile.nationality) profileBits.push(profile.nationality);
    if (profileBits.length) embed.addFields({ name: 'Profile', value: profileBits.join(' · '), inline: true });

    if (rating) {
        const place = rating.placement ? ' (placement)' : '';
        embed.addFields({
            name: 'Mad+ rating',
            value: `**${Math.round(rating.rating)}** · L${rating.level}${place}\n` +
                `${rating.races} races · ${rating.wins}W · ${rating.podiums}P · peak ${Math.round(rating.peak)}`,
            inline: true,
        });
    }

    embed.addFields({
        name: 'Activity',
        value: `${sessions.length} sessions · ${totalLaps} laps` +
            (lastSession ? `\nlast session <t:${Math.floor(lastSession / 1000)}:R>` : '') +
            (lastUpload ? `\nlast lap upload <t:${Math.floor(lastUpload / 1000)}:R>` : ''),
        inline: true,
    });

    embed.addFields({
        name: `Best laps (${rows.length})`,
        value: lines.length
            ? lines.join('\n') + (more > 0 ? `\n…+${more} more` : '')
            : 'No uploaded laps.',
    });

    acc.names = names;
    return { embed, laps: rows };
}

module.exports = client => {
    client.on('messageCreate', async message => {
        try {
            if (message.author.bot || !message.guild) return;
            const channelId = await getLookupChannel(message.guildId);
            if (!channelId || message.channelId !== channelId) return;

            const query = message.content.trim();
            if (!query || query.length > 64) return;

            const db = lobbyDb();
            if (!db) {
                return message.reply({ content: '❌ Database is not ready.', allowedMentions: { repliedUser: false } });
            }

            await message.channel.sendTyping().catch(() => {});
            const ids = await findAccountIds(db, query);
            if (!ids.length) {
                return message.reply({ content: `❌ No Mad+ user found for \`${query.slice(0, 40)}\`.`, allowedMentions: { repliedUser: false } });
            }

            const shown = ids.slice(0, 3);
            const accounts = await Promise.all(shown.map(id => loadAccount(db, id)));
            const built = accounts.map(acc => ({ acc, ...buildEmbed(acc) }));
            const extra = ids.length - shown.length;

            const files = [];
            const exportAccounts = [];
            for (const { acc, laps } of built) {
                // Grafik: en son izi olan tur, benchmark ile
                const latest = laps.filter(l => l.traceDoc)
                    .sort((x, y) => new Date(y.traceDoc.updatedAt || 0) - new Date(x.traceDoc.updatedAt || 0))[0];
                if (latest) {
                    try {
                        const user = parseTrace(latest.traceDoc.trace);
                        const bench = await loadBenchmark(db, acc.accountId, latest.track, latest.cls);
                        const png = drawChart(user, bench, `${acc.names?.[0] || acc.discordId} · ${latest.track} · ${latest.cls}`);
                        if (png) files.push(new AttachmentBuilder(png, { name: `lap-${acc.discordId}.png` }));
                    } catch (e) {
                        console.error('[userLookup] chart failed:', e.message);
                    }
                }
                exportAccounts.push(await buildExport(db, acc, laps));
            }

            const json = Buffer.from(JSON.stringify({ version: 1, query, generatedAt: new Date().toISOString(), accounts: exportAccounts }));
            if (json.length < 8 * 1024 * 1024) {
                const safe = query.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'lookup';
                files.push(new AttachmentBuilder(json, { name: `madplus-${safe}.json` }));
            }

            const embeds = built.map((b, i) => {
                const e = b.embed;
                const hasChart = files.some(f => f.name === `lap-${b.acc.discordId}.png`);
                if (hasChart && i === 0) e.setImage(`attachment://lap-${b.acc.discordId}.png`);
                return e;
            });

            await message.reply({
                content: (ids.length > 1
                    ? `Found **${ids.length}** accounts${extra > 0 ? ` (showing ${shown.length}; refine the name or paste a Discord ID)` : ''}. `
                    : '') + 'Drop the attached JSON into the Lap Trace Inspector for the full view.',
                embeds,
                files,
                allowedMentions: { parse: [], repliedUser: false },
            });
        } catch (err) {
            console.error('[userLookup]', err);
            message.reply({ content: '❌ Lookup failed.', allowedMentions: { repliedUser: false } }).catch(() => {});
        }
    });
};

module.exports.isAllowed = isAllowed;
module.exports.SETTING_KEY = SETTING_KEY;
module.exports.invalidate = invalidate;
