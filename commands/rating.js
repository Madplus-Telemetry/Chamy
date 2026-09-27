// commands/rating.js
// /rating show [user]  -> Mad+ rating karti
// /rating top          -> en yuksek rating'ler (yerlesmis suruculer)
// /rating scan         -> bu sunucunun sonuc kanallarini simdi oku (yonetici)
// /rating recalc       -> tum rating'i bastan hesapla (Commander)

const { SlashCommandBuilder, EmbedBuilder, PermissionsBitField } = require('discord.js');
const perms     = require('../lib/perms');
const MadRating = require('../models/MadRating');
const engine    = require('../services/rating/engine');
const { ingestGuild, recomputeAll, resultChannels } = require('../services/rating/ingest');
const { isRatingEnabled, PAUSED_REASON } = require('../services/rating/config');

const sign = v => (v > 0 ? `+${v}` : `${v}`);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rating')
        .setDescription('Mad+ driver rating')
        .addSubcommand(s => s
            .setName('show')
            .setDescription('Show a driver\'s Mad+ rating')
            .addUserOption(o => o.setName('user').setDescription('Driver (default: you)')))
        .addSubcommand(s => s
            .setName('top')
            .setDescription('Top rated drivers'))
        .addSubcommand(s => s
            .setName('scan')
            .setDescription('Read this server\'s results channels now (server managers)'))
        .addSubcommand(s => s
            .setName('recalc')
            .setDescription('Recompute every rating from all races (bot owner)')),

    async execute(interaction) {
        if (!isRatingEnabled()) {
            return interaction.reply({ content: PAUSED_REASON, ephemeral: true });
        }
        const sub = interaction.options.getSubcommand();

        if (sub === 'show') {
            const user = interaction.options.getUser('user') || interaction.user;
            const r = await MadRating.findOne({ userId: user.id }).lean();
            if (!r) {
                return interaction.reply({ content: `${user.id === interaction.user.id ? 'You have' : `${user.username} has`} no rated races yet.`, ephemeral: true });
            }
            const recent = (r.history || []).slice(-5).reverse()
                .map(h => `${h.place ? `P${h.place}/${h.field}` : `DNF/${h.field}`} · **${sign(h.delta)}** · <t:${Math.floor(new Date(h.at).getTime() / 1000)}:d>`)
                .join('\n') || '—';
            const embed = new EmbedBuilder()
                .setColor(r.placement ? 0x8B5CF6 : 0x00E676)
                .setAuthor({ name: user.globalName || user.username, iconURL: user.displayAvatarURL() })
                .setTitle(r.placement
                    ? `Placement ${r.races}/${engine.PLACEMENT_RACES} · ${Math.round(r.rating)}`
                    : `${Math.round(r.rating)} · ${r.challenger ? `Challenger #${r.rank}` : `Level ${r.level}`}`)
                .addFields(
                    { name: 'Races', value: String(r.races), inline: true },
                    { name: 'Wins', value: String(r.wins), inline: true },
                    { name: 'Podiums', value: String(r.podiums), inline: true },
                    { name: 'Peak', value: String(Math.round(r.peak)), inline: true },
                    { name: 'Recent races', value: recent },
                )
                .setFooter({ text: 'Mad+ rating — from league results across Madcar servers' });
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'top') {
            const rows = await MadRating.find({ placement: false }).sort({ rating: -1 }).limit(15).lean();
            if (!rows.length) return interaction.reply({ content: 'No established drivers yet (10 races needed).', ephemeral: true });
            const lines = rows.map((r, i) =>
                `\`${String(i + 1).padStart(2)}\` ${r.userId ? `<@${r.userId}>` : r.name} — **${Math.round(r.rating)}** · L${r.level} · ${r.races} races`);
            const embed = new EmbedBuilder().setColor(0x00E676).setTitle('🏁 Mad+ rating — top drivers').setDescription(lines.join('\n'));
            return interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        }

        if (sub === 'scan') {
            const allowed = perms.isOwner(interaction.user.id) ||
                interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageGuild);
            if (!allowed) return interaction.reply({ content: '❌ Server managers only.', ephemeral: true });
            if (!interaction.guild) return interaction.reply({ content: '❌ Run this inside a server.', ephemeral: true });

            await interaction.deferReply();
            const channels = resultChannels(interaction.guild);
            const r = await ingestGuild(interaction.guild);
            if (r.skipped) return interaction.editReply(`⚠️ Skipped: ${r.skipped}.`);
            let extra = '';
            if (r.added) {
                const c = await recomputeAll();
                extra = `\nRatings recomputed: ${c.players} drivers from ${c.races} races.`;
            }
            return interaction.editReply(
                `📡 Read ${channels.map(c => `<#${c.id}>`).join(', ')} — ${r.scanned} messages checked, **${r.added}** race results saved.${extra}` +
                (r.scanned >= 12 ? '\nMore to read — the rest is picked up automatically.' : ''));
        }

        if (sub === 'recalc') {
            if (!perms.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Bot owner only.', ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            const c = await recomputeAll();
            return interaction.editReply(`✅ Recomputed ${c.players} drivers from ${c.races} races.`);
        }
    },
};
