// events/sessionLookup.js
// ───────────────────────────────────────────────────────────────────────────
// Mad+ session code lookup. Bir moderator sohbete kodu (ornek: 7K2Q-M4XA)
// yazinca Chamy lobby sunucusundan sorgular ve sonucu cevap olarak atar.
//
// Kod ODA/YARIS bazlidir (Mad+ > Profil > yaris gecmisi > yaris detayi);
// eski surucu bazli oturum kodlari da calisir.
//
// Env: MADPLUS_LOBBY_URL        (rating ile ayni)
//      MADPLUS_STEWARD_KEY      (lobby sunucusundaki steward anahtari)
//      SESSION_LOOKUP_CHANNEL_IDS (opsiyonel, virgullu; bos ise her kanalda)
// Yalnizca "Mesajlari Yonet" yetkisi olanlar tetikleyebilir. Kod, tireli
// XXXX-XXXX bicimde yazilmali (siradan 8 harflik kelimelerle karismasin diye).
// ───────────────────────────────────────────────────────────────────────────

const { EmbedBuilder, AttachmentBuilder, PermissionsBitField } = require('discord.js');

const CODE_RE = /^([0-9A-Za-z]{4})-([0-9A-Za-z]{4})$/;
const COOLDOWN_MS = 3000;
const lastUse = new Map();

function lobby() {
    const base = (process.env.MADPLUS_LOBBY_URL || '').trim()
        .replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/+$/, '');
    const key = (process.env.MADPLUS_STEWARD_KEY || '').trim();
    return base && key ? { base, key } : null;
}

function allowedChannel(channelId) {
    const list = String(process.env.SESSION_LOOKUP_CHANNEL_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    return list.length === 0 || list.includes(channelId);
}

function raceEmbed(code, race) {
    const results = Array.isArray(race.results) ? race.results : [];
    const lines = results.slice(0, 40).map((r, i) => {
        const pos = r.dnf ? 'DNF' : `P${r.place ?? i + 1}`;
        const id = r.id && /^\d{15,21}$/.test(String(r.id)) ? ` (<@${r.id}>)` : '';
        return `\`${pos.padEnd(4)}\` ${r.name || 'Driver'}${id}`;
    });
    const embed = new EmbedBuilder()
        .setColor(0xE10600)
        .setTitle(`🏁 Session ${code}`)
        .addFields(
            { name: 'Track', value: String(race.track || 'unknown'), inline: true },
            { name: 'Date', value: race.at ? `<t:${Math.floor(Number(race.at) / 1000)}:f>` : 'unknown', inline: true },
            { name: 'Race ID', value: `\`${race.raceId || '?'}\``, inline: false },
        )
        .setDescription(lines.length ? lines.join('\n').slice(0, 3900) : 'No standings stored for this race.');
    return embed;
}

async function lookup(l, code) {
    const res = await fetch(`${l.base}/v1/admin/session?code=${encodeURIComponent(code)}`, {
        headers: { 'X-MadPlus-Steward-Key': l.key },
        signal: AbortSignal.timeout(25_000),
    });
    const text = await res.text();
    if (!res.ok) {
        let msg = text;
        try { msg = JSON.parse(text).error || text; } catch { /* plain */ }
        const err = new Error(String(msg).slice(0, 200));
        err.status = res.status;
        throw err;
    }
    return text;
}

module.exports = (client) => {
    client.on('messageCreate', async (message) => {
        try {
            if (message.author.bot || !message.guild) return;
            const m = CODE_RE.exec(message.content.trim());
            if (!m) return;
            if (!allowedChannel(message.channelId)) return;
            if (!message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages)) return;

            const l = lobby();
            if (!l) {
                console.log('[SESSION LOOKUP] Disabled (MADPLUS_LOBBY_URL / MADPLUS_STEWARD_KEY missing).');
                return;
            }

            const now = Date.now();
            if (now - (lastUse.get(message.author.id) || 0) < COOLDOWN_MS) return;
            lastUse.set(message.author.id, now);

            const code = `${m[1]}-${m[2]}`.toUpperCase();
            await message.channel.sendTyping().catch(() => {});

            let raw;
            try {
                raw = await lookup(l, code);
            } catch (err) {
                const text = err.status === 403
                    ? '❌ Steward key rejected by the lobby server.'
                    : `❌ Lookup failed: ${err.message}`;
                return message.reply({ content: text, allowedMentions: { parse: [] } });
            }

            let data;
            try { data = JSON.parse(raw); } catch { data = null; }

            if (data && data.kind === 'race' && data.race) {
                return message.reply({
                    embeds: [raceEmbed(code, data.race)],
                    allowedMentions: { parse: [] },
                });
            }

            // Eski surucu bazli kod: ham sonucu dosya olarak ekle.
            const file = new AttachmentBuilder(Buffer.from(raw, 'utf8'), { name: `session-${code}.json` });
            return message.reply({
                content: `📄 Session \`${code}\` — stored lap traces attached.`,
                files: [file],
                allowedMentions: { parse: [] },
            });
        } catch (err) {
            console.error('[SESSION LOOKUP] failed:', err.message);
        }
    });
};
