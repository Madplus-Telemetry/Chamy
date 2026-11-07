// commands/carss.js
// /carss id:<car id> -> o araca ait ekran goruntusu mesaj(lar)ini bulur ve linkler.
// events/carSubmissions.js'in yetkili kanalina (CAR_SUBMISSION_CHANNEL_ID) attigi
// "Unknown car — ID X" embed'lerini tarar (son ~1000 mesaj).

const { SlashCommandBuilder } = require('discord.js');

const PAGE = 100;
const MAX_PAGES = 10;
const SHOW = 5;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('carss')
        .setDescription('Find the catalog screenshot message for a car ID.')
        .addStringOption(o => o
            .setName('id')
            .setDescription('Car ID')
            .setRequired(true)),

    async execute(interaction) {
        const carId = interaction.options.getString('id').trim();
        const channelId = (process.env.CAR_SUBMISSION_CHANNEL_ID || '').trim();
        if (!channelId) {
            return interaction.reply({ content: '❌ Car screenshot channel is not configured.', ephemeral: true });
        }

        await interaction.deferReply();

        const channel = interaction.client.channels.cache.get(channelId)
            || await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel?.messages) {
            return interaction.editReply('❌ Can\'t reach the car screenshot channel.');
        }

        const found = [];
        try {
            let before;
            for (let page = 0; page < MAX_PAGES; page++) {
                const batch = await channel.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) });
                if (!batch.size) break;
                for (const msg of batch.values()) {
                    if (msg.author?.id !== interaction.client.user.id) continue;
                    const embed = msg.embeds?.[0];
                    const idField = embed?.fields?.find(f => f.name === 'Car ID');
                    if (idField && String(idField.value).trim() === carId) found.push(msg);
                }
                before = batch.last().id;
                if (batch.size < PAGE) break;
            }
        } catch (err) {
            console.error('[CARSS] scan failed:', err.message);
            return interaction.editReply('❌ Couldn\'t read the screenshot channel.');
        }

        if (!found.length) {
            return interaction.editReply(`No screenshot found for car ID **${carId}**.`);
        }

        // found is newest-first
        const lines = found.slice(0, SHOW).map(msg => {
            const f = msg.embeds[0].fields;
            const sub = f.find(x => x.name === 'Submission')?.value || '';
            const by = f.find(x => x.name === 'Sent by')?.value || 'unknown';
            const ts = Math.floor(msg.createdTimestamp / 1000);
            return `${sub} · ${by} · <t:${ts}:R> → ${msg.url}`;
        });
        const more = found.length > SHOW ? `\n…and ${found.length - SHOW} older.` : '';

        return interaction.editReply({
            content: `📸 Car **${carId}** — ${found.length} screenshot${found.length > 1 ? 's' : ''}:\n${lines.join('\n')}${more}`,
            allowedMentions: { parse: [] },
        });
    },
};
