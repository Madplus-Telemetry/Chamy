// lib/antiraid/msgBuffer.js
// Kullanici basina son 10 mesaj, SADECE bellekte (diske/DB'ye yazilmaz). Global ban
// isteginde moderatore "bu kisi burada ne yazmisti" gostermek icin. Chamy yeniden
// baslayinca bosalir; 3 gunden eski mesajlar gosterilmez; en fazla MAX_KEYS kullanici.

const MAX_KEYS = 8000;
const PER_USER = 10;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_CHARS = 200;

const buf = new Map(); // "guildId:userId" -> [{ channelId, at, text }]

function record(message) {
    if (!message.guild || !message.author || message.author.bot || message.webhookId) return;
    const text = (message.content || '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    const extra = message.attachments?.size ? ` [+${message.attachments.size} attachment(s)]` : '';
    if (!text && !extra) return;

    const key = `${message.guild.id}:${message.author.id}`;
    let arr = buf.get(key);
    if (arr) buf.delete(key); else arr = []; // en son konusan sona gecsin (LRU)
    arr.push({ channelId: message.channelId, at: message.createdTimestamp || Date.now(), text: text + extra });
    if (arr.length > PER_USER) arr.shift();
    buf.set(key, arr);
    if (buf.size > MAX_KEYS) buf.delete(buf.keys().next().value);
}

function last(guildId, userId, n = PER_USER) {
    const arr = buf.get(`${guildId}:${userId}`) || [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return arr.filter(m => m.at >= cutoff).slice(-n);
}

module.exports = { record, last };
