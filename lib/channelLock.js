const { PermissionFlagsBits, OverwriteType } = require('discord.js');
const ChannelLock = require('../models/ChannelLock');

const SEND = PermissionFlagsBits.SendMessages;

// Channels with a lock/unlock currently running. Stops repeated requests
// (spam clicking, AI retries) from racing each other.
const busy = new Set();

function isStaffRole(role) {
    return role.permissions.has(PermissionFlagsBits.ManageMessages) ||
           role.permissions.has(PermissionFlagsBits.Administrator);
}

function stateOf(overwrite) {
    if (!overwrite) return null;
    if (overwrite.allow.has(SEND)) return true;
    if (overwrite.deny.has(SEND))  return false;
    return null;
}

async function lockChannel(channel, guild) {
    if (busy.has(channel.id)) return { busy: true };
    busy.add(channel.id);
    try {
        if (await ChannelLock.exists({ channelId: channel.id })) return { alreadyLocked: true };

        const everyone = guild.roles.everyone;
        const saved   = [{ id: everyone.id, state: stateOf(channel.permissionOverwrites.cache.get(everyone.id)) }];
        const roleIds = [];

        // Only non-staff roles that have an explicit ALLOW overwrite here can bypass
        // the @everyone deny, so only those need touching.
        for (const ow of channel.permissionOverwrites.cache.values()) {
            if (ow.type !== OverwriteType.Role || ow.id === everyone.id) continue;
            if (!ow.allow.has(SEND)) continue;
            const role = guild.roles.cache.get(ow.id);
            if (!role || isStaffRole(role)) continue;
            saved.push({ id: ow.id, state: true });
            roleIds.push(ow.id);
        }

        await ChannelLock.create({ channelId: channel.id, guildId: guild.id, overwrites: saved });

        try {
            for (const id of roleIds)
                await channel.permissionOverwrites.edit(id, { SendMessages: false }).catch(() => {});
            await channel.permissionOverwrites.edit(everyone, { SendMessages: false });
        } catch (err) {
            await ChannelLock.deleteOne({ channelId: channel.id }).catch(() => {});
            throw err;
        }
        return { locked: true };
    } finally {
        busy.delete(channel.id);
    }
}

async function unlockChannel(channel, guild) {
    if (busy.has(channel.id)) return { busy: true };
    busy.add(channel.id);
    try {
        const snap = await ChannelLock.findOne({ channelId: channel.id });

        if (!snap) {
            // Not locked by this system (or locked by the old code, nothing to restore from).
            // Only clear a leftover @everyone deny, never invent allows.
            const everyone = guild.roles.everyone;
            if (channel.permissionOverwrites.cache.get(everyone.id)?.deny.has(SEND))
                await channel.permissionOverwrites.edit(everyone, { SendMessages: null });
            return { unlocked: true, restored: false };
        }

        let failed = 0;
        // Roles first, @everyone last (mirrors lock order in reverse of exposure).
        const ordered = [...snap.overwrites].sort((a, b) => (a.id === guild.id) - (b.id === guild.id));
        for (const o of ordered) {
            await channel.permissionOverwrites.edit(o.id, { SendMessages: o.state }).catch(() => { failed++; });
        }
        await snap.deleteOne();
        return { unlocked: true, restored: true, failed };
    } finally {
        busy.delete(channel.id);
    }
}

module.exports = { lockChannel, unlockChannel };
