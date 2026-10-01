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
const msgBuffer = require('../lib/antiraid/msgBuffer');
const globalRequest = require('../lib/antiraid/globalRequest');

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
            // Global ban: Chamy'nin kendi raid karariyla (2+ sunucuda raid) listeye giren
            // hesap, korumasi acik her sunucuda girer girmez sormadan atilir.
            const globals = await configStore.globalBanSet();
            if (globals.has(member.id)) {
                const cfg = await configStore.get(member.guild.id);
                // Eski (elle eklenmis) kayitlar antiraid kapali olsa da banlanir;
                // otomatik girenler sadece antiraid'i acik sunucuda.
                if ((cfg.enabled || configStore.isManualGlobalBan(member.id)) &&
                    member.guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
                    await member.ban({ reason: '[Chamy Antiraid] Known raid account (global ban)' })
                        .catch(() => {});
                    console.warn(`[ANTIRAID] global-ban hit: ${member.id} in ${member.guild.id}`);
                    return;
                }
            }
            // Baska bir sunucunun admini bu hesap icin global ban istedi ve bu sunucuya
            // henuz sorulmadiysa: moderator kanalina "banlayalim mi" diye sor.
            globalRequest.onMemberJoin(member).catch(err =>
                console.error('[GLOBALBAN] join request:', err.message));
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
        // Son 10 mesaj (sadece bellekte): global ban isteginde moderatore gosterilir.
        try { msgBuffer.record(message); } catch { /* yut */ }
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
        // Trust sayaclarini dakikada bir Mongo'ya yaz.
        setInterval(() => trustCollector.flush(), 60_000);
        // Gunluk ton taramasi (saat kontrolu 10 dk'da bir).
        setInterval(maybeRunDaily, 10 * 60 * 1000);
    });
};
