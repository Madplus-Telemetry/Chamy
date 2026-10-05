// events/breakReminder.js
// Chamy DMs a friendly "take a break" reminder when a driver has been racing
// for hours without a real pause.
//
//  - Data: MadRating.history (one entry per race, `at` = race time).
//  - Session: races with gaps <= 45 min between them. It is still active if
//    the last race was within the last 40 min.
//  - Tiers: 2h -> soft reminder, 4h -> firm reminder. Each tier is sent at
//    most once per session (state in BreakReminder, survives restarts).
//  - Only works while rating is enabled (MADPLUS_RATING_ENABLED=true),
//    because the data comes from MadRating.
//  - Closed DMs are ignored silently.

const MadRating      = require('../models/MadRating');
const BreakReminder = require('../models/BreakReminder');
const { isRatingEnabled } = require('../services/rating/config');

const TICK_MS        = 20 * 60 * 1000;
const SESSION_GAP_MS = 45 * 60 * 1000;
const ACTIVE_MS      = 40 * 60 * 1000;
const HOUR           = 60 * 60 * 1000;

// Highest tier first.
const TIERS = [
    { level: 2, hours: 4 },
    { level: 1, hours: 2 },
];

const MESSAGES = {
    1: (hours, races) =>
        `🏁 Hey, you've been racing non-stop for about ${hours} hours (${races} races this session). ` +
        `Even if you're on a roll, take 10 minutes: drink some water, rest your eyes. ` +
        `The track isn't going anywhere 😉`,
    2: (hours, races) =>
        `⚠️ ${hours} hours without a break (${races} races). ` +
        `Fatigue brings mistakes, not speed. Take a real break: sleep, food, some fresh air. ` +
        `Your rating isn't going anywhere, you can pick it back up tomorrow 🏎️`,
};

let running = false;

/** Current racing session from a rating history. -> { start, end, races } | null */
function currentSession(history) {
    const times = (history || [])
        .map(h => (h && h.at ? new Date(h.at).getTime() : NaN))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    if (!times.length) return null;
    let start = times.length - 1;
    while (start > 0 && times[start] - times[start - 1] <= SESSION_GAP_MS) start--;
    return { start: times[start], end: times[times.length - 1], races: times.length - start };
}

async function tick(client) {
    if (running) return;
    running = true;
    try {
        if (!isRatingEnabled()) return;

        const since = new Date(Date.now() - ACTIVE_MS);
        const active = await MadRating.find(
            { userId: { $ne: null }, lastRaceAt: { $gte: since } },
            { userId: 1, history: { $slice: -200 } },
        ).lean();

        for (const p of active) {
            const s = currentSession(p.history);
            if (!s) continue;
            const hours = (s.end - s.start) / HOUR;
            const tier = TIERS.find(t => hours >= t.hours);
            if (!tier) continue;

            const rec = await BreakReminder.findOne({ userId: p.userId }).lean();
            // A DM sent after this session began belongs to this session.
            const sentLevel = rec?.lastSentAt && new Date(rec.lastSentAt).getTime() >= s.start ? rec.level : 0;
            if (tier.level <= sentLevel) continue;

            const user = await client.users.fetch(p.userId).catch(() => null);
            if (!user) continue;

            try {
                await user.send(MESSAGES[tier.level](hours.toFixed(1), s.races));
                console.log(`[BREAK] level ${tier.level} reminder sent -> ${user.tag}`);
            } catch (err) {
                // DMs closed: record it anyway so we don't retry every tick.
                console.warn(`[BREAK] DM failed -> ${user.tag}: ${err.message}`);
            }

            await BreakReminder.updateOne(
                { userId: p.userId },
                { $set: { level: tier.level, lastSentAt: new Date() } },
                { upsert: true },
            );
        }
    } catch (err) {
        console.error('[BREAK] tick failed:', err.message);
    } finally {
        running = false;
    }
}

module.exports = (client) => {
    const start = () => {
        setTimeout(() => tick(client), 7 * 60 * 1000).unref?.();
        setInterval(() => tick(client), TICK_MS).unref?.();
    };
    if (client.isReady?.()) start();
    else client.once('ready', start);
};

module.exports.currentSession = currentSession;
