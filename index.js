//--------------------------
// IMPORTS
//--------------------------

const {
    Client,
    GatewayIntentBits,
    Collection,
    PermissionsBitField,
    Partials
} = require('discord.js');

require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const http = require('http'); // Added for Passive Monitoring (Heartbeat)

//--------------------------
// ONE-SHOT AETHER MIGRATION
//--------------------------

function runPendingAetherMigration() {
    const payload = process.env.AETHER_MIGRATION_DB_GZIP_BASE64;
    if (!payload) return;

    const guildId = String(process.env.AETHER_MIGRATION_GUILD_ID || '').trim();
    if (!guildId) throw new Error('AETHER_MIGRATION_GUILD_ID is required when migration data is configured.');

    const sqlitePath = path.join(os.tmpdir(), 'chamy-aether-migration.db');
    try {
        const sqlite = zlib.gunzipSync(Buffer.from(payload, 'base64'));
        fs.writeFileSync(sqlitePath, sqlite, { mode: 0o600 });
        console.log(`[AETHER MIGRATION] Starting one-shot import for guild ${guildId}.`);

        const result = spawnSync(process.execPath, [
            path.join(__dirname, 'services', 'aether', 'migrate.js'),
            '--apply', '--sqlite', sqlitePath, '--guild-id', guildId
        ], { env: process.env, stdio: 'inherit' });

        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`Aether migration exited with status ${result.status}.`);
        console.log('[AETHER MIGRATION] One-shot import completed.');
    } finally {
        fs.rmSync(sqlitePath, { force: true });
    }
}

runPendingAetherMigration();

//--------------------------
// MONGO CONNECT
//--------------------------

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("🟢 MongoDB connected successfully"))
    .catch(err => console.error("MongoDB connection error:", err));

//--------------------------
// MODELS
//--------------------------

const Driver = require('./models/Driver');
const DriverRating = require('./models/DriverRating');
const DotyVote = require('./models/DotyVote');
const SeasonVote = require('./models/SeasonVote');
const Maintenance = require('./models/Maintenance');
const PrefixConfig = require('./models/PrefixConfig');
const PendingRoleRestore = require('./models/PendingRoleRestore');
const { onStartup: teamRadioStartup } = require('./commands/teamradio');
const { checkExpiredInterviews }      = require('./commands/interview');
const perms                           = require('./lib/perms');
const cfg                             = require('./lib/guildConfig');
const { seedLegacyGuild, LEGACY_GUILD_ID } = require('./lib/legacySeed');

//--------------------------
// CLIENT
//--------------------------

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildScheduledEvents
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.User
    ]
});

//--------------------------
// GUILD ALLOWLIST (optional)
//--------------------------
// This was a hard whitelist: any guild not named in GUILD_ID_1..3 got
// "Access denied for this server", so the bot was unusable everywhere else no
// matter what else was configured. It is OPTIONAL now — an empty list means
// the bot works in every server it is invited to.
//
// Only ALLOWED_GUILDS restricts it. GUILD_ID_1..3 deliberately do NOT: they
// are still set on the deployment from the whitelist days, and falling back
// to them would keep the bot locked to those three servers — the exact thing
// this change is meant to remove.

const allowedGuilds = String(process.env.ALLOWED_GUILDS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

const guildAllowed = guildId => allowedGuilds.length === 0 || allowedGuilds.includes(guildId);

// Where the old code registered guild-scoped command copies. Used only to
// clear those once commands are global — otherwise each would show twice there.
const legacyCommandGuilds = [...new Set([
    process.env.GUILD_ID_1,
    process.env.GUILD_ID_2,
    process.env.GUILD_ID_3,
    process.env.LEGACY_GUILD_ID || '1446960659072946218'
].filter(Boolean))];

//--------------------------
// COMMAND LOAD
//--------------------------

client.commands = new Collection();

const commandsPath = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
    const command = require(`./commands/${file}`);
    client.commands.set(command.data.name, command);
}

//--------------------------
// EVENT LOAD
//--------------------------

const eventsPath = path.join(__dirname, 'events');

if (fs.existsSync(eventsPath)) {
    for (const file of fs.readdirSync(eventsPath).filter(f => f.endsWith('.js'))) {
        const event = require(`./events/${file}`);
        event(client);
        console.log(`📂 Event loaded: ${file}`);
    }
}

//--------------------------
// COMMAND HASH HELPER
//--------------------------

function hashCommand(cmd) {
    try {
        return JSON.stringify(cmd.data.toJSON());
    } catch {
        return String(cmd.data.name);
    }
}

//--------------------------
// READY
//--------------------------

client.once('ready', async () => {

    console.log(`[ONLINE] ${client.user.tag}`);

    // TeamRadio restart-safe scheduler
    await teamRadioStartup(client);

    // Startup migration: DriverRating eksik olan Driver kayıtlarını düzelt
    try {
        const allDrivers = await Driver.find({}).lean();
        const allRatings = await DriverRating.find({}, { userId: 1 }).lean();
        const ratingSet = new Set(allRatings.map(r => r.userId));
        const missing = allDrivers.filter(d => !ratingSet.has(d.userId));
        if (missing.length > 0) {
            console.log(`[MIGRATION] ${missing.length} driver için DriverRating eksik, oluşturuluyor...`);
            for (const d of missing) {
                await DriverRating.create({ userId: d.userId, username: d.username || '' });
                console.log(`[MIGRATION] ✅ ${d.userId} (${d.username || 'username yok'})`);
            }
            console.log('[MIGRATION] ✅ Tamamlandı.');
        } else {
            console.log('[MIGRATION] ✅ Tüm driverların DriverRating kaydı mevcut.');
        }
    } catch (err) {
        console.error('[MIGRATION] ❌ Hata:', err.message);
    }

    // One-time: write the OM server's historical ids into its own config, so
    // that moving those constants out of the source changes nothing there.
    await seedLegacyGuild();

    try {
        // Commands are GLOBAL now, EXCEPT ones flagged homeOnly (see e.g.
        // commands/mcturn.js) — those only ever work in OM's own server, so
        // they are registered there alone. Otherwise every server's command
        // picker would list /mcturn and /teamradio for no reason.
        const globalCommands   = [];
        const homeOnlyCommands = [];
        for (const cmd of client.commands.values()) {
            (cmd.homeOnly ? homeOnlyCommands : globalCommands).push(cmd.data.toJSON());
        }

        // Global first, THEN clear the old guild-scoped copies. The other way
        // round leaves the home server with no commands at all until the global
        // set propagates; this order's worst case is a moment of duplicates.
        await client.application.commands.set(globalCommands);
        console.log(`✅ ${globalCommands.length} command(s) registered globally`);

        if (homeOnlyCommands.length && LEGACY_GUILD_ID) {
            await client.application.commands.set(homeOnlyCommands, LEGACY_GUILD_ID);
            console.log(`🏠 ${homeOnlyCommands.length} home-only command(s) registered to ${LEGACY_GUILD_ID}`);
        }

        for (const guildId of legacyCommandGuilds) {
            // Never wipe the guild we just registered home-only commands to.
            if (guildId === LEGACY_GUILD_ID && homeOnlyCommands.length) continue;
            await client.application.commands.set([], guildId).catch(() => {});
        }

        //--------------------------
        // MAINTENANCE SNAPSHOT CHECK
        //--------------------------

        try {
            const state = await Maintenance.findById('singleton');

            if (state && state.active && state.snapshot) {

                const newLocked = [];

                for (const [name, cmd] of client.commands) {
                    const oldHash = state.snapshot instanceof Map ? state.snapshot.get(name) : state.snapshot[name];
                    const newHash = hashCommand(cmd);

                    if (!oldHash) {
                        newLocked.push(name);
                        console.log(`🔧 [MAINTENANCE] New command detected: /${name}`);
                    }
                    else if (oldHash !== newHash) {
                        newLocked.push(name);
                        console.log(`🔧 [MAINTENANCE] Modified command detected: /${name}`);
                    }
                }

                if (newLocked.length > 0) {
                    state.lockedCommands = newLocked;
                    await state.save();
                    console.log(`🔧 [MAINTENANCE] Locked commands: ${newLocked.join(', ')}`);
                } else {
                    console.log(`🔧 [MAINTENANCE] Mode is active but no command changes detected.`);
                }
            }
        } catch (err) {
            console.error('[MAINTENANCE] Snapshot check error:', err);
        }

    } catch (err) {
        console.error("Setup error:", err);
    }

    //--------------------------
    // BYPASS ROLE RESTORE LOOP
    // Polls DB every 30s for bypass mute jobs whose timeout has expired,
    // re-grants the stripped roles. Survives Railway restarts — unlike setTimeout.
    //--------------------------

    setInterval(async () => {
        try {
            const jobs = await PendingRoleRestore.find({ restoreAt: { $lte: new Date() } });
            for (const job of jobs) {
                try {
                    const guild = client.guilds.cache.get(job.guildId);
                    if (!guild) { await PendingRoleRestore.deleteOne({ _id: job._id }); continue; }
                    const member = await guild.members.fetch(job.userId).catch(() => null);
                    if (member) {
                        await member.roles.add(job.roleIds, 'Privilege bypass: role restore after mute expiry');
                        console.log(`[BYPASS RESTORE] ✅ Restored roles for ${job.userId} in ${job.guildId}`);
                    }
                    await PendingRoleRestore.deleteOne({ _id: job._id });
                } catch (err) {
                    console.error('[BYPASS RESTORE]', err.message);
                }
            }
        } catch (err) {
            console.error('[BYPASS RESTORE LOOP]', err.message);
        }
    }, 30_000);

    //--------------------------
    // DOTY AUTO END LOOP
    //--------------------------

    setInterval(async () => {
        try {
            const votes = await DotyVote.find({
                finished: false,
                endTime: { $lte: Date.now() }
            });

            for (const vote of votes) {
                try {
                    const channel = await client.channels.fetch(vote.channelId).catch(() => null);
                    if (!channel) continue;

                    const message = await channel.messages.fetch(vote.messageId).catch(() => null);

                    let max = 0;
                    for (const v of vote.votes.values()) {
                        if (v > max) max = v;
                    }

                    const winners = [];
                    for (const [id, v] of vote.votes) {
                        if (v === max && max > 0) {
                            winners.push(id);
                        }
                    }

                    if (winners.length === 0) {
                        if (message) await message.reply('❌ No votes recorded.');
                    } else if (winners.length > 1) {
                        if (message) {
                            await message.reply(
                                `🤝 **It's a Tie!**\n${winners.map(id => `<@${id}>`).join('\n')} (${max} votes each)`
                            );
                        }
                    } else {
                        const winner = winners[0];
                        await Driver.findOneAndUpdate(
                            { userId: winner },
                            { $inc: { doty: 1 } },
                            { upsert: true }
                        );

                        if (message) {
                            await message.reply(
                                `🏆 **Driver of the Day:** <@${winner}> with **${max}** votes!`
                            );
                        }
                    }

                    if (message) {
                        await message.edit({ components: [] }).catch(() => {});
                    }

                    vote.finished = true;
                    await vote.save();

                } catch (err) {
                    console.error('VOTE END ERROR:', err);
                }
            }
        } catch (err) {
            console.error('AUTO LOOP ERROR:', err);
        }
    }, 15000);

    //--------------------------
    // INTERVIEW TIMEOUT LOOP
    //--------------------------

    setInterval(() => checkExpiredInterviews(client), 60_000);

    //--------------------------
    // DOTS / TOTS AUTO END LOOP
    //--------------------------

    setInterval(async () => {
        try {
            const seasonVotes = await SeasonVote.find({
                finished: false,
                endTime: { $lte: Date.now() }
            });

            for (const vote of seasonVotes) {
                try {
                    const channel = await client.channels.fetch(vote.channelId).catch(() => null);
                    if (!channel) continue;

                    const message = await channel.messages.fetch(vote.messageId).catch(() => null);

                    let max = 0;
                    for (const v of vote.votes.values()) {
                        if (v > max) max = v;
                    }

                    const winners = [];
                    for (const [key, v] of vote.votes) {
                        if (v === max && max > 0) winners.push(key);
                    }

                    const { EmbedBuilder } = require('discord.js');

                    const makeSeasonBar = (count, total) => {
                        const pct = total === 0 ? 0 : count / total;
                        const filled = Math.round(pct * 12);
                        return '█'.repeat(filled) + '░'.repeat(12 - filled);
                    };

                    const total = vote.participants.reduce((s, p) => s + (vote.votes.get(p) || 0), 0);
                    const isDots = vote.type === 'dots';
                    const typeLabel = isDots ? 'DRIVER OF THE SEASON' : 'TEAM OF THE SEASON';

                    const resultLines = [...vote.participants]
                        .sort((a, b) => (vote.votes.get(b) || 0) - (vote.votes.get(a) || 0))
                        .map(p => {
                            const v = vote.votes.get(p) || 0;
                            const pct = total === 0 ? 0 : Math.round((v / total) * 100);
                            const label = isDots ? `<@${p}>` : `**${p}**`;
                            return `${label}\n\`${makeSeasonBar(v, total)}\` **${v}** votes (${pct}%)`;
                        })
                        .join('\n\n');

                    let winnerText;
                    if (winners.length === 0) {
                        winnerText = '❌ No votes were cast.';
                    } else if (winners.length > 1) {
                        const wLabels = winners.map(w => isDots ? `<@${w}>` : `**${w}**`).join(' & ');
                        winnerText = `🤝 TIE: ${wLabels}`;
                    } else {
                        const wLabel = isDots ? `<@${winners[0]}>` : `**${winners[0]}**`;
                        winnerText = `🏆 WINNER: ${wLabel}`;
                    }

                    const resultEmbed = new EmbedBuilder()
                        .setTitle(`🏆 ${typeLabel} — RESULTS`)
                        .setColor(0xFFD700)
                        .setDescription(`**${winnerText}**\n\n${resultLines}`)
                        .setFooter({ text: `Total votes: ${total} • Voting ended` });

                    if (message) {
                        await message.edit({ embeds: [resultEmbed], components: [] }).catch(() => {});
                    }

                    vote.finished = true;
                    await vote.save();

                } catch (err) {
                    console.error('[SEASON VOTE END ERROR]', err);
                }
            }
        } catch (err) {
            console.error('[SEASON VOTE LOOP ERROR]', err);
        }
    }, 15000);

});

//--------------------------
// INTERACTION HANDLER
//--------------------------

client.on('interactionCreate', async interaction => {

    if (interaction.isChatInputCommand()) {

        if (!guildAllowed(interaction.guildId)) {
            return interaction.reply({ content: '❌ Access denied for this server.', ephemeral: true });
        }

        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        // Sunucuya sadece komut entegrasyonu eklenmiş, bot kullanıcısı girmemiş
        // (davet linkinde "bot" scope'u yok / profildeki "Add App" butonu). Discord
        // komutları yine yollar ama interaction.guild null olur — eskiden burada
        // "Cannot read properties of null (reading 'members')" ile patlıyordu.
        if (interaction.guildId && !interaction.guild) {
            console.warn(`[NO BOT USER] /${interaction.commandName} in guild ${interaction.guildId} — commands installed but Chamy is not a member`);
            return interaction.reply({
                content: [
                    `⚠️ **Only my commands were added to this server — I'm not actually in it.**`,
                    `An admin needs to add me with the full invite (it includes the *bot* permission):`,
                    `https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8836764281600832&integration_type=0&scope=applications.commands+bot`,
                ].join('\n'),
                ephemeral: true,
            }).catch(() => {});
        }

        try {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const isCommander = perms.isOwner(interaction.user.id);
            // The co-owner role belongs to a server, not to the bot. A guild
            // that never configured one simply has no co-owner tier, instead of
            // borrowing a role id that means nothing outside OM.
            const coOwnerRoleId = await cfg.get(interaction.guildId, 'staff:coOwnerRole');
            const isCoOwner = !!coOwnerRoleId && member.roles.cache.has(coOwnerRoleId);
            const hasFullPower = isCommander || isCoOwner;
            const isStaff = member.permissions.has(PermissionsBitField.Flags.ManageMessages);

            //--------------------------
            // MAINTENANCE & ABSOLUTE LOCKDOWN
            //--------------------------

            if (interaction.commandName !== 'maintenance') {
                try {
                    const state = await Maintenance.findById('singleton');
                    const isMaintenanceActive = state?.active;
                    const isCommandLocked = state?.lockedCommands?.includes(interaction.commandName);

                    // Sadece lockedCommands listesindeki komutları engelle.
                    // isMaintenanceActive tek başına yeterli değil — bakım açık olsa bile
                    // değişmeyen komutlar normal çalışmaya devam etmeli.
                    if (isCommandLocked) {
                        
                        // ABSOLUTE LOCKDOWN: Only the bot creator (Gofret) can bypass this.
                        if (!isCommander) {
                            return interaction.reply({
                                content: [
                                    `🔒 **COMMAND LOCKED**`,
                                    ``,
                                    `**Gofret (the coder)** is currently cooking some wafers in the backend 🧇`,
                                    `*This command is strictly restricted to Developer override only.*`,
                                    ``,
                                    `Please wait until the system is back online.`
                                ].join('\n'),
                                ephemeral: true
                            });
                        }
                    }
                } catch (err) {
                    console.error('[MAINTENANCE] Check error:', err);
                }
            }

            // Moderation Command Protection
            const modCommands = new Set(['mute', 'timeout', 'ban', 'kick']);

            if (modCommands.has(interaction.commandName)) {
                const target = interaction.options.getMember('target') || interaction.options.getMember('user');

                if (target) {
                    if (target.roles.highest.position >= interaction.guild.members.me.roles.highest.position) {
                        return interaction.reply({
                            content: '❌ I cannot perform actions on this user due to role hierarchy.',
                            ephemeral: true
                        });
                    }

                    const targetIsStaff = target.permissions.has(PermissionsBitField.Flags.ManageMessages);

                    if (targetIsStaff && !hasFullPower) {
                        return interaction.reply({
                            content: '❌ Only VIPs (Commander/Co-Owner) can perform actions on staff members!',
                            ephemeral: true
                        });
                    }
                }
            }

            await command.execute(interaction);

        } catch (err) {
            console.error(`[EXECUTION ERROR] ${interaction.commandName}:`, err);

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: '❌ An unexpected error occurred while executing the command.', ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ content: '❌ An unexpected error occurred while executing the command.', ephemeral: true }).catch(() => {});
            }
        }
    }

    //--------------------------
    // DOTY BUTTON SYSTEM
    //--------------------------

    else if (interaction.isButton() && interaction.customId.startsWith('doty_')) {

        try {
            const votedUserId = interaction.customId.split('_')[1];

            const vote = await DotyVote.findOne({
                messageId: interaction.message.id,
                finished: false
            });

            if (!vote) {
                return interaction.reply({ content: '❌ Active voting session not found.', ephemeral: true });
            }

            if (Date.now() > vote.endTime) {
                return interaction.reply({ content: '❌ Voting session has ended.', ephemeral: true });
            }

            if (!vote.participants.includes(votedUserId)) {
                return interaction.reply({ content: '❌ Invalid candidate selection.', ephemeral: true });
            }

            if (vote.voters.includes(interaction.user.id)) {
                return interaction.reply({ content: '❌ You have already cast your vote.', ephemeral: true });
            }

            if (!vote.votes.has(votedUserId)) {
                vote.votes.set(votedUserId, 0);
            }

            vote.votes.set(votedUserId, vote.votes.get(votedUserId) + 1);
            vote.voters.push(interaction.user.id);

            await vote.save();

            await interaction.reply({ content: '✅ Your vote has been successfully recorded!', ephemeral: true });

        } catch (err) {
            console.error('VOTING BUTTON ERROR:', err);
        }
    }

    //--------------------------
    // DOTS BUTTON SYSTEM
    //--------------------------

    else if (interaction.isButton() && interaction.customId.startsWith('dots_')) {
        try {
            const votedId = interaction.customId.replace('dots_', '');

            const vote = await SeasonVote.findOne({
                messageId: interaction.message.id,
                type: 'dots',
                finished: false
            });

            if (!vote) return interaction.reply({ content: '❌ Active DOTS session not found.', ephemeral: true });
            if (Date.now() > vote.endTime) return interaction.reply({ content: '❌ Voting has ended.', ephemeral: true });
            if (!vote.participants.includes(votedId)) return interaction.reply({ content: '❌ Invalid candidate.', ephemeral: true });
            if (vote.voters.includes(interaction.user.id)) return interaction.reply({ content: '❌ You already voted!', ephemeral: true });

            vote.votes.set(votedId, (vote.votes.get(votedId) || 0) + 1);
            vote.voters.push(interaction.user.id);
            await vote.save();

            await interaction.reply({ content: `✅ Vote recorded for <@${votedId}>!`, ephemeral: true });

        } catch (err) {
            console.error('[DOTS BUTTON ERROR]', err);
        }
    }

    //--------------------------
    // TOTS BUTTON SYSTEM
    //--------------------------

    else if (interaction.isButton() && interaction.customId.startsWith('tots_')) {
        try {
            const safeKey = interaction.customId.replace('tots_', '');

            const vote = await SeasonVote.findOne({
                messageId: interaction.message.id,
                type: 'tots',
                finished: false
            });

            if (!vote) return interaction.reply({ content: '❌ Active TOTS session not found.', ephemeral: true });
            if (Date.now() > vote.endTime) return interaction.reply({ content: '❌ Voting has ended.', ephemeral: true });
            if (vote.voters.includes(interaction.user.id)) return interaction.reply({ content: '❌ You already voted!', ephemeral: true });

            // safeId eşleşmesini bul
            const matched = vote.participants.find(name =>
                name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40) === safeKey
            );

            if (!matched) return interaction.reply({ content: '❌ Invalid team selection.', ephemeral: true });

            vote.votes.set(matched, (vote.votes.get(matched) || 0) + 1);
            vote.voters.push(interaction.user.id);
            await vote.save();

            await interaction.reply({ content: `✅ Vote recorded for **${matched}**!`, ephemeral: true });

        } catch (err) {
            console.error('[TOTS BUTTON ERROR]', err);
        }
    }

    //--------------------------
    // TEAMRADIO BUTTON SYSTEM
    //--------------------------

    else if (interaction.isButton() && interaction.customId.startsWith('radio_')) {
        const command = client.commands.get('teamradio');
        if (command && command.buttonHandler) {
            await command.buttonHandler(interaction);
        }
    }

    //--------------------------
    // VERIFY BUTTON SYSTEM
    //--------------------------

    else if (interaction.isButton() && /^verify_(claim|new|code)_/.test(interaction.customId)) {
        const command = client.commands.get('verify');
        if (command && command.buttonHandler) {
            await command.buttonHandler(interaction);
        }
    }

    //--------------------------
    // VERIFY CAPTCHA MODAL
    //--------------------------

    else if (interaction.isModalSubmit() && interaction.customId.startsWith('verify_modal_')) {
        const command = client.commands.get('verify');
        if (command && command.modalHandler) {
            await command.modalHandler(interaction);
        }
    }

    //--------------------------
    // INTERVIEW BUTTON SYSTEM
    //--------------------------

    else if (interaction.isButton() && interaction.customId.startsWith('interview_start_')) {
        const command = client.commands.get('interview');
        if (command && command.buttonHandler) {
            await command.buttonHandler(interaction);
        }
    }

    //--------------------------
    // INTERVIEW MODAL SUBMIT
    //--------------------------

    else if (interaction.isModalSubmit() && interaction.customId.startsWith('interview_modal_')) {
        const command = client.commands.get('interview');
        if (command && command.modalHandler) {
            await command.modalHandler(interaction);
        }
    }
});

//--------------------------
// PASSIVE MONITORING (HEARTBEAT)
//--------------------------
// This server keeps Railway active and allows external monitoring tools 
// (like UptimeRobot) to ping the bot and trigger webhooks if it crashes.

http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.write('Gofret System is Online and cooking 🧇');
    res.end();
}).listen(process.env.PORT || 3000, () => {
    console.log(`📡 Heartbeat server listening on port ${process.env.PORT || 3000}`);
});


//--------------------------
// PREFIX CACHE
//--------------------------

const prefixCache = new Map();
const DEFAULT_PREFIX = 'om!';

async function getPrefix(guildId) {
    if (prefixCache.has(guildId)) return prefixCache.get(guildId);
    const config = await PrefixConfig.findOne({ guildId }).catch(() => null);
    const prefix = config?.prefix || DEFAULT_PREFIX;
    prefixCache.set(guildId, prefix);
    return prefix;
}

client.on('prefixUpdate', (guildId) => {
    prefixCache.delete(guildId);
});

// Sunucuya girdi/çıktı — "bot gelmedi" gibi sorunlar loglarda görünsün.
client.on('guildCreate', guild => {
    console.log(`[GUILD] ➕ Joined "${guild.name}" (${guild.id}) — ${guild.memberCount} members`);
});
client.on('guildDelete', guild => {
    console.log(`[GUILD] ➖ Left/removed from "${guild.name || 'unknown'}" (${guild.id})`);
});

//--------------------------
// PREFIX COMMAND HANDLER
//--------------------------

client.on('messageCreate', async message => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!guildAllowed(message.guildId)) return;

    const prefix = await getPrefix(message.guildId);
    if (!message.content.toLowerCase().startsWith(prefix.toLowerCase())) return;

    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();

    // ── Ping ───────────────────────────────────────────────────────────────
    if (commandName === 'ping') {
        const latency = Date.now() - message.createdTimestamp;
        return message.reply(`🏓 Pong! \`${latency}ms\` | API: \`${message.client.ws.ping}ms\``);
    }

    // ── Prefix info ────────────────────────────────────────────────────────
    if (commandName === 'prefix') {
        return message.reply(`📌 Current prefix: \`${prefix}\`\nChange it with \`/setprefix\``);
    }

    // ── Help ───────────────────────────────────────────────────────────────
    if (commandName === 'help') {
        return message.reply(
            `**OM-Bot Prefix Commands** (prefix: \`${prefix}\`)\n\n` +
            `**General**\n` +
            `\`${prefix}ping\` — Latency check\n` +
            `\`${prefix}prefix\` — Show current prefix\n\n` +
            `**Moderation** *(staff only)*\n` +
            `\`${prefix}ban @user [reason]\` — Ban a member\n` +
            `\`${prefix}unban <id>\` — Unban by user ID\n` +
            `\`${prefix}kick @user\` — Kick a member\n` +
            `\`${prefix}mute @user <10m/1h/1d> [reason]\` — Timeout a member\n` +
            `\`${prefix}unmute @user\` — Remove timeout\n` +
            `\`${prefix}to @user\` — Quick 10-minute timeout\n` +
            `\`${prefix}unto @user\` — Remove quick timeout\n` +
            `\`${prefix}warn @user <reason>\` — Issue a warning\n` +
            `\`${prefix}warnings @user\` — View warnings\n` +
            `\`${prefix}clearwarnings @user\` — Clear all warnings\n` +
            `\`${prefix}nick @user <new name>\` — Change nickname\n` +
            `\`${prefix}dm @user <message>\` — Send DM via bot\n` +
            `\`${prefix}report @user <reason>\` — Report a user\n` +
            `\`${prefix}lockchannel\` — Lock current channel\n` +
            `\`${prefix}unlockchannel\` — Unlock current channel\n` +
            `\`${prefix}slowmode <seconds>\` — Set slowmode\n\n` +
            `**Role Management** *(admin only)*\n` +
            `\`${prefix}addrole <n> [#color]\` — Create a role\n` +
            `\`${prefix}delrole @role\` — Delete a role\n` +
            `\`${prefix}editrole @role <new name>\` — Rename a role\n` +
            `\`${prefix}giverole @user @role\` — Assign role to member\n` +
            `\`${prefix}takerole @user @role\` — Remove role from member\n\n` +
            `*All other commands are slash commands. Type \`/\` to see them.*`
        );
    }

    // ── Moderasyon & rol komutları → her biri kendi dosyasında ────────────
    // Prefix komut adı → slash komut adı eşlemesi
    const prefixAliasMap = {
        'ban':           'ban',
        'unban':         'unban',
        'kick':          'kick',
        'mute':          'mute',
        'unmute':        'unmute',
        'to':            'to',
        'unto':          'unto',
        'warn':          'warn',
        'warnings':      'warnings',
        'clearwarnings': 'clear-warning',
        'nick':          'nick',
        'dm':            'dm',
        'report':        'report',
        'lockchannel':   'lockchannel',
        'unlockchannel': 'unlockchannel',
        'slowmode':      'slowmode',
        'purge':         'purge',
        'addrole':       'addrole',
        'delrole':       'delrole',
        'editrole':      'editrole',
        'giverole':      'give-role',
        'takerole':      'take-role',
    };

    const slashName = prefixAliasMap[commandName];
    if (slashName) {
        const cmd = client.commands.get(slashName);
        if (cmd?.prefix) {
            return cmd.prefix(message, args).catch(err => {
                console.error(`[PREFIX ERROR] ${commandName}:`, err);
                message.reply('❌ An error occurred while executing this command.').catch(() => {});
            });
        }
    }
});

//--------------------------
// LOGIN
//--------------------------

client.login(process.env.TOKEN);
