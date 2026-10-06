// events/userLookup.js
// Staff-only kullanici arama kanali: /setup lookup ile secilen kanala bir isim
// (veya Discord ID / @mention) yazilir, bot Mad+ lobi veritabanindan o kullanicinin
// verilerini embed olarak yollar. Sadece bot sahibi + LOOKUP_USER_IDS (varsayilan:
// afhaam) kullanabilir; baskasinin mesajina hic cevap verilmez.

const { EmbedBuilder } = require('discord.js');
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
        db.collection('lap_traces').find({ accountId }, { projection: { trace: 0 } }).toArray(),
        db.collection('discord_account_data').findOne(
            { accountId },
            { projection: { 'data.profile': 1, 'data.sessions': 1 } }
        ),
        MadRating.findOne({ userId: discordId }).select('-history').lean(),
    ]);
    return { accountId, discordId, sessionLaps, traces, accountData, rating };
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
                track: rec.trackId, cls: rec.carClass, ms: rec.lapTimeMs,
                modded: rec.modded, cut: rec.cutSuspect, dev: rec.cutMaxDevM,
                penalized: rec.penalizedRawMs, trace: isTrace,
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

    return embed;
}

module.exports = client => {
    client.on('messageCreate', async message => {
        try {
            if (message.author.bot || !message.guild) return;
            const channelId = await getLookupChannel(message.guildId);
            if (!channelId || message.channelId !== channelId) return;
            // Erisim kanal izinleriyle belirlenir: kanali gorebilen herkes arayabilir.

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
            const embeds = accounts.map(buildEmbed);
            const extra = ids.length - shown.length;

            await message.reply({
                content: ids.length > 1
                    ? `Found **${ids.length}** accounts${extra > 0 ? ` (showing ${shown.length}; refine the name or paste a Discord ID)` : ''}.`
                    : undefined,
                embeds,
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
