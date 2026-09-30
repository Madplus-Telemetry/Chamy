// events/carSubmissions.js
// ───────────────────────────────────────────────────────────────────────────
// Mad+ katalogunda olmayan araclar icin kullanicilarin gonderdigi ekran
// goruntuleri. Lobi /v1/cars/submissions'tan cekilir, her gonderim yetkililerin
// kanalina (CAR_SUBMISSION_CHANNEL_ID) resim + arac id'si ile atilir ve araba
// adi / sinifi / skin'i istenir.
//
// Env: MADPLUS_LOBBY_URL, MADPLUS_LEAGUE_SYNC_KEY (rating ile ayni),
//      CAR_SUBMISSION_CHANNEL_ID (yetkililerin gorecegi kanal)
// Imlec: ResultCursor 'lobby:car-submissions' (lastMessageId = son seq). Bir
// gonderim kanala atilamazsa imlec ilerlemez, sonraki tick'te yeniden denenir.
// ───────────────────────────────────────────────────────────────────────────

const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const ResultCursor = require('../models/ResultCursor');

const CURSOR_ID = 'lobby:car-submissions';
const TICK_MS = 2 * 60 * 1000;
let running = false;
let warned = false;

function lobby() {
    const base = (process.env.MADPLUS_LOBBY_URL || '').trim()
        .replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/+$/, '');
    const key = (process.env.MADPLUS_LEAGUE_SYNC_KEY || '').trim();
    return base && key ? { base, key } : null;
}

async function tick(client) {
    if (running) return;
    const l = lobby();
    const channelId = (process.env.CAR_SUBMISSION_CHANNEL_ID || '').trim();
    if (!l || !channelId) {
        if (!warned) {
            warned = true;
            console.log('[CARS] Disabled (MADPLUS_LOBBY_URL / MADPLUS_LEAGUE_SYNC_KEY / CAR_SUBMISSION_CHANNEL_ID missing).');
        }
        return;
    }
    running = true;
    try {
        const channel = client.channels.cache.get(channelId)
            || await client.channels.fetch(channelId).catch(() => null);
        if (!channel?.send) {
            console.error('[CARS] Staff channel not reachable:', channelId);
            return;
        }

        const cursor = await ResultCursor.findOne({ channelId: CURSOR_ID }).lean();
        let since = Number(cursor?.lastMessageId) || 0;

        // Bir tick'te en fazla 3x3 gonderim (sunucu 3'lu sayfa doner).
        for (let page = 0; page < 3; page++) {
            const res = await fetch(`${l.base}/v1/cars/submissions?since=${since}`, {
                headers: { 'X-MadPlus-League-Key': l.key },
                signal: AbortSignal.timeout(20_000),
            });
            if (!res.ok) throw new Error(`lobby ${res.status}`);
            const data = await res.json();
            const list = Array.isArray(data.submissions) ? data.submissions : [];
            if (!list.length) break;

            for (const s of list) {
                const discordId = String(s.accountId || '').replace(/^discord:/, '');
                const file = new AttachmentBuilder(Buffer.from(String(s.image || ''), 'base64'), { name: `car-${s.carId}-${s.seq}.jpg` });
                const embed = new EmbedBuilder()
                    .setColor(0xE10600)
                    .setTitle(`🚗 Unknown car — ID ${s.carId}`)
                    .setDescription(
                        'A Mad+ user used a car that is not in the catalog and sent a screenshot.\n\n' +
                        '**Please reply with the car name, class (F1 / GT3 / Hypercar / Porsche / other) and skin/livery if visible.**',
                    )
                    .addFields(
                        { name: 'Car ID', value: String(s.carId), inline: true },
                        { name: 'Sent by', value: /^\d{17,20}$/.test(discordId) ? `<@${discordId}>` : 'unknown', inline: true },
                        { name: 'Submission', value: `#${s.seq}`, inline: true },
                    )
                    .setImage(`attachment://${file.name}`)
                    .setTimestamp(s.createdAt ? new Date(Number(s.createdAt)) : new Date());
                await channel.send({ embeds: [embed], files: [file], allowedMentions: { parse: [] } });
                since = Number(s.seq);
                await ResultCursor.updateOne(
                    { channelId: CURSOR_ID },
                    { $set: { lastMessageId: String(since), scannedAt: new Date() } },
                    { upsert: true },
                );
                console.log(`[CARS] Forwarded car ${s.carId} screenshot #${s.seq}`);
            }
            if (list.length < 3) break;
        }
    } catch (err) {
        console.error('[CARS] tick failed:', err.message);
    } finally {
        running = false;
    }
}

module.exports = (client) => {
    const start = () => {
        setTimeout(() => tick(client), 20_000).unref?.();
        setInterval(() => tick(client), TICK_MS).unref?.();
    };
    if (client.isReady?.()) start();
    else client.once('ready', start);
};
