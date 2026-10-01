// commands/antiraid.js
// Chamy antiraid yonetimi. Varsayilan KAPALI; her sunucunun yetkilisi buradan acar.
// Global-ban listesine ekleme/cikarma sadece bot sahibinde (Gofret).

const {
    SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, PermissionsBitField,
} = require('discord.js');
const AntiraidConfig = require('../models/AntiraidConfig');
const GlobalBan = require('../models/GlobalBan');
const configStore = require('../lib/antiraid/configStore');
const { takeSnapshot } = require('../lib/antiraid/snapshot');
const { restoreLatest } = require('../lib/antiraid/restore');
const { trustOf } = require('../lib/trust/score');
const perms = require('../lib/perms');

async function upsert(guildId, patch) {
    const doc = await AntiraidConfig.findOneAndUpdate(
        { guildId }, { $set: { ...patch, updatedAt: new Date() } },
        { upsert: true, new: true },
    );
    configStore.invalidate(guildId);
    return doc;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('antiraid')
        .setDescription('Chamy raid protection')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand(s => s.setName('on').setDescription('Enable raid protection in this server'))
        .addSubcommand(s => s.setName('off').setDescription('Disable raid protection in this server'))
        .addSubcommand(s => s.setName('status').setDescription('Show current antiraid settings'))
        .addSubcommand(s => s.setName('snapshot').setDescription('Save the server structure now (for nuke restore)'))
        .addSubcommand(s => s.setName('restore').setDescription('Restore channels/roles from the latest snapshot'))
        .addSubcommand(s => s.setName('unlock').setDescription('End a raid lockdown now (re-open invites, restore verification level)'))
        .addSubcommand(s => s
            .setName('alertchannel').setDescription('Where raid alerts are posted')
            .addChannelOption(o => o.setName('channel').setDescription('Alert channel').setRequired(true)))
        .addSubcommand(s => s
            .setName('whitelist').setDescription('Never act on this user or role')
            .addUserOption(o => o.setName('user').setDescription('User to whitelist'))
            .addRoleOption(o => o.setName('role').setDescription('Role to whitelist')))
        .addSubcommand(s => s
            .setName('sensitivity').setDescription('Tune raid thresholds')
            .addIntegerOption(o => o.setName('joins').setDescription('Joins in 10s that count as a raid (default 6)').setMinValue(3).setMaxValue(50))
            .addIntegerOption(o => o.setName('nuke').setDescription('Destructive actions in 10s that count as a nuke (default 4)').setMinValue(2).setMaxValue(20)))
        .addSubcommand(s => s
            .setName('tonescan').setDescription('Daily AI scan of new messages for raid recon / harassment')
            .addBooleanOption(o => o.setName('enabled').setDescription('Turn the daily scan on or off').setRequired(true)))
        .addSubcommand(s => s
            .setName('trust').setDescription("Show a member's trust score")
            .addUserOption(o => o.setName('user').setDescription('Member').setRequired(true)))
        .addSubcommand(s => s
            .setName('globalban').setDescription('Ban an account here now and ask other Chamy servers to ban it too')
            .addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Why (shown to the other servers)').setRequired(true)))
        .addSubcommand(s => s
            .setName('globalunban').setDescription('Bot owner only: remove an account from the global ban list and unban it everywhere')
            .addStringOption(o => o.setName('user_id').setDescription('User ID').setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;

        // Tum alt komutlar Administrator ister (setDefaultMemberPermissions).
        // globalban: her sunucu admini atabilir. Kendi sunucuda aninda ban; diger sunuculara
        // moderator kanalinda istek gider (Review -> son 10 mesaj -> Ban / Not needed).
        // globalunban: sadece bot sahibi.
        if (sub === 'globalban' || sub === 'globalunban') {
            if (sub === 'globalunban' && !perms.isOwner(interaction.user.id)) {
                return interaction.reply({ content: '❌ Only the bot owner can remove a global ban.', ephemeral: true });
            }
            const userId = interaction.options.getString('user_id').trim().replace(/[<@!>]/g, '');
            if (!/^\d{17,20}$/.test(userId)) {
                return interaction.reply({ content: '❌ That is not a valid user ID.', ephemeral: true });
            }
            const globalban = require('../lib/antiraid/globalban');
            await interaction.deferReply({ ephemeral: true });

            if (sub === 'globalban') {
                const reason = interaction.options.getString('reason').trim().slice(0, 300);
                const text = await require('../lib/antiraid/globalRequest').issue(interaction, userId, reason);
                return interaction.editReply(text);
            }

            await GlobalBan.deleteOne({ userId });
            await require('../models/GlobalBanRequest').deleteMany({ userId });
            configStore.invalidateGlobalBans();
            const r = await globalban.unbanEverywhere(interaction.client, userId);
            return interaction.editReply(
                `✅ \`${userId}\` removed from the global ban list.\n` +
                `Unbanned in **${r.unbanned}** server(s); ${r.kept} server(s) keep a ban with a different reason; ` +
                `not banned in ${r.none}; failed in ${r.failed}; no ban permission in ${r.skipped}.`,
            );
        }

        if (sub === 'on') {
            await upsert(guildId, { enabled: true });
            const missing = missingPerms(interaction.guild);
            await takeSnapshot(interaction.guild, 'enable').catch(() => {});
            return interaction.reply(
                `🛡️ Raid protection **enabled**.\n` +
                (missing.length
                    ? `⚠️ I'm missing these permissions, protection will be limited: **${missing.join(', ')}**`
                    : `All required permissions present. Saved a structure snapshot for nuke restore.`),
            );
        }

        if (sub === 'off') {
            await upsert(guildId, { enabled: false });
            return interaction.reply('🛡️ Raid protection **disabled**.');
        }

        if (sub === 'alertchannel') {
            const ch = interaction.options.getChannel('channel');
            await upsert(guildId, { alertChannelId: ch.id });
            return interaction.reply(`✅ Raid alerts will be posted in ${ch}.`);
        }

        if (sub === 'sensitivity') {
            const joins = interaction.options.getInteger('joins');
            const nuke = interaction.options.getInteger('nuke');
            const patch = {};
            if (joins != null) patch.joinThreshold = joins;
            if (nuke != null) patch.nukeThreshold = nuke;
            if (!Object.keys(patch).length) return interaction.reply({ content: 'Nothing to change.', ephemeral: true });
            await upsert(guildId, patch);
            return interaction.reply(`✅ Updated: ${joins != null ? `join raid = ${joins}/10s` : ''} ${nuke != null ? `nuke = ${nuke}/10s` : ''}`.trim());
        }

        if (sub === 'whitelist') {
            const user = interaction.options.getUser('user');
            const role = interaction.options.getRole('role');
            if (!user && !role) return interaction.reply({ content: 'Give a user or a role.', ephemeral: true });
            const patch = {};
            if (user) patch.$addToSet = { whitelistUserIds: user.id };
            if (role) patch.$addToSet = { ...(patch.$addToSet || {}), whitelistRoleIds: role.id };
            await AntiraidConfig.findOneAndUpdate({ guildId }, patch, { upsert: true });
            configStore.invalidate(guildId);
            return interaction.reply(`✅ Whitelisted ${user ? user : ''}${user && role ? ' and ' : ''}${role ? role : ''}.`);
        }

        if (sub === 'snapshot') {
            await interaction.deferReply();
            const snap = await takeSnapshot(interaction.guild, 'manual');
            return interaction.editReply(`📸 Snapshot saved: **${snap.channels.length}** channels, **${snap.roles.length}** roles.`);
        }

        if (sub === 'restore') {
            if (!interaction.guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
                return interaction.reply({ content: '❌ I need Manage Channels to restore.', ephemeral: true });
            }
            await interaction.deferReply();
            const r = await restoreLatest(interaction.guild);
            if (!r) return interaction.editReply('❌ No snapshot to restore. Run `/antiraid snapshot` first.');
            return interaction.editReply(`⏪ Restored **${r.channels}** channels and **${r.roles}** roles from the ${r.when} snapshot.`);
        }

        if (sub === 'unlock') {
            const ok = await require('../lib/antiraid/lockdown').release(interaction.guild, `by ${interaction.user.tag}`);
            return interaction.reply(ok ? '🔓 Lockdown ended. Invites and verification level restored.' : 'There is no active lockdown.');
        }

        if (sub === 'tonescan') {
            const on = interaction.options.getBoolean('enabled');
            const cfg = await configStore.get(guildId);
            if (on && !cfg.enabled) {
                return interaction.reply({ content: '❌ Turn on raid protection first: `/antiraid on`.', ephemeral: true });
            }
            await upsert(guildId, { toneScan: on });
            return interaction.reply(on
                ? '🔎 Daily tone scan **enabled**. Once a day Chamy reads only the NEW messages since the last scan, ' +
                  'with usernames replaced by pseudonyms, and flags raid reconnaissance (asking who is admin, when mods are offline, etc.) ' +
                  'or targeted harassment. Criticism of mods, jokes and trolling are not flagged. Flags only lower the trust score; nobody is banned for them.'
                : '🔎 Daily tone scan **disabled**.');
        }

        if (sub === 'trust') {
            const user = interaction.options.getUser('user');
            const member = await interaction.guild.members.fetch(user.id).catch(() => null);
            if (!member) return interaction.reply({ content: '❌ That user is not in this server.', ephemeral: true });
            const { score, parts, flags } = await trustOf(member);
            const label = score >= 70 ? '🟢 Trusted' : score >= 40 ? '🟡 Normal' : score >= 20 ? '🟠 Low' : '🔴 Very low';
            const fmt = v => (v >= 0 ? '+' : '') + Math.round(v);
            const breakdown = parts.staff
                ? 'Staff / owner — always trusted.'
                : [
                    `Time in server ${fmt(parts.tenure)}`,
                    `Account age ${fmt(parts.account)}`,
                    `Activity ${fmt(parts.activity)}`,
                    `Consistency ${fmt(parts.consistency)}`,
                    `Social ties ${fmt(parts.social)}`,
                    `Mod rapport ${fmt(parts.modBond)}`,
                    `Reactions ${fmt(parts.reactions)}`,
                    parts.penalty ? `Tone flags ${fmt(parts.penalty)}` : null,
                ].filter(Boolean).join('\n');
            const embed = new EmbedBuilder()
                .setColor(score >= 70 ? 0x2ecc71 : score >= 40 ? 0xf1c40f : score >= 20 ? 0xe67e22 : 0xe74c3c)
                .setTitle(`Trust: ${user.username}`)
                .setDescription(`**${score}/100** · ${label}`)
                .addFields({ name: 'Breakdown', value: breakdown });
            if (flags.length) {
                embed.addFields({
                    name: 'Recent tone flags (30 days)',
                    value: flags.slice(-5).map(f =>
                        `• ${f.type} — ${f.note || 'no note'} (<t:${Math.floor(new Date(f.at).getTime() / 1000)}:R>)`).join('\n'),
                });
            }
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (sub === 'status') {
            const cfg = await configStore.get(guildId);
            const missing = missingPerms(interaction.guild);
            const embed = new EmbedBuilder()
                .setColor(cfg.enabled ? 0x2ecc71 : 0x95a5a6)
                .setTitle('🛡️ Chamy Antiraid')
                .addFields(
                    { name: 'Status', value: cfg.enabled ? '🟢 Enabled' : '⚪ Disabled', inline: true },
                    { name: 'Join raid', value: `${cfg.joinThreshold} joins / ${Math.round(cfg.joinWindowMs / 1000)}s`, inline: true },
                    { name: 'Nuke', value: `${cfg.nukeThreshold} actions / ${Math.round(cfg.nukeWindowMs / 1000)}s`, inline: true },
                    { name: 'Alert channel', value: cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : '_console only_', inline: true },
                    { name: 'Whitelisted', value: `${cfg.whitelistUserIds.length} users, ${cfg.whitelistRoleIds.length} roles`, inline: true },
                    { name: 'Tone scan', value: cfg.toneScan ? '🔎 Daily (03:00 TR)' : 'Off', inline: true },
                    { name: 'Missing perms', value: missing.length ? `⚠️ ${missing.join(', ')}` : '✅ none', inline: false },
                );
            return interaction.reply({ embeds: [embed] });
        }
    },
};

function missingPerms(guild) {
    const me = guild.members.me;
    const need = {
        'Ban Members': PermissionsBitField.Flags.BanMembers,
        'Moderate Members': PermissionsBitField.Flags.ModerateMembers,
        'Manage Roles': PermissionsBitField.Flags.ManageRoles,
        'Manage Channels': PermissionsBitField.Flags.ManageChannels,
        'Manage Messages': PermissionsBitField.Flags.ManageMessages,
        'Manage Server (lockdown, bulk ban)': PermissionsBitField.Flags.ManageGuild,
        'Manage Webhooks': PermissionsBitField.Flags.ManageWebhooks,
        'Kick Members (rogue bots)': PermissionsBitField.Flags.KickMembers,
        'View Audit Log': PermissionsBitField.Flags.ViewAuditLog,
    };
    return Object.entries(need).filter(([, flag]) => !me?.permissions.has(flag)).map(([n]) => n);
}
