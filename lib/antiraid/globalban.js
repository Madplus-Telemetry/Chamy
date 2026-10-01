// lib/antiraid/globalban.js
// Global ban yardimcilari.
//
// - banOne: tek sunucuda ban (izin / hiyerarsi kontrolleriyle).
// - banEverywhere: Chamy'nin KENDI raid kararinda (2+ sunucuda raid) sormadan ban.
//   onlyEnabled ile sadece /antiraid on olan sunucularda calisir.
// - unbanEverywhere: sadece "Global ban" sebebiyle atilmis banlari kaldirir.
//
// Admin kaynakli global ban'lar buradan degil, lib/antiraid/globalRequest.js'teki
// istek/onay akisindan gecer (her sunucunun moderatoru karar verir).

const { PermissionsBitField } = require('discord.js');
const configStore = require('./configStore');

const MARK = 'Global ban';

function reasonFor(reason) {
    return `[Chamy Antiraid] ${MARK}: ${String(reason || 'Known raid account').slice(0, 300)}`;
}

function canBan(guild) {
    return !!guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers);
}

/** Tek sunucuda banlar. { ok, already?, noPerm?, why? } doner. */
async function banOne(guild, userId, reason) {
    if (!canBan(guild)) return { ok: false, noPerm: true, why: 'I do not have Ban Members in this server.' };
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (member && !member.bannable) {
        return { ok: false, why: 'I cannot ban that member (server owner or a role above mine).' };
    }
    const existing = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
    if (existing) return { ok: true, already: true };
    try {
        await guild.members.ban(userId, { reason: reasonFor(reason) });
        return { ok: true };
    } catch (err) {
        return { ok: false, why: err.message };
    }
}

/** Hesabi Chamy'nin oldugu sunucularda banlar. { banned, already, failed, skipped } doner. */
async function banEverywhere(client, userId, reason, { onlyEnabled = false } = {}) {
    const out = { banned: 0, already: 0, failed: 0, skipped: 0 };
    for (const guild of client.guilds.cache.values()) {
        if (onlyEnabled) {
            const cfg = await configStore.get(guild.id);
            if (!cfg.enabled) { out.skipped++; continue; }
        }
        const r = await banOne(guild, userId, reason);
        if (r.ok && r.already) out.already++;
        else if (r.ok) out.banned++;
        else if (r.noPerm) out.skipped++;
        else {
            out.failed++;
            console.warn(`[GLOBALBAN] ban ${userId} failed in ${guild.id}: ${r.why}`);
        }
    }
    return out;
}

/** Sadece global ban sebebiyle atilmis banlari kaldirir (baska sebepli banlara dokunmaz). */
async function unbanEverywhere(client, userId) {
    const out = { unbanned: 0, kept: 0, none: 0, failed: 0, skipped: 0 };
    for (const guild of client.guilds.cache.values()) {
        if (!canBan(guild)) { out.skipped++; continue; }
        try {
            const ban = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
            if (!ban) { out.none++; continue; }
            if (!new RegExp(MARK, 'i').test(ban.reason || '')) { out.kept++; continue; }
            await guild.members.unban(userId, '[Chamy Antiraid] Removed from global ban list');
            out.unbanned++;
        } catch (err) {
            out.failed++;
            console.warn(`[GLOBALBAN] unban ${userId} failed in ${guild.id}: ${err.message}`);
        }
    }
    return out;
}

module.exports = { banOne, banEverywhere, unbanEverywhere, reasonFor };
