// lib/antiraid/globalRequest.js
// Admin kaynakli global ban: istegi acan sunucuda hesap aninda banlanir, hesabin uye
// oldugu diger sunuculara moderator kanalinda (antiraid alert kanali, yoksa sistem
// kanali) "Review & decide" butonlu istek gider. Review, hesabin o sunucudaki son 10
// mesajini gosteren gecici (ephemeral) bir popup acar: Ban / Not needed.
// Hesap sonradan bir sunucuya girerse o sunucuya o anda sorulur.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField,
} = require('discord.js');
const GlobalBanRequest = require('../../models/GlobalBanRequest');
const configStore = require('./configStore');
const msgBuffer = require('./msgBuffer');
const globalban = require('./globalban');
const perms = require('../perms');

const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PER_GUILD_HOURLY = 5;
const hits = new Map(); // guildId -> [timestamps]

function rateLimited(guildId) {
    const now = Date.now();
    const arr = (hits.get(guildId) || []).filter(t => now - t < 60 * 60 * 1000);
    if (arr.length >= PER_GUILD_HOURLY) { hits.set(guildId, arr); return true; }
    arr.push(now);
    hits.set(guildId, arr);
    return false;
}

function createdAtMs(id) {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
}

/** Baska sunucudan gelen serbest metni embed'e koymadan once sadelestir. */
function clean(s) {
    return String(s || '').replace(/[*_`~|>\\]/g, '').replace(/@/g, '@​').trim();
}

/** Istek mesajinin gonderilecegi kanal: alert kanali, yoksa sistem kanali. */
async function modChannel(guild) {
    const me = guild.members.me;
    if (!me) return null;
    const cfg = await configStore.get(guild.id);
    const candidates = [];
    if (cfg.alertChannelId) candidates.push(await guild.channels.fetch(cfg.alertChannelId).catch(() => null));
    candidates.push(guild.systemChannel);
    const need = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
    ];
    for (const ch of candidates) {
        if (ch?.isTextBased?.() && ch.permissionsFor(me)?.has(need)) return ch;
    }
    return null;
}

function requestEmbed(req, { joined = false, decision = null } = {}) {
    const created = Math.floor(createdAtMs(req.userId) / 1000);
    const embed = new EmbedBuilder()
        .setColor(decision ? (decision.status === 'banned' ? 0x2ecc71 : 0x95a5a6) : 0xE53935)
        .setTitle('🌐 Global ban request')
        .setDescription(
            `**${clean(req.fromGuildName) || 'Another server'}** banned <@${req.userId}> (\`${req.userId}\`) ` +
            `and asks the other Chamy servers to do the same.` +
            (joined ? '\n\n_This account just joined your server._' : ''))
        .addFields(
            { name: 'Reason', value: clean(req.reason).slice(0, 1000) || '—' },
            { name: 'Requested by', value: clean(req.requestedByName) || '—', inline: true },
            { name: 'Account created', value: `<t:${created}:R>`, inline: true },
        )
        .setTimestamp(req.createdAt);
    if (decision) {
        embed.addFields({
            name: 'Decision',
            value: decision.status === 'banned'
                ? `✅ Banned by <@${decision.by}>`
                : `➖ Not needed — marked by <@${decision.by}>`,
        });
    } else {
        embed.setFooter({ text: 'Nothing happens until a moderator with Ban Members decides.' });
    }
    return embed;
}

/** Review popup'inin icerigi: hesabin BU sunucudaki son 10 mesaji. */
function reviewEmbed(req, guild) {
    const msgs = msgBuffer.last(guild.id, req.userId, 10);
    const body = msgs.length
        ? msgs.map(m => `<t:${Math.floor(m.at / 1000)}:R> <#${m.channelId}>\n> ${m.text}`).join('\n')
        : '_Chamy has not seen any messages from this account in this server._\n' +
          '_(Messages are only kept in memory since Chamy last restarted, never saved.)_';
    return new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle(`Last messages from this account in ${clean(guild.name)}`)
        .setDescription(`<@${req.userId}> (\`${req.userId}\`)\n\n${body}`.slice(0, 4000))
        .setFooter({ text: `Requested by ${clean(req.fromGuildName)}: ${clean(req.reason).slice(0, 150)}` });
}

/** Bu sunucuya istek mesajini gonderir ve targets'a ekler. 'sent' | 'no-channel' | 'failed' */
async function postRequest(req, guild, joined = false) {
    const ch = await modChannel(guild);
    if (!ch) return 'no-channel';
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`gbreq_review_${req._id}`)
            .setLabel('Review & decide')
            .setEmoji('🔎')
            .setStyle(ButtonStyle.Primary),
    );
    let msg;
    try {
        msg = await ch.send({ embeds: [requestEmbed(req, { joined })], components: [row] });
    } catch (err) {
        console.warn(`[GLOBALBAN] request post failed in ${guild.id}: ${err.message}`);
        return 'failed';
    }
    await GlobalBanRequest.updateOne(
        { _id: req._id },
        { $push: { targets: { guildId: guild.id, channelId: ch.id, messageId: msg.id, status: 'pending' } } },
    );
    return 'sent';
}

/**
 * /antiraid globalban: kendi sunucuda hemen banla, diger sunuculara istek gonder.
 * Kullaniciya gosterilecek metni doner.
 */
async function issue(interaction, userId, reason) {
    const guild = interaction.guild;
    const client = interaction.client;
    const isOwner = perms.isOwner(interaction.user.id);

    if (userId === client.user.id || userId === interaction.user.id || perms.isOwner(userId)) {
        return '❌ I will not global-ban that account.';
    }
    if (guild.ownerId === userId) return '❌ That is the owner of this server.';
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (member?.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return '❌ That member is an administrator here. Remove their admin access first.';
    }
    if (!isOwner && rateLimited(guild.id)) {
        return `❌ Slow down: a server can send at most ${PER_GUILD_HOURLY} global ban requests per hour.`;
    }

    // 1) Kendi sunucuda aninda ban. Basarisizsa diger sunuculara istek gitmez.
    const ban = await globalban.banOne(guild, userId, `requested by ${interaction.user.username}: ${reason}`);
    if (!ban.ok) return `❌ I could not ban them here, so no request was sent: ${ban.why}`;

    // 2) Istegi kaydet, hesabin uye oldugu diger sunuculara sor.
    const req = await GlobalBanRequest.create({
        userId,
        reason,
        fromGuildId: guild.id,
        fromGuildName: guild.name,
        requestedBy: interaction.user.id,
        requestedByName: interaction.user.username,
        targets: [{ guildId: guild.id, status: 'banned', decidedBy: interaction.user.id, decidedAt: new Date() }],
        expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });

    const out = { sent: 0, noChannel: 0, failed: 0, notMember: 0 };
    for (const g of client.guilds.cache.values()) {
        if (g.id === guild.id) continue;
        const m = g.members.cache.get(userId) || await g.members.fetch(userId).catch(() => null);
        if (!m) { out.notMember++; continue; }
        const r = await postRequest(req, g);
        if (r === 'sent') out.sent++;
        else if (r === 'no-channel') out.noChannel++;
        else out.failed++;
    }

    const lines = [`✅ ${ban.already ? 'Already banned' : 'Banned'} \`${userId}\` in this server.`];
    lines.push(out.sent
        ? `📨 Asked **${out.sent}** other server(s) to ban them too. Their moderators decide.`
        : 'No other server has this account as a member right now.');
    if (out.noChannel) lines.push(`⚠️ ${out.noChannel} server(s) have no channel I can post in (they need \`/antiraid alertchannel\`).`);
    if (out.failed) lines.push(`⚠️ Could not post the request in ${out.failed} server(s).`);
    if (out.notMember) lines.push(`If they join one of the other ${out.notMember} server(s) within 30 days, its moderators get a request then.`);
    return lines.join('\n');
}

/** Hesap bir sunucuya girdi: acik bir istek varsa ve bu sunucuya sorulmadiysa simdi sor. */
async function onMemberJoin(member) {
    const req = await GlobalBanRequest.findOne({
        userId: member.id,
        expiresAt: { $gt: new Date() },
        'targets.guildId': { $ne: member.guild.id },
    });
    if (!req) return;
    await postRequest(req, member.guild, true);
}

module.exports = { issue, onMemberJoin, requestEmbed, reviewEmbed };
