// events/ratingSync.js
// 20 dakikada bir:
//  1) Mad+ lobisinden yeni yaris raporlarini ceker
//  2) SIRADAKI Madcar sunucusunun sonuc kanallarini okur (tick basina tek
//     sunucu, en fazla 12 mesaj -- Gemma free tier)
//  3) rating'i bastan hesaplar (public yarislar 6 saat bekleme sonrasi girer,
//     o yuzden yeni veri olmasa da her tick)
//  4) rating'leri lobiye yollar (app profil ekrani)

const { ingestGuild, recomputeAll } = require('../services/rating/ingest');
const { pullReports, pushRatings } = require('../services/rating/madplus');
const { isRatingEnabled } = require('../services/rating/config');

const TICK_MS = 20 * 60 * 1000;
const lastScan = new Map(); // guildId -> ms
let running = false;

async function tick(client, scan = true) {
    if (running) return;
    running = true;
    try {
        if (!isRatingEnabled()) {
            const cleared = await pushRatings();
            if (!cleared.skipped) console.log('[RATING] Paused; lobby rating snapshot cleared.');
            return;
        }
        const pulled = await pullReports().catch(err => {
            console.error('[RATING] report pull failed:', err.message);
            return { added: 0 };
        });
        if (pulled.added) console.log(`[RATING] ${pulled.added} new Mad+ race reports`);

        if (scan && process.env.GEMINI_API_KEY) {
            const next = [...client.guilds.cache.values()]
                .sort((a, b) => (lastScan.get(a.id) || 0) - (lastScan.get(b.id) || 0))[0];
            if (next) {
                lastScan.set(next.id, Date.now());
                const r = await ingestGuild(next).catch(err => {
                    console.error(`[RATING] ${next.name} ingest failed:`, err.message);
                    return { scanned: 0, added: 0 };
                });
                if (r.scanned) console.log(`[RATING] ${next.name}: ${r.scanned} checked, ${r.added} race results`);
            }
        }

        await recomputeAll();
        // Empty is a valid snapshot too (for example after a rating reset).
        await pushRatings().catch(err => console.error('[RATING] push failed:', err.message));
    } catch (err) {
        console.error('[RATING] tick failed:', err.message);
    } finally {
        running = false;
    }
}

module.exports = (client) => {
    const start = () => {
        if (isRatingEnabled()) {
            // Apply rating rule migrations immediately using the saved races.
            setTimeout(() => tick(client, false), 5_000).unref?.();
            setTimeout(() => tick(client), 5 * 60 * 1000).unref?.();
        } else {
            console.log('[RATING] Paused until release (MADPLUS_RATING_ENABLED is not true).');
            void tick(client);
        }
        setInterval(() => tick(client), TICK_MS).unref?.();
    };
    if (client.isReady?.()) start();
    else client.once('ready', start);
};
