const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
const { unlockChannel } = require('../lib/channelLock');

function ok(desc)  { return new EmbedBuilder().setColor(0x2ecc71).setDescription(desc); }
function err(desc) { return new EmbedBuilder().setColor(0xe74c3c).setDescription(desc); }

function resultEmbed(r, tag) {
    if (r.busy) return err('⏳ A lock/unlock is already running on this channel.');
    const note = r.restored === false ? '\nNo saved lock state was found, so only the @everyone restriction was cleared.' : '';
    return ok(`🔓 **Channel Unlocked!** Previous permissions restored.${note}`)
        .setFooter({ text: `Unlocked by ${tag}` })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unlockchannel')
        .setDescription('Unlock the channel and restore its previous permissions.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        await interaction.deferReply();
        const r = await unlockChannel(interaction.channel, interaction.guild);
        await interaction.editReply({ embeds: [resultEmbed(r, interaction.user.tag)] });
    },

    async prefix(message) {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageChannels))
            return message.reply({ embeds: [err('❌ You need **Manage Channels** permission.')] });
        const r = await unlockChannel(message.channel, message.guild);
        return message.reply({ embeds: [resultEmbed(r, message.author.tag)] });
    }
};
