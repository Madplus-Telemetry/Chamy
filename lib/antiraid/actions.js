// lib/antiraid/actions.js
// Raid tespit edilince yapilan is.
//
// Rate limit dayanikliligi:
//   - Ban'lar tek tek degil, Discord'un TOPLU ban endpoint'iyle (istek basina 200
//     kisi) atilir. 100 hesaplik raid 1 istekte temizlenir.
//   - Raid suresince gelen supheliler kuyruga girer, 1.5 sn'de bir toplu banlanir.
//   - Buyuk dalgada timeout atlanir (100 timeout istegi ban'lari geciktirir).
//   - Kaynagi kesmek icin lockdown (davet dondurma + dogrulama yukseltme).

const { PermissionsBitField } = require('discord.js');
const configStore = require('./configStore');
const { sendAlert } = require('./alert');
const lockdown = require('./lockdown');
const GlobalBan = require('../../models/GlobalBan');

const TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMEOUTS = 15;     // bundan buyuk dalgada direkt toplu ban
const QUEUE_FLUSH_MS = 1500;

function me(guild) { return guild.members.me; }
function has(guild, flag) { return !!me(guild)?.permissions.has(flag); }
const canBan = g => has(g, PermissionsBitField.Flags.BanMembers);
const canModerate = g => has(g, PermissionsBitField.Flags.ModerateMembers);

async function singleBans(guild, ids, reason) {
    const res = await Promise.all(ids.map(id =>
        guild.bans.create(id, { reason, deleteMessageSeconds: 3600 }).then(() => true).catch(() => false)));
    return res.filter(Boolean).length;
}

/** Toplu ban (200'luk parcalar); desteklenmezse ya da basarisizsa tek tek. */
async function bulkBan(guild, ids, reason) {
    ids = [...new Set(ids)];
    if (!ids.length || !canBan(guild)) return 0;
    const bulkOk = has(guild, PermissionsBitField.Flags.ManageGuild) && typeof guild.bans.bulkCreate === 'function';
    let banned = 0;
    for (let i = 0; i < ids.length; i += 200) {
        const chunk = ids.slice(i, i + 200);
        if (bulkOk) {
            try {
                const res = await guild.bans.bulkCreate(chunk, { reason, deleteMessageSeconds: 3600 });
                banned += res?.bannedUsers?.length ?? chunk.length;
                continue;
            } catch { /* tek tek'e dus */ }
        }
        banned += await singleBans(guild, chunk, reason);
    }
    return banned;
}

// --- Raid suresince gelenler icin toplu ban kuyrugu ---
const queues = new Map(); // guildId -> { ids:Set, timer, reason }

function queueBan(guild, userId, reason) {
    let q = queues.get(guild.id);
    if (!q) { q = { ids: new Set(), timer: null, reason }; queues.set(guild.id, q); }
    q.ids.add(userId);
    if (!q.timer) {
        q.timer = setTimeout(async () => {
            const ids = [...q.ids];
            queues.delete(guild.id);
            const n = await bulkBan(guild, ids, q.reason).catch(() => 0);
            console.warn(`[ANTIRAID] queued raid bans in ${guild.id}: ${n}/${ids.length}`);
            escalateToGlobal(guild.id, ids, 'Join raid', guild.client).catch(() => {});
        }, QUEUE_FLUSH_MS);
    }
}

/**
 * Join raid. suspects banlanir, spared (dalgaya denk gelen gercek gorunumlu
 * hesaplar) banlanmaz, sadece modlara bildirilir. kind: 'fast' | 'cluster'.
 */
async function protectFromJoinRaid(guild, cfg, suspects, spared, kind) {
    const total = suspects.length + spared.length;
    const reason = kind === 'cluster'
        ? `[Chamy Antiraid] Raid: ${suspects.length} look-alike accounts joined`
        : `[Chamy Antiraid] Join raid: ${total} accounts in ${Math.round(cfg.joinWindowMs / 1000)}s`;
    console.warn(`[ANTIRAID] 🚨 ${guild.name} (${guild.id}) — ${reason}`);

    // 1) Kaynagi kes (tek istek) + kucuk dalgada aninda sustur. Paralel.
    const ids = suspects.map(s => s.userId);
    await Promise.all([
        lockdown.engage(guild, cfg).catch(() => false),
        ids.length <= MAX_TIMEOUTS && canModerate(guild)
            ? Promise.all(ids.map(id => guild.members.cache.get(id)?.timeout(TIMEOUT_MS, reason).catch(() => {})))
            : null,
    ]);

    // 2) Toplu ban.
    const banned = await bulkBan(guild, ids, reason);
    escalateToGlobal(guild.id, ids, 'Join raid', guild.client).catch(() => {});

    const list = arr => arr.length <= 15
        ? arr.map(j => `• <@${j.userId}>`).join('\n')
        : `_${arr.length} accounts_`;
    await sendAlert(guild, cfg, {
        title: kind === 'cluster' ? '🚨 Slow raid stopped (look-alike accounts)' : '🚨 Join raid stopped',
        lines: [
            `Banned **${banned}/${ids.length}** suspicious accounts${canBan(guild) ? '' : ' (missing Ban permission!)'}.`,
            ids.length ? list(suspects) : null,
            spared.length
                ? `\nNot banned — looked like real members (older account, own avatar, not part of the cluster):\n${list(spared)}`
                : null,
        ],
    });
}

/** Failin tum rollerini alir + timeout. Nuke ve izin suistimalinde ortak. */
async function stripActor(guild, actorId, reason) {
    const member = await guild.members.fetch(actorId).catch(() => null);
    if (!member) return 0;
    let stripped = 0;
    if (has(guild, PermissionsBitField.Flags.ManageRoles)) {
        const removable = member.roles.cache.filter(r =>
            r.id !== guild.id && !r.managed && r.position < me(guild).roles.highest.position);
        await Promise.all([
            canModerate(guild) ? member.timeout(TIMEOUT_MS, reason).catch(() => {}) : null,
            ...removable.map(r => member.roles.remove(r, reason).then(() => { stripped++; }).catch(() => {})),
        ]);
    }
    // Bot ise direkt at.
    if (member.user.bot && has(guild, PermissionsBitField.Flags.KickMembers)) {
        await member.kick(reason).catch(() => {});
    }
    return stripped;
}

/**
 * Nuke: ele gecirilmis/kotu niyetli yetkili kanal/rol siliyor ya da toplu ban
 * atiyor. Rollerini al, sustur, silinenleri snapshot'tan geri kur.
 */
async function protectFromNuke(guild, cfg, actorId, events) {
    const reason = `[Chamy Antiraid] Nuke: ${events.length} destructive actions in ${cfg.nukeWindowMs}ms`;
    console.warn(`[ANTIRAID] 💣 ${guild.name} (${guild.id}) — actor ${actorId} — ${reason}`);

    const stripped = await stripActor(guild, actorId, reason);

    let restore = null;
    try {
        restore = await require('./restore').restoreLatest(guild);
    } catch (err) {
        console.error('[ANTIRAID] restore failed:', err.message);
    }

    escalateToGlobal(guild.id, [actorId], 'Nuke', guild.client).catch(() => {});

    const kinds = [...new Set(events.map(e => e.kind))].join(', ');
    await sendAlert(guild, cfg, {
        title: '💣 Nuke stopped',
        lines: [
            `<@${actorId}> ran **${events.length}** destructive actions (${kinds}) in under ${Math.round(cfg.nukeWindowMs / 1000)}s.`,
            `Roles stripped: **${stripped}**, timed out for 1h.`,
            restore
                ? `Restored **${restore.channels}** channels, **${restore.roles}** roles from snapshot (${restore.when}).`
                : '_No snapshot to restore from — run `/antiraid snapshot` after fixing the server._',
        ],
    });
}

/**
 * Bir hesabin raide karistigi sunuculari biriktirir; 2+ ayri sunucuda gorulurse
 * global-ban listesine girer. Chamy'nin KENDI raid kararidir: ikinci sunucuda
 * gorulunce hesap, antiraid'i acik diger butun sunucularda sormadan banlanir
 * (client verilmisse). Sonradan girerse de join hook'u atar.
 */
async function escalateToGlobal(guildId, userIds, kind, client = null) {
    for (const userId of userIds) {
        try {
            const doc = await GlobalBan.findOneAndUpdate(
                { userId },
                { $addToSet: { hitGuilds: guildId }, $setOnInsert: { reason: kind, addedBy: 'auto' } },
                { upsert: true, new: true },
            );
            if (doc.hitGuilds.length >= 2) configStore.invalidateGlobalBans();
            // Tam ikinci sunucuya ulasildigi an: korumasi acik herkeste ban (tekrar tekrar degil).
            if (client && doc.hitGuilds.length === 2) {
                require('./globalban')
                    .banEverywhere(client, userId, `${kind} seen in ${doc.hitGuilds.length} servers`, { onlyEnabled: true })
                    .then(r => {
                        if (r.banned) console.warn(`[ANTIRAID] auto global ban ${userId}: banned in ${r.banned} more server(s)`);
                    })
                    .catch(() => {});
            }
        } catch { /* yut */ }
    }
}

module.exports = {
    protectFromJoinRaid, protectFromNuke, stripActor,
    queueBan, bulkBan, escalateToGlobal,
};
