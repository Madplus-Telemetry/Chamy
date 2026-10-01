// events/globalBanRequests.js
// Global ban istegi butonlari:
//   gbreq_review_<id>  istek mesajindaki "Review & decide" -> son 10 mesajli popup
//   gbreq_ban_<id>     popup: bu sunucuda banla
//   gbreq_skip_<id>    popup: "Not needed", banlama
// Karar verebilmek icin Ban Members yetkisi gerekir.

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } = require('discord.js');
const GlobalBanRequest = require('../models/GlobalBanRequest');
const globalban = require('../lib/antiraid/globalban');
const { requestEmbed, reviewEmbed } = require('../lib/antiraid/globalRequest');

function decisionRow(id) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`gbreq_ban_${id}`).setLabel('Ban').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`gbreq_skip_${id}`).setLabel('Not needed').setStyle(ButtonStyle.Secondary),
    );
}

/** Kanaldaki asil istek mesajini karara gore guncelle, butonlari kaldir. */
async function finalizeMessage(client, req, target, decision) {
    if (!target?.channelId || !target?.messageId) return;
    const ch = await client.channels.fetch(target.channelId).catch(() => null);
    const msg = await ch?.messages?.fetch(target.messageId).catch(() => null);
    await msg?.edit({ embeds: [requestEmbed(req, { decision })], components: [] }).catch(() => {});
}

async function handle(client, interaction) {
    const [, action, id] = interaction.customId.split('_');
    if (!interaction.guild || !/^[a-f0-9]{24}$/.test(id || '')) {
        return interaction.reply({ content: '❌ This only works inside a server.', ephemeral: true });
    }
    if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.BanMembers)) {
        return interaction.reply({ content: '❌ Only members with **Ban Members** can decide this.', ephemeral: true });
    }

    const req = await GlobalBanRequest.findById(id);
    if (!req) {
        return interaction.reply({ content: 'This request has expired or was withdrawn.', ephemeral: true });
    }
    const guildId = interaction.guildId;
    const target = req.targets.find(t => t.guildId === guildId);
    if (!target) {
        return interaction.reply({ content: '❌ This server was not asked about that request.', ephemeral: true });
    }
    if (target.status !== 'pending') {
        return interaction.reply({
            content: target.status === 'banned'
                ? `Already decided: banned by <@${target.decidedBy}>.`
                : `Already decided: marked not needed by <@${target.decidedBy}>.`,
            ephemeral: true,
        });
    }

    if (action === 'review') {
        return interaction.reply({
            embeds: [reviewEmbed(req, interaction.guild)],
            components: [decisionRow(id)],
            ephemeral: true,
        });
    }
    if (action !== 'ban' && action !== 'skip') return;

    await interaction.deferUpdate();

    // Kararı atomik sahiplen: iki moderator ayni anda basarsa sadece biri gecer.
    const status = action === 'ban' ? 'banned' : 'skipped';
    const claimed = await GlobalBanRequest.findOneAndUpdate(
        { _id: id, targets: { $elemMatch: { guildId, status: 'pending' } } },
        { $set: {
            'targets.$.status': status,
            'targets.$.decidedBy': interaction.user.id,
            'targets.$.decidedAt': new Date(),
        } },
    );
    if (!claimed) {
        return interaction.editReply({ content: 'Someone else already decided this.', embeds: [], components: [] });
    }
    const claimedTarget = claimed.targets.find(t => t.guildId === guildId);
    const decision = { status, by: interaction.user.id };

    if (action === 'ban') {
        const why = `approved by ${interaction.user.username} - ${req.fromGuildName}: ${req.reason}`;
        const res = await globalban.banOne(interaction.guild, req.userId, why);
        if (!res.ok) {
            // Ban olmadi: karari geri al ki moderator tekrar deneyebilsin.
            await GlobalBanRequest.updateOne(
                { _id: id, 'targets.guildId': guildId },
                { $set: { 'targets.$.status': 'pending', 'targets.$.decidedBy': null, 'targets.$.decidedAt': null } },
            );
            return interaction.followUp({ content: `❌ I could not ban them: ${res.why}`, ephemeral: true });
        }
        console.warn(`[GLOBALBAN] ${req.userId} banned in ${guildId} (approved by ${interaction.user.id})`);
        await interaction.editReply({
            content: `✅ Banned <@${req.userId}> (\`${req.userId}\`) in this server.`,
            embeds: [], components: [],
        });
    } else {
        await interaction.editReply({
            content: `➖ Marked as not needed. <@${req.userId}> was not banned here.`,
            embeds: [], components: [],
        });
    }
    await finalizeMessage(client, req, claimedTarget, decision);
}

module.exports = (client) => {
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isButton() || !interaction.customId.startsWith('gbreq_')) return;
        try {
            await handle(client, interaction);
        } catch (err) {
            console.error('[GLOBALBAN] button:', err);
            const msg = { content: '❌ Something went wrong handling that request.', ephemeral: true };
            if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
            else await interaction.reply(msg).catch(() => {});
        }
    });
};
