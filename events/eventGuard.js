// events/eventGuard.js
// Spam etkinlik temizleyiciyi Discord olaylarina baglar (mantik: lib/antiraid/eventGuard.js).
// Gerekli intent: GuildScheduledEvents (index.js).

const eventGuard = require('../lib/antiraid/eventGuard');

module.exports = (client) => {
    client.on('guildScheduledEventCreate', (event) => {
        eventGuard.inspect(client, event).catch(err =>
            console.error('[EVENTGUARD] create:', err.message));
    });

    // Sonradan duzenleyip link eklemek de ayni.
    client.on('guildScheduledEventUpdate', (_old, event) => {
        if (!event) return;
        eventGuard.inspect(client, event).catch(err =>
            console.error('[EVENTGUARD] update:', err.message));
    });

    client.once('ready', () => {
        // Acilistan 75 sn sonra, sonra 6 saatte bir: bot kapaliyken acilanlari da temizle.
        setTimeout(() => eventGuard.sweep(client).catch(() => {}), 75_000);
        setInterval(() => eventGuard.sweep(client).catch(() => {}), 6 * 60 * 60 * 1000);
    });
};
