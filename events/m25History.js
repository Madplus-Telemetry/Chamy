// Resumable M25 archive backfill. Failures remain visible and retryable.
const mongoose = require('mongoose');
const { ChannelType } = require('discord.js');
const RaceResult = require('../models/RaceResult');
const archive = require('../services/rating/archive');
const { isRatingEnabled } = require('../services/rating/config');
const JOB_KEY = 'm25-history-v2';
const M25_GUILD = '1264284618727886858';
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
async function forumThreads(guild, id) {
    const forum = await guild.channels.fetch(id);
    if (!forum || forum.type !== ChannelType.GuildForum) throw new Error(`Forum unavailable: ${id}`);
    const out = new Map();
    const active = await forum.threads.fetchActive();
    for (const t of active.threads.values()) if (t.parentId === id) out.set(t.id, t);
    let before;
    for (;;) {
        const page = await forum.threads.fetchArchived({ limit: 100, ...(before ? { before } : {}) });
        for (const t of page.threads.values()) out.set(t.id, t);
        if (!page.hasMore) break;
        const next = [...page.threads.values()].at(-1)?.archiveTimestamp;
        if (!next || next === before) throw new Error(`Archived pagination stalled: ${id}`);
        before = next;
    }
    return [...out.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}
async function run(client) {
    if (!isRatingEnabled() || !process.env.GEMINI_API_KEY) return;
    const jobs = mongoose.connection.collection('onetimejobs');
    const audit = mongoose.connection.collection('m25archiveaudits');
    const state = await jobs.findOne({ key: JOB_KEY }) || { progress: {} };
    if (state.doneAt) return;
    const guild = await client.guilds.fetch(M25_GUILD);
    const ingest = require('../services/rating/ingest');
    const index = await ingest.memberIndex(guild);
    const aliases = await require('../services/rating/identity').loadAliases(guild.id);
    const targets = [], discoveryErrors = [];
    for (const c of CHANNELS) {
        try { const ch = await guild.channels.fetch(c.id); if (!ch) throw new Error('No access'); targets.push({ ch, label: c.label }); }
        catch (e) { discoveryErrors.push({ id: c.id, error: e.message }); }
    }
    for (const f of FORUMS) {
        try { for (const ch of await forumThreads(guild, f.id)) targets.push({ ch, label: `${f.label}/${ch.name}` }); }
        catch (e) { discoveryErrors.push({ id: f.id, error: e.message }); }
    }
    // Old season archives are the missing evidence; visit them before re-reading
    // current result feeds already covered by the live scanner.
    targets.sort((a, b) => Number(b.ch.isThread?.() || false) - Number(a.ch.isThread?.() || false));
    await jobs.updateOne({ key: JOB_KEY }, { $set: { startedAt: state.startedAt || new Date(), discoveryErrors, status: 'scanning', targetCount: targets.length } }, { upsert: true });
    const progress = state.progress || {};
    async function processMessage(msg, label) {
        const key = `${JOB_KEY}:${msg.id}`;
        const previous = await audit.findOne({ _id: key });
        if (['imported', 'no_results', 'review'].includes(previous?.status)) return;
        if ((previous?.attempts || 0) >= 3) return;
        try {
            const parsed = await archive.extractMessage(msg, label);
            const records = [];
            let issue = parsed.needsReview;
            for (let i = 0; i < parsed.races.length; i++) {
                const r = parsed.races[i];
                const messageId = archive.raceIdentity(r, msg.id, i);
                const entries = ingest.toEntries(r, index, aliases);
                if (entries.length !== r.entries.length || new Set(entries.map(e => e.key)).size !== entries.length) { issue = true; continue; }
                const evidenceHash = archive.evidenceHash(r);
                // A pre-v2 race may lack round metadata. Flag a possible cross-post
                // instead of awarding it twice or silently merging distinct races.
                const candidates = await RaceResult.find({ guildId: guild.id, ignored: { $ne: true },
                    messageId: { $ne: msg.id }, sourceMessageId: { $ne: msg.id },
                    track: String(r.track || '').slice(0, 80), archiveJob: { $ne: JOB_KEY } }).lean();
                if (candidates.some(old => JSON.stringify((old.entries || []).map(e => e.key)) === JSON.stringify(entries.map(e => e.key)))) { issue = true; continue; }
                const existing = await RaceResult.findOne({ messageId }).lean();
                if (existing && existing.evidenceHash !== evidenceHash) { issue = true; continue; }
                const date = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? new Date(r.date) : null;
                records.push({ messageId, source: 'league', guildId: guild.id, guildName: guild.name,
                    channelId: msg.channelId, sourceMessageId: msg.id, archiveJob: JOB_KEY, evidenceHash,
                    archiveSeason: r.season, archiveRound: r.round, archiveType: r.type,
                    raceAt: date && Number.isFinite(+date) ? date : msg.createdAt,
                    series: `M25 ${r.series || ''}${r.season ? ` S${r.season}` : ''}`.slice(0, 80),
                    track: String(r.track || '').slice(0, 80), memberCount: guild.memberCount || 0, entries });
            }
            // Never replace a legacy record using a partial/ambiguous extraction.
            if (!issue) {
                const legacy = await RaceResult.findOne({ messageId: msg.id }).lean();
                for (const record of records) {
                    if (legacy?.ignored && !legacy?.supersededByArchive) record.ignored = true;
                    await RaceResult.updateOne({ messageId: record.messageId }, { $setOnInsert: record }, { upsert: true });
                }
                if (records.length && legacy) await RaceResult.updateOne({ messageId: msg.id }, { $set: { ignored: true, supersededByArchive: JOB_KEY } });
            }
            await audit.updateOne({ _id: key }, { $set: { job: JOB_KEY, channelId: msg.channelId, messageId: msg.id, label,
                status: issue ? 'review' : records.length ? 'imported' : 'no_results', races: parsed.races,
                findings: parsed.findings, imported: issue ? 0 : records.length, updatedAt: new Date(), error: null }, $inc: { attempts: 1 } }, { upsert: true });
        } catch (e) {
            await audit.updateOne({ _id: key }, { $set: { job: JOB_KEY, channelId: msg.channelId, messageId: msg.id, label,
                status: 'failed', error: e.message.slice(0, 500), updatedAt: new Date() }, $inc: { attempts: 1 } }, { upsert: true });
        }
        await sleep(4000);
    }
    for (const { ch, label } of targets) {
        if (!isRatingEnabled()) return;
        const p = progress[ch.id] || {};
        try {
            const failures = await audit.find({ job: JOB_KEY, channelId: ch.id, status: 'failed', attempts: { $lt: 3 } }).toArray();
            for (const failure of failures) await processMessage(await ch.messages.fetch(failure.messageId), label);
            if (p.done) continue;
            let before = p.before;
            for (;;) {
                if (!isRatingEnabled()) return;
                const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
                const messages = [...batch.values()].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
                for (const msg of messages) {
                    if (ingest.looksLikeResult(msg)) await processMessage(msg, label);
                    before = msg.id;
                    await jobs.updateOne({ key: JOB_KEY }, { $set: { [`progress.${ch.id}`]: { label, before, done: false }, updatedAt: new Date() } });
                }
                if (batch.size < 100) break;
            }
            progress[ch.id] = { label, before, done: true };
            await jobs.updateOne({ key: JOB_KEY }, { $set: { [`progress.${ch.id}`]: progress[ch.id] } });
            console.log(`[M25-HISTORY-V2] scanned ${label}`);
        } catch (e) {
            progress[ch.id] = { ...(progress[ch.id] || {}), done: false, error: e.message };
            await jobs.updateOne({ key: JOB_KEY }, { $set: { [`progress.${ch.id}.error`]: e.message } });
        }
    }
    const rows = await audit.find({ job: JOB_KEY }).toArray();
    const summary = {};
    for (const row of rows) {
        const s = summary[row.channelId] ||= { label: row.label, messages: 0, imported: 0, review: 0, failed: 0, standings: 0 };
        s.messages++; s.imported += row.imported || 0;
        if (row.status === 'review') s.review++;
        if (row.status === 'failed') s.failed++;
        if (row.findings?.some(f => f.kind === 'standings')) s.standings++;
    }
    const retryable = rows.some(r => r.status === 'failed' && r.attempts < 3);
    const fetchedAll = !discoveryErrors.length && targets.every(t => progress[t.ch.id]?.done);
    // Only retire a season surrogate when explicit expected round count and all
    // its race rounds are present. Missing count means coverage is unknown.
    const coverage = {};
    for (const row of rows) {
        const match = row.label?.match(/past-(f[12])-results\/.*?(?:season|s)\s*(\d+)/i);
        if (!match) continue;
        const key = `${match[1].toUpperCase()}:S${match[2]}`;
        const c = coverage[key] ||= { series: match[1].toUpperCase(), season: Number(match[2]), expected: [], rounds: [], blocked: false };
        if (['review', 'failed'].includes(row.status)) c.blocked = true;
        for (const f of row.findings || []) if (f.expectedRounds) c.expected.push(f.expectedRounds);
        if (row.status === 'imported') for (const r of row.races || [])
            if (r.type === 'race' && r.season === c.season && r.series === c.series) c.rounds.push(r.round);
    }
    for (const c of Object.values(coverage)) {
        const expected = [...new Set(c.expected)];
        c.expected = expected.length === 1 ? expected[0] : null;
        c.rounds = [...new Set(c.rounds)].sort((a, b) => a - b);
        c.complete = fetchedAll && !c.blocked && archive.completeSeason(c.rounds, c.expected);
        c.missing = c.expected ? Array.from({ length: c.expected }, (_, i) => i + 1).filter(n => !c.rounds.includes(n)) : null;
        if (c.complete) await RaceResult.updateMany({ guildId: M25_GUILD, track: 'Season standings', series: `M25 ${c.series} S${c.season} WDC final` }, { $set: { ignored: true, supersededByArchive: JOB_KEY } });
    }
    const recomputed = await ingest.recomputeAll();
    await require('../services/rating/madplus').pushRatings();
    const patch = { summary, coverage, recomputed, updatedAt: new Date(), status: fetchedAll && !retryable ? 'scanned_with_coverage_report' : 'retry_pending' };
    // doneAt means all accessible evidence scanned; NOT all historical races reconstructed.
    if (fetchedAll && !retryable) patch.doneAt = new Date();
    await jobs.updateOne({ key: JOB_KEY }, { $set: patch });
    console.log(`[M25-HISTORY-V2] ${patch.status}: ${rows.length} source messages`);
}
module.exports = client => {
    let running = false;
    const go = async () => {
        if (running || mongoose.connection.readyState !== 1) return;
        running = true;
        try { await run(client); } catch (e) { console.error('[M25-HISTORY-V2]', e.message); }
        finally { running = false; }
    };
    const start = () => { setTimeout(go, 90000).unref?.(); setInterval(go, 10 * 60 * 1000).unref?.(); };
    if (client.isReady?.()) start(); else client.once('ready', start);
};
