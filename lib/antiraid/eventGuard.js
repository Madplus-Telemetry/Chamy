// lib/antiraid/eventGuard.js
// Spam etkinlik temizleyici. Raid/reklam hesaplari "Scheduled Event" acip kendi
// sunucularinin davet linkini koyuyor. Antiraid'i acik sunucularda, Manage Events /
// Manage Server / Administrator yetkisi OLMAYAN (ve beyaz listede olmayan) birinin
// actigi, adinda / aciklamasinda / konumunda BASKA bir sunucunun daveti bulunan etkinlik
// silinir ve alert kanalina bildirilir. Kendi sunucunun daveti serbest.

const { PermissionsBitField } = require('discord.js');
const configStore = require('./configStore');
const { sendAlert } = require('./alert');
const perms = require('../perms');

const INVITE_RE = /(discord(?:app)?\.com\/invite|discord\.gg|dsc\.gg)\/([A-Za-z0-9-]{2,32})/gi;
const warnedNoPerm = new Set(); // guildId: izin eksik uyarisi bir kez

function extractInvites(text) {
    const out = [];
    const seen = new Set();
    for (const m of String(text || '').matchAll(INVITE_RE)) {
        const key = m[2].toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ host: m[1].toLowerCase(), code: m[2] });
    }
    return out;
}

/** Davetlerden bu sunucuya AIT OLMAYANLARI doner (suresi dolmus/cozulemeyen de sayilir). */
async function foreignInvites(client, guild, invites) {
    const bad = [];
    for (const inv of invites.slice(0, 5)) {
        if (inv.host === 'dsc.gg') { bad.push({ ...inv, name: null }); continue; } // cozulemez
        const info = await client.fetchInvite(inv.code).catch(() => null);
        if (info?.guild?.id === guild.id) continue; // kendi sunucunun daveti (vanity dahil)
        bad.push({ ...inv, name: info?.guild?.name || null });
    }
    return bad;
}

function isExempt(cfg, guild, member, creatorId) {
    if (!creatorId) return false;
    if (creatorId === guild.ownerId || perms.isOwner(creatorId)) return true;
    if (!member) return false;
    const p = member.permissions;
    if (p.has(PermissionsBitField.Flags.Administrator) ||
        p.has(PermissionsBitField.Flags.ManageGuild) ||
        p.has(PermissionsBitField.Flags.ManageEvents)) return true;
    return configStore.isWhitelisted(cfg, member.id, member.roles.cache);
}

function safeText(s, max) {
    return String(s || '')
        .replace(INVITE_RE, '[invite link]')
        .replace(/[*_`~|>\\]/g, '')
        .replace(/@/g, '@​')
        .trim()
        .slice(0, max);
}

/** Etkinligi incele; silindiyse true. */
async function inspect(client, event) {
    const guild = event?.guild;
    if (!guild) return false;
    const cfg = await configStore.get(guild.id);
    if (!cfg.enabled) return false;
    if (event.creatorId && event.creatorId === client.user.id) return false;

    const text = [event.name, event.description, event.entityMetadata?.location]
        .filter(Boolean).join('\n');
    const invites = extractInvites(text);
    if (!invites.length) return false;

    if (!guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageEvents)) {
        if (!warnedNoPerm.has(guild.id)) {
            warnedNoPerm.add(guild.id);
            console.warn(`[EVENTGUARD] ${guild.id}: need Manage Events to delete spam events`);
        }
        return false;
    }

    const creator = event.creatorId
        ? (guild.members.cache.get(event.creatorId) || await guild.members.fetch(event.creatorId).catch(() => null))
        : null;
    if (isExempt(cfg, guild, creator, event.creatorId)) return false;

    const bad = await foreignInvites(client, guild, invites);
    if (!bad.length) return false;

    try {
        await event.delete();
    } catch (err) {
        console.warn(`[EVENTGUARD] delete failed in ${guild.id}: ${err.message}`);
        return false;
    }
    console.warn(`[EVENTGUARD] deleted event ${event.id} in ${guild.id} (creator ${event.creatorId})`);

    await sendAlert(guild, cfg, {
        title: '🗑️ Spam event deleted',
        lines: [
            `Deleted the event **${safeText(event.name, 80) || 'untitled'}**` +
                (event.creatorId ? ` created by <@${event.creatorId}>` : '') + '.',
            `It advertised another server: ` +
                bad.map(b => b.name ? `**${safeText(b.name, 60)}**` : '_unknown / expired invite_').join(', ') + '.',
            '_Members without Manage Events cannot post invites to other servers in events._',
        ],
    });
    return true;
}

/** Acik olan etkinlikleri tara (bot kapaliyken acilanlar icin). */
async function sweep(client) {
    let deleted = 0;
    for (const guild of client.guilds.cache.values()) {
        try {
            const cfg = await configStore.get(guild.id);
            if (!cfg.enabled) continue;
            const events = await guild.scheduledEvents.fetch().catch(() => null);
            if (!events) continue;
            for (const ev of events.values()) {
                if (await inspect(client, ev).catch(() => false)) deleted++;
            }
        } catch { /* yut */ }
    }
    if (deleted) console.warn(`[EVENTGUARD] sweep deleted ${deleted} event(s)`);
    return deleted;
}

module.exports = { inspect, sweep, extractInvites };
