// events/antiraid.js
// Discord olaylarini antiraid motoruna ve trust sistemine baglar. Hot path'ler:
//   - guildMemberAdd            -> join-raid penceresi (+ global ban)
//   - messageCreate             -> mesaj spami + trust etkilesim sayaci
//   - messageReactionAdd        -> trust etkilesim sayaci
//   - guildAuditLogEntryCreate  -> nuke (kanal/rol silme, toplu ban) + fail tespiti

const { AuditLogEvent, PermissionsBitField } = require('discord.js');
const engine = require('../lib/antiraid/engine');
const spam = require('../lib/antiraid/spam');
const configStore = require('../lib/antiraid/configStore');
const { takeSnapshot } = require('../lib/antiraid/snapshot');
const trustCollector = require('../lib/trust/collector');
const { runToneScan } = require('../lib/trust/toneScan');
const guards = require('../lib/antiraid/guards');
const lockdown = require('../lib/antiraid/lockdown');

// Nuke sayilan audit log aksiyonlari -> okunabilir etiket.
const DESTRUCTIVE = {
    [AuditLogEvent.ChannelDelete]: 'channel delete',
    [AuditLogEvent.RoleDelete]: 'role delete',
    [AuditLogEvent.ChannelCreate]: 'channel create', // nuke botlari spam kanal da acar
    [AuditLogEvent.MemberBanAdd]: 'ban',
    [AuditLogEvent.MemberKick]: 'kick',
    [AuditLogEvent.WebhookCreate]: 'webhook create',
};

// Ton taramasi her gun bu UTC saatinde (00 UTC = 03:00 Istanbul).
const TONE_SCAN_UTC_HOUR = 0;

module.exports = (client) => {
    // --- Join hot path + global ban ---
    client.on('guildMemberAdd', async (member) => {
        try {
            // Global ban: kesin raid hesabi her acik-korumali sunucuda aninda atilir.
            const globals = await configStore.globalBanSet();
            if (globals.has(member.id)) {
                const cfg = await configStore.get(member.guild.id);
                // Bot sahibinin elle ekledigi hesaplar antiraid kapali olsa da banlanir;
                // otomatik girenler sadece antiraid'i acik sunucuda.
                if ((cfg.enabled || configStore.isManualGlobalBan(member.id)) &&
                    member.guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
                    await member.ban({ reason: '[Chamy Antiraid] Known raid account (global ban)' })
                        .catch(() => {});
                    console.warn(`[ANTIRAID] global-ban hit: ${member.id} in ${member.guild.id}`);
                    return;
                }
            }
            await engine.onMemberJoin(member);
        } catch (err) {
            console.error('[ANTIRAID] guildMemberAdd:', err.message);
        }
    });

    // --- Mesaj: spam dedektoru + trust sayaci ---
    client.on('messageCreate', async (message) => {
        if (!message.guild) return;
        if (message.webhookId) {
            guards.onWebhookMessage(message).catch(err =>
                console.error('[ANTIRAID] webhook:', err.message));
            return;
        }
        spam.onMessage(message).catch(err =>
            console.error('[ANTIRAID] spam:', err.message));
        try {
            // Trust sadece korumasi acik sunucularda sayilir.
            const cfg = await configStore.get(message.guild.id);
            if (cfg.enabled) trustCollector.recordMessage(message);
        } catch { /* yut */ }
    });

    // --- Tepki: trust sayaci ---
    client.on('messageReactionAdd', async (reaction, user) => {
        try {
            const guild = reaction.message?.guild;
            if (!guild) return;
            const cfg = await configStore.get(guild.id);
            if (cfg.enabled) trustCollector.recordReaction(reaction, user);
        } catch { /* yut */ }
    });

    // --- Nuke hot path + izin suistimali ---
    // Audit log girisi, silme/ban gibi eylemlerin KIM tarafindan yapildigini verir.
    client.on('guildAuditLogEntryCreate', async (entry, guild) => {
        guards.onAuditEntry(entry, guild).catch(err =>
            console.error('[ANTIRAID] guards:', err.message));
        try {
            const kind = DESTRUCTIVE[entry.action];
            if (!kind) return;
            const actorId = entry.executorId;
            if (!actorId || actorId === client.user.id) return; // Chamy'nin kendi islemleri
            await engine.onDestructiveAction(guild, actorId, kind);
        } catch (err) {
            console.error('[ANTIRAID] auditLogEntryCreate:', err.message);
        }
    });

    // --- Periyodik isler ---
    async function snapshotEnabledGuilds() {
        for (const guild of client.guilds.cache.values()) {
            try {
                const cfg = await configStore.get(guild.id);
                if (cfg.enabled) await takeSnapshot(guild, 'auto');
            } catch { /* yut */ }
        }
    }

    let lastToneScanDay = null;
    let toneScanRunning = false;
    async function maybeRunDaily() {
        const now = new Date();
        const day = now.toISOString().slice(0, 10);
        if (now.getUTCHours() !== TONE_SCAN_UTC_HOUR || lastToneScanDay === day || toneScanRunning) return;
        lastToneScanDay = day;
        toneScanRunning = true;
        try {
            await trustCollector.trimDays();
            await runToneScan(client);
        } catch (err) {
            console.error('[TRUST] daily job failed:', err.message);
        } finally {
            toneScanRunning = false;
        }
    }

    client.once('ready', () => {
        // Raid sirasinda restart olduysa acik kalan kilitleri tekrar zamanla.
        lockdown.resume(client).catch(() => {});
        // Snapshot: acilistan 1 dk sonra, sonra saatte bir.
        setTimeout(snapshotEnabledGuilds, 60_000);
        setInterval(snapshotEnabledGuilds, 60 * 60 * 1000);
        // Bot sahibinin elle ekledigi global ban'lar: acilistan 45 sn sonra, sonra 6 saatte bir
        // Chamy'nin bulundugu butun sunuculara uygula (hesap sunucuda olmasa da ID ile banlanir).
        const sweepGlobalBans = async () => {
            try {
                const GlobalBan = require('../models/GlobalBan');
                const globalban = require('../lib/antiraid/globalban');
                const rows = await GlobalBan.find({ addedBy: { $ne: 'auto' } }).lean();
                for (const row of rows) {
                    const r = await globalban.banEverywhere(client, row.userId, row.reason);
                    if (r.banned) console.log(`[GLOBALBAN] ${row.userId}: banned in ${r.banned} server(s)`);
                }
            } catch (err) {
                console.error('[GLOBALBAN] sweep failed:', err.message);
            }
        };
        setTimeout(sweepGlobalBans, 45_000);
        setInterval(sweepGlobalBans, 6 * 60 * 60 * 1000);
        // Trust sayaclarini dakikada bir Mongo'ya yaz.
        setInterval(() => trustCollector.flush(), 60_000);
        // Gunluk ton taramasi (saat kontrolu 10 dk'da bir).
        setInterval(maybeRunDaily, 10 * 60 * 1000);
    });
};
