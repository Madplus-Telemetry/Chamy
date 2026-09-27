// events/m25History.js
// ───────────────────────────────────────────────────────────────────────────
// TEK SEFERLIK: M25'in ana sampiyonalarinin (F1, F2, WEC) BUTUN sezonlarindaki
// yaris sonuclarini rating'e yazar. Normal tarama kanal basina sadece son 60
// mesaji okur; bu is kanallarin tum gecmisine iner.
//
// • Kanallar: #results, #f2-results, #wec-results, #old-results ve
//   #past-f1-results / #past-f2-results forumlarinin butun basliklari.
//   Kupa / Road To / RNG / Gold Cup / F1 2020 sim ve saralama kanallari yok.
// • Yarida kesilmez: her mesajdan sonra ilerleme onetimejobs'a yazilir,
//   redeploy olursa kaldigi mesajdan devam eder. Kayit messageId ile upsert.
// • Forumlar eski sonuclarin tekrar paylasimi olabilir: ayni pist + ayni ilk
//   6 surucu sirasi zaten varsa ikinci kez eklenmez.
// • Kimlik: DriverAlias tablosu (identity.resolve).
// • Bitince rating bastan hesaplanir ve lobiye (app) yollanir.
// Isaret: onetimejobs { key: JOB_KEY }.
// ───────────────────────────────────────────────────────────────────────────

const mongoose     = require('mongoose');
const { ChannelType } = require('discord.js');
const RaceResult   = require('../models/RaceResult');
const ResultCursor = require('../models/ResultCursor');
const { norm }     = require('../services/rating/identity');

const JOB_KEY   = 'm25-history-v1';
const M25_GUILD = '1264284618727886858';
const GAP_MS    = 4000;   // Gemma istekleri arasi (429 gelirse gemma.js bekler)

// Sira onemli: once asil kanallar, en son forum arsivleri (tekrarlar elensin).
const CHANNELS = [
    { id: '1264656778025504868', label: 'F1 old-results' },
    { id: '1459634970258571545', label: 'F1 results' },
    { id: '1466521786601570396', label: 'F2 results' },
    { id: '1433883081676427375', label: 'WEC results' },
];
const FORUMS = [
    { id: '1464737553688039606', label: 'past-f1-results' },
    { id: '1464737634671919273', label: 'past-f2-results' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

const signature = (track, entries) =>
    `${norm(track)}|${entries.slice(0, 6).map(e => e.key).join(',')}`;

async function forumThreads(guild, forumId) {
    const forum = await guild.channels.fetch(forumId).catch(() => null);
    if (!forum || forum.type !== ChannelType.GuildForum) return [];
    const out = new Map();
    const active = await forum.threads.fetchActive().catch(() => null);
    for (const [, t] of active?.threads || []) if (t.parentId === forumId) out.set(t.id, t);
    let before;
    for (let page = 0; page < 20; page++) {
        const arch = await forum.threads.fetchArchived({ limit: 100, before }).catch(() => null);
        if (!arch?.threads?.size) break;
        for (const [, t] of arch.threads) out.set(t.id, t);
        if (!arch.hasMore) break;
        before = [...arch.threads.values()].at(-1);
    }
    // Eski basliklar once
    return [...out.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function run(client) {
    const jobs = mongoose.connection.collection('onetimejobs');
    const state = (await jobs.findOne({ key: JOB_KEY })) || { key: JOB_KEY, progress: {} };
    if (state.doneAt) return;
    state.progress ||= {};

    const guild = client.guilds.cache.get(M25_GUILD) || await client.guilds.fetch(M25_GUILD).catch(() => null);
    if (!guild) { console.error('[M25-HISTORY] guild not found'); return; }

    const ingest = require('../services/rating/ingest');
    const { loadAliases } = require('../services/rating/identity');
    const index   = await ingest.memberIndex(guild);
    const aliases = await loadAliases(guild.id);

    const existing = await RaceResult.find({ guildId: M25_GUILD }, { track: 1, entries: 1 }).lean();
    const sigs = new Set(existing.map(r => signature(r.track, r.entries || [])));

    const saveProgress = (id, patch) => {
        state.progress[id] = { ...(state.progress[id] || {}), ...patch };
        return jobs.updateOne({ key: JOB_KEY }, { $set: { [`progress.${id}`]: state.progress[id] } }, { upsert: true });
    };

    const targets = [];
    for (const c of CHANNELS) {
        const ch = await guild.channels.fetch(c.id).catch(() => null);
        if (ch) targets.push({ ch, label: c.label, cursor: true });
        else console.error(`[M25-HISTORY] ${c.label}: no access`);
    }
    for (const f of FORUMS) {
        for (const t of await forumThreads(guild, f.id)) targets.push({ ch: t, label: `${f.label}/${t.name}`, cursor: false });
    }
    console.log(`[M25-HISTORY] ${targets.length} channels/threads to read`);

    let total = 0, added = 0, dupes = 0;
    for (const { ch, label, cursor } of targets) {
        const p = state.progress[ch.id] || {};
        if (p.done) continue;

        // Normal tarama bu noktadan sonrasini okusun; oncesi bu isin.
        if (cursor && !p.started) {
            const newest = (await ch.messages.fetch({ limit: 1 }).catch(() => null))?.first();
            const cur = await ResultCursor.findOne({ channelId: ch.id }).lean();
            if (newest && !cur?.lastMessageId) {
                await ResultCursor.updateOne({ channelId: ch.id },
                    { $set: { guildId: guild.id, lastMessageId: newest.id, scannedAt: new Date() } }, { upsert: true });
            }
        }
        await saveProgress(ch.id, { started: true, label });

        let before = p.before || undefined;   // yeniden eskiye iner
        let chAdded = 0;
        for (;;) {
            let batch;
            try {
                batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
            } catch (err) {
                console.error(`[M25-HISTORY] ${label}: fetch failed: ${err.message}`);
                await sleep(5000);
                batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
                if (!batch) break;
            }
            if (!batch.size) break;
            const msgs = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);

            for (const msg of msgs) {
                before = msg.id;
                if (!ingest.looksLikeResult(msg)) { continue; }
                if (await RaceResult.exists({ messageId: msg.id })) { await saveProgress(ch.id, { before }); continue; }

                total++;
                const parsed = await ingest.extract(msg).catch(err => { console.error('[M25-HISTORY] extract:', err.message); return null; });
                await sleep(GAP_MS);
                if (parsed) {
                    const entries = ingest.toEntries(parsed, index, aliases);
                    const track = String(parsed.track || '').slice(0, 80);
                    const sig = signature(track, entries);
                    if (entries.length >= 2 && norm(track) && sigs.has(sig)) dupes++;
                    else if (entries.length >= 2) {
                        const res = await RaceResult.updateOne(
                            { messageId: msg.id },
                            { $setOnInsert: {
                                source: 'league', guildId: guild.id, guildName: guild.name, channelId: ch.id,
                                messageId: msg.id, raceAt: msg.createdAt, series: String(parsed.series || '').slice(0, 80),
                                track, memberCount: guild.memberCount || 0, entries,
                            } },
                            { upsert: true },
                        );
                        if (res.upsertedCount) { added++; chAdded++; sigs.add(sig); }
                    }
                }
                await saveProgress(ch.id, { before });
            }
            await saveProgress(ch.id, { before });
            if (batch.size < 100) break;
        }
        await saveProgress(ch.id, { done: true, added: (p.added || 0) + chAdded });
        console.log(`[M25-HISTORY] ${label}: +${chAdded} races`);
    }

    let recomputed = null;
    try {
        recomputed = await ingest.recomputeAll();
        await require('../services/rating/madplus').pushRatings();
    } catch (err) { console.error('[M25-HISTORY] recompute/push:', err.message); }

    await jobs.updateOne({ key: JOB_KEY }, { $set: { doneAt: new Date(), checked: total, added, dupes, recomputed } }, { upsert: true });
    console.log(`[M25-HISTORY] done: ${total} checked, ${added} races added, ${dupes} duplicates skipped`);
}

module.exports = (client) => {
    const start = () => {
        setTimeout(() => {
            const go = () => run(client).catch(err => console.error('[M25-HISTORY] failed:', err.message));
            if (mongoose.connection.readyState === 1) go();
            else mongoose.connection.once('connected', go);
        }, 90 * 1000).unref?.();
    };
    if (client.isReady?.()) start();
    else client.once('ready', start);
};
