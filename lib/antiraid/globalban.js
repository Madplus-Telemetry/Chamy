// lib/antiraid/globalban.js
// Global ban'i Chamy'nin bulundugu butun sunuculara uygular / geri alir.
//
// Eskiden global ban sadece "guildMemberAdd" aninda ve sadece /antiraid on olan
// sunucuda calisiyordu; hic sunucuda antiraid acik olmadigi icin hic calismiyordu.
// Elle (bot sahibi) eklenen hesaplar artik her sunucuda uygulanir; hesap sunucuda
// olmasa bile ID ile banlanir. Otomatik (2+ sunucuda raid) girenler eskisi gibi sadece
// antiraid'i acik sunucularda uygulanir.

const { PermissionsBitField } = require('discord.js');

const MARK = 'Global ban';

function reasonFor(reason) {
    return `[Chamy Antiraid] ${MARK}: ${String(reason || 'Known raid account').slice(0, 300)}`;
}

function canBan(guild) {
    return !!guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers);
}

/** Hesabi Chamy'nin oldugu her sunucuda banlar. { banned, already, failed } doner. */
async function banEverywhere(client, userId, reason) {
    const out = { banned: 0, already: 0, failed: 0, skipped: 0 };
    for (const guild of client.guilds.cache.values()) {
        if (!canBan(guild)) { out.skipped++; continue; }
        try {
            const existing = await guild.bans.fetch({ user: userId, force: true }).catch(() => null);
            if (existing) { out.already++; continue; }
            await guild.members.ban(userId, { reason: reasonFor(reason) });
            out.banned++;
        } catch (err) {
            out.failed++;
            console.warn(`[GLOBALBAN] ban ${userId} failed in ${guild.id}: ${err.message}`);
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

module.exports = { banEverywhere, unbanEverywhere, reasonFor };
