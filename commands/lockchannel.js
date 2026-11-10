const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { lockChannel } = require('../lib/channelLock');

function ok(desc)  { return new EmbedBuilder().setColor(0x2ecc71).setDescription(desc); }
function err(desc) { return new EmbedBuilder().setColor(0xe74c3c).setDescription(desc); }

function resultEmbed(r, tag) {
    if (r.busy)          return err('⏳ A lock/unlock is already running on this channel.');
    if (r.alreadyLocked) return err('🔒 This channel is already locked. Use unlock to restore it.');
    return ok(`🔒 **Channel Locked!** All non-staff roles have been restricted.`)
        .setFooter({ text: `Locked by ${tag}` })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lockchannel')
        .setDescription('Lock the channel from all non-staff roles.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        await interaction.deferReply();
        const r = await lockChannel(interaction.channel, interaction.guild);
        await interaction.editReply({ embeds: [resultEmbed(r, interaction.user.tag)] });
    },

    async prefix(message) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
            return message.reply({ embeds: [err('❌ You need **Manage Channels** permission.')] });
        const r = await lockChannel(message.channel, message.guild);
        return message.reply({ embeds: [resultEmbed(r, message.author.tag)] });
    }
};
