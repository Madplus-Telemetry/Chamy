// events/cheatReport.js
// ───────────────────────────────────────────────────────────────────────────
// Mad+ haftalik hile raporu. Her pazartesi (UTC 07:00 sonrasi) lobby sunucusundan
// "fiziksel olarak imkansiz tur" listesini ceker, her cizgili tur icin grafik uretir
// ve ONCE bir kisinin gozden gecirmesi icin inceleme kanalina atar. "Send to studio"
// butonuna sadece bot sahibi basabilir; basinca rapor e-postayla stüdyoya gider.
// (Gizlilik politikasi: her rapor gonderilmeden once bir kisi tarafindan gozden gecirilir.)
//
// Elle tetikleme (sadece sahip): om!cheatreport
//
// Env:
//   MADPLUS_LOBBY_URL, MADPLUS_STEWARD_KEY        (lobby sunucusu + steward anahtari)
//   CHEAT_REPORT_REVIEW_CHANNEL_ID                (inceleme kanali)
//   SMTP_HOST (ornek smtp.gmail.com), SMTP_PORT (465), SMTP_USER, SMTP_PASS (uygulama sifresi)
//   CHEAT_REPORT_TO (alici adres), CHEAT_REPORT_FROM (opsiyonel, varsayilan SMTP_USER)
// ───────────────────────────────────────────────────────────────────────────

const { EmbedBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { createCanvas } = require('@napi-rs/canvas');
const ResultCursor = require('../models/ResultCursor');
const perms = require('../lib/perms');

const CURSOR_ID = 'lobby:cheat-report-week';
const TICK_MS = 10 * 60 * 1000;
const SEND_BUTTON = 'cheatreport_send';
const MAX_CHARTS = 9; // + report.json = 10 dosya (Discord siniri)

const pending = new Map(); // inceleme mesaj id -> { report, images }
let running = false;

function lobby() {
    const base = (process.env.MADPLUS_LOBBY_URL || '').trim()
        .replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/+$/, '');
    const key = (process.env.MADPLUS_STEWARD_KEY || '').trim();
    return base && key ? { base, key } : null;
}

function mondayKey(date) {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = (d.getUTCDay() + 6) % 7; // pazartesi = 0
    d.setUTCDate(d.getUTCDate() - day);
    return d.toISOString().slice(0, 10);
}

function fmt(ms) {
    const m = Math.floor(ms / 60000);
    const s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
    return `${m}:${s}`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Iz ornegi: [distance, elapsed, x, y, z, speed, rpm, throttle, brake, gear, steering]
function chart(entry) {
    const samples = entry?.trace?.samples;
    if (!Array.isArray(samples) || samples.length < 10) return null;
    const W = 960, H = 420;
    const canvas = createCanvas(W, H);
    const g = canvas.getContext('2d');
    g.fillStyle = '#14161a';
    g.fillRect(0, 0, W, H);
    g.fillStyle = '#e8e8e8';
    g.font = 'bold 18px sans-serif';
    g.fillText(`${entry.driverName} - ${entry.trackId} - ${entry.carClass} - ${fmt(entry.lapTimeMs)}`, 16, 28);
    g.font = '13px sans-serif';
    g.fillStyle = '#9aa0a6';
    g.fillText(`Class median on this track: ${fmt(entry.referenceMedianMs)}`, 16, 48);

    // Sol: pist cizgisi (x,z)
    const xs = samples.map((s) => s[2]);
    const zs = samples.map((s) => s[4]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minZ = Math.min(...zs), maxZ = Math.max(...zs);
    const box = { x: 16, y: 64, w: 400, h: 340 };
    const scale = Math.min(box.w / (maxX - minX || 1), box.h / (maxZ - minZ || 1));
    const ox = box.x + (box.w - (maxX - minX) * scale) / 2;
    const oy = box.y + (box.h - (maxZ - minZ) * scale) / 2;
    g.strokeStyle = '#e10600';
    g.lineWidth = 3;
    g.beginPath();
    samples.forEach((s, i) => {
        const px = ox + (s[2] - minX) * scale;
        const py = oy + (s[4] - minZ) * scale;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    g.stroke();

    // Sag: hiz - mesafe
    const gx = 450, gy = 70, gw = 490, gh = 330;
    const speeds = samples.map((s) => s[5]);
    const maxSpeed = Math.max(...speeds, 1);
    g.strokeStyle = '#2d3036';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
        const y = gy + (gh * i) / 4;
        g.beginPath(); g.moveTo(gx, y); g.lineTo(gx + gw, y); g.stroke();
        g.fillStyle = '#9aa0a6';
        g.fillText(String(Math.round(maxSpeed * (1 - i / 4))), gx - 36, y + 4);
    }
    g.strokeStyle = '#4fc3f7';
    g.lineWidth = 2;
    g.beginPath();
    samples.forEach((s, i) => {
        const px = gx + s[0] * gw;
        const py = gy + gh - (s[5] / maxSpeed) * gh;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    });
    g.stroke();
    g.fillStyle = '#9aa0a6';
    g.fillText('Speed (km/h) over lap distance', gx, gy - 8);
    return canvas.toBuffer('image/png');
}

async function fetchReport(l) {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const res = await fetch(`${l.base}/v1/admin/cheat-report?since=${since}`, {
        headers: { 'X-MadPlus-Steward-Key': l.key },
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`lobby ${res.status}`);
    return res.json();
}

function buildImages(report) {
    const images = [];
    for (const [i, entry] of (report.entries || []).entries()) {
        if (images.length >= MAX_CHARTS) break;
        const png = chart(entry);
        if (png) images.push({ name: `lap-${i + 1}-${entry.trackId}.png`, buffer: png, entryIndex: i });
    }
    return images;
}

function summaryLines(report) {
    return (report.entries || []).slice(0, 25).map((e, i) =>
        `**${i + 1}.** ${e.driverName} (\`${e.accountId}\`) - ${e.trackId} / ${e.carClass} - ` +
        `**${fmt(e.lapTimeMs)}** vs median ${fmt(e.referenceMedianMs)}${e.trace ? '' : ' (time only)'}`,
    );
}

// autoSend=true (haftalik calisma): rapor dogrudan e-postayla gider, kanal (varsa) sadece bilgi kopyasi alir.
// autoSend=false (om!cheatreport): sadece onizleme + "Send to studio" butonu.
async function postForReview(client, autoSend, fallbackChannel) {
    const l = lobby();
    const channelId = (process.env.CHEAT_REPORT_REVIEW_CHANNEL_ID || '').trim();
    const channel = fallbackChannel
        || (channelId ? (client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null)) : null);
    if (!l || (!autoSend && !channel?.send)) {
        console.log('[CHEAT REPORT] Disabled (MADPLUS_LOBBY_URL / MADPLUS_STEWARD_KEY missing, or no channel for a manual run).');
        return false;
    }
    const report = await fetchReport(l);
    const images = buildImages(report);
    const count = (report.entries || []).length;
    let emailed = false;
    if (autoSend && count > 0) {
        await sendEmail(report, images);
        emailed = true;
        console.log(`[CHEAT REPORT] Emailed to studio automatically (${count} entries).`);
    }
    if (!channel?.send) return true;

    const embed = new EmbedBuilder()
        .setColor(count ? 0xE10600 : 0x2ecc71)
        .setTitle(emailed ? 'Weekly Mad+ cheat report - sent to the studio' : 'Mad+ cheat report - preview')
        .setDescription(count ? summaryLines(report).join('\n').slice(0, 3900) : 'No impossible laps this week.')
        .addFields(
            { name: 'Flagged laps', value: String(count), inline: true },
            { name: 'Modded (excluded)', value: String(report.moddedSkipped ?? 0), inline: true },
            { name: 'Cut-suspect (excluded)', value: String(report.cutSkipped ?? 0), inline: true },
        )
        .setFooter({ text: emailed ? 'Sent automatically.' : 'Only the bot owner can send this to the studio.' })
        .setTimestamp();

    const files = images.map((im) => new AttachmentBuilder(im.buffer, { name: im.name }));
    files.push(new AttachmentBuilder(Buffer.from(JSON.stringify(report, null, 2)), { name: 'report.json' }));
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(SEND_BUTTON).setLabel('Send to studio').setStyle(ButtonStyle.Danger).setDisabled(count === 0),
    );
    const msg = await channel.send({
        embeds: [embed],
        files,
        components: emailed ? [] : [row],
        allowedMentions: { parse: [] },
    });
    if (!emailed) pending.set(msg.id, { report, images });
    console.log(`[CHEAT REPORT] Posted to channel (${count} entries, emailed=${emailed}).`);
    return true;
}

async function sendEmail(report, images) {
    const nodemailer = require('nodemailer');
    const host = (process.env.SMTP_HOST || '').trim();
    const user = (process.env.SMTP_USER || '').trim();
    const pass = process.env.SMTP_PASS || '';
    const to = (process.env.CHEAT_REPORT_TO || '').trim();
    if (!host || !user || !pass || !to) throw new Error('SMTP_HOST / SMTP_USER / SMTP_PASS / CHEAT_REPORT_TO missing');
    const port = Number(process.env.SMTP_PORT || 465);
    const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });

    const rows = (report.entries || []).map((e) => `
        <tr>
          <td>${esc(e.driverName)}</td><td>${esc(e.accountId)}</td>
          <td>${esc(e.trackId)}</td><td>${esc(e.carClass)}</td>
          <td>${esc(fmt(e.lapTimeMs))}</td><td>${esc(fmt(e.referenceMedianMs))}</td>
          <td>${e.trace ? 'trace' : 'time only'}</td>
        </tr>`).join('');
    const html = `
        <p>Hello,</p>
        <p>This is the weekly Mad+ report of laps that look physically impossible compared with
        other drivers on the same track and car class. Modded sessions and possible corner-cut laps are excluded.
        Each entry was reviewed by a person on the Mad+ team before sending.</p>
        <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-family:sans-serif;font-size:13px">
          <tr><th>Driver</th><th>Account (Discord)</th><th>Track</th><th>Class</th><th>Lap</th><th>Class median</th><th>Data</th></tr>
          ${rows}
        </table>
        <p>Charts (track line and speed trace) and the raw data are attached.</p>
        <p>- Mad+ team</p>`;
    await transporter.sendMail({
        from: (process.env.CHEAT_REPORT_FROM || user).trim(),
        to,
        subject: `Mad+ weekly cheat report - ${new Date().toISOString().slice(0, 10)}`,
        html,
        attachments: [
            ...images.map((im) => ({ filename: im.name, content: im.buffer, contentType: 'image/png' })),
            { filename: 'report.json', content: JSON.stringify(report, null, 2), contentType: 'application/json' },
        ],
    });
}

async function weeklyTick(client) {
    if (running) return;
    const now = new Date();
    if (now.getUTCDay() !== 1 || now.getUTCHours() < 7) return;
    const week = mondayKey(now);
    running = true;
    try {
        const cursor = await ResultCursor.findOne({ channelId: CURSOR_ID }).lean();
        if (cursor?.lastMessageId === week) return;
        const ok = await postForReview(client, true, null);
        if (ok) {
            await ResultCursor.updateOne(
                { channelId: CURSOR_ID },
                { $set: { lastMessageId: week, scannedAt: new Date() } },
                { upsert: true },
            );
        }
    } catch (err) {
        console.error('[CHEAT REPORT] weekly tick failed:', err.message);
    } finally {
        running = false;
    }
}

module.exports = (client) => {
    const start = () => {
        setTimeout(() => weeklyTick(client), 60_000).unref?.();
        setInterval(() => weeklyTick(client), TICK_MS).unref?.();
    };
    if (client.isReady?.()) start();
    else client.once('ready', start);

    client.on('messageCreate', async (message) => {
        try {
            if (message.author.bot || !message.guild) return;
            if (message.content.trim().toLowerCase() !== 'om!cheatreport') return;
            if (!perms.isOwner(message.author.id)) return;
            await message.channel.sendTyping().catch(() => {});
            const ok = await postForReview(client, true, message.channel);
            if (!ok) await message.reply('Cheat report is not configured (see env vars).');
        } catch (err) {
            console.error('[CHEAT REPORT] manual run failed:', err.message);
            message.reply(`Report failed: ${err.message}`).catch(() => {});
        }
    });

    client.on('interactionCreate', async (interaction) => {
        try {
            if (!interaction.isButton() || interaction.customId !== SEND_BUTTON) return;
            if (!perms.isOwner(interaction.user.id)) {
                return interaction.reply({ content: 'Only the bot owner can send this report.', ephemeral: true });
            }
            const item = pending.get(interaction.message.id);
            if (!item) {
                return interaction.reply({
                    content: 'This report expired (the bot restarted). Run `om!cheatreport` again.',
                    ephemeral: true,
                });
            }
            await interaction.deferReply({ ephemeral: true });
            await sendEmail(item.report, item.images);
            pending.delete(interaction.message.id);
            await interaction.message.edit({ components: [] }).catch(() => {});
            await interaction.editReply('Report sent to the studio.');
            console.log('[CHEAT REPORT] Emailed to studio.');
        } catch (err) {
            console.error('[CHEAT REPORT] send failed:', err.message);
            if (interaction.deferred || interaction.replied) {
                interaction.editReply(`Send failed: ${err.message}`).catch(() => {});
            } else {
                interaction.reply({ content: `Send failed: ${err.message}`, ephemeral: true }).catch(() => {});
            }
        }
    });
};
