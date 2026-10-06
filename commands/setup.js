const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');
const GuildConfig = require('../models/GuildConfig');
const userLookup = require('../events/userLookup');

function ok(desc)  { return new EmbedBuilder().setColor(0x2ecc71).setDescription(desc); }
function err(desc) { return new EmbedBuilder().setColor(0xe74c3c).setDescription(desc); }

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup')
        .setDescription('Configure server-specific bot settings.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(sub =>
            sub.setName('logs')
                .setDescription('Set the audit log channel for this server.')
                .addChannelOption(o =>
                    o.setName('channel')
                        .setDescription('Target channel (defaults to the channel you run this in)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('logs-off')
                .setDescription('Disable audit logging for this server.')
        )
        .addSubcommand(sub =>
            sub.setName('lookup')
                .setDescription('Set the Mad+ user lookup channel (bot owner / lookup staff only).')
                .addChannelOption(o =>
                    o.setName('channel')
                        .setDescription('Target channel (defaults to the channel you run this in)')
                        .addChannelTypes(ChannelType.GuildText)
                        .setRequired(false)
                )
        )
        .addSubcommand(sub =>
            sub.setName('lookup-off')
                .setDescription('Disable the Mad+ user lookup channel.')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        // Lookup shows other people's Mad+ data: only the bot owner and the
        // configured lookup staff may touch it, whatever their Discord perms are.
        if ((sub === 'lookup' || sub === 'lookup-off') && !userLookup.isAllowed(interaction.user.id)) {
            return interaction.reply({
                embeds: [err('❌ Only the bot owner and the Mad+ lookup staff can use this.')],
                ephemeral: true
            });
        }

        await interaction.deferReply();

        if (sub === 'lookup-off') {
            await GuildConfig.findOneAndUpdate(
                { guildId: interaction.guildId },
                { $unset: { [`settings.${userLookup.SETTING_KEY}`]: '' } },
                { upsert: true }
            );
            userLookup.invalidate(interaction.guildId);

            return interaction.editReply({ embeds: [
                ok('🔕 Mad+ user lookup has been disabled for this server.')
                    .setFooter({ text: `Set by ${interaction.user.tag}` })
                    .setTimestamp()
            ]});
        }

        if (sub === 'lookup') {
            let channel = interaction.options.getChannel('channel');
            if (!channel) {
                if (interaction.channel?.type !== ChannelType.GuildText) {
                    return interaction.editReply({ embeds: [
                        err('❌ Run this in a normal text channel, or pass the `channel` option.')
                    ]});
                }
                channel = interaction.channel;
            }

            await GuildConfig.findOneAndUpdate(
                { guildId: interaction.guildId },
                { $set: { [`settings.${userLookup.SETTING_KEY}`]: channel.id } },
                { upsert: true }
            );
            userLookup.invalidate(interaction.guildId);

            const perms = channel.permissionsFor(interaction.guild.members.me);
            const missingPerms = !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks);
            const everyoneCanSee = channel.permissionsFor(interaction.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);

            const embed = ok(`🔎 Mad+ user lookup is now active in ${channel}.\nType a driver name, a Discord ID or an @mention there.`)
                .setFooter({ text: `Set by ${interaction.user.tag}` })
                .setTimestamp();

            if (missingPerms) {
                embed.addFields({
                    name: '⚠️ Warning',
                    value: 'I don\'t have Send Messages / Embed Links permission in that channel yet — replies won\'t go through until I do.'
                });
            }
            if (everyoneCanSee) {
                embed.addFields({
                    name: '⚠️ Channel is visible to everyone',
                    value: 'Only the bot owner and lookup staff can trigger a lookup, but the results are posted in the channel — make it private.'
                });
            }

            return interaction.editReply({ embeds: [embed] });
        }

        if (sub === 'logs-off') {
            await GuildConfig.findOneAndUpdate(
                { guildId: interaction.guildId },
                { $set: { logChannelId: null } },
                { upsert: true }
            );
            interaction.client.emit('logConfigUpdate', interaction.guildId);

            return interaction.editReply({ embeds: [
                ok('🔕 Audit logging has been disabled for this server.')
                    .setFooter({ text: `Set by ${interaction.user.tag}` })
                    .setTimestamp()
            ]});
        }

        if (sub === 'logs') {
            // No channel given → bind to the channel the command was run in
            let channel = interaction.options.getChannel('channel');
            if (!channel) {
                if (interaction.channel?.type !== ChannelType.GuildText) {
                    return interaction.editReply({ embeds: [
                        err('❌ Run this in a normal text channel, or pass the `channel` option.')
                    ]});
                }
                channel = interaction.channel;
            }

            await GuildConfig.findOneAndUpdate(
                { guildId: interaction.guildId },
                { $set: { logChannelId: channel.id } },
                { upsert: true }
            );

            // Bust events/logs.js's in-memory cache so the change applies immediately
            interaction.client.emit('logConfigUpdate', interaction.guildId);

            const perms = channel.permissionsFor(interaction.guild.members.me);
            const missingPerms = !perms?.has(PermissionFlagsBits.SendMessages) || !perms?.has(PermissionFlagsBits.EmbedLinks);

            const embed = ok(`📋 Audit logs will now be sent to ${channel}.`)
                .setFooter({ text: `Set by ${interaction.user.tag}` })
                .setTimestamp();

            if (missingPerms) {
                embed.addFields({
                    name: '⚠️ Warning',
                    value: 'I don\'t have Send Messages / Embed Links permission in that channel yet — logs won\'t go through until I do.'
                });
            }

            return interaction.editReply({ embeds: [embed] });
        }
    }
};
