// services/rating/madplus.js
// ───────────────────────────────────────────────────────────────────────────
// Mad+ yaris raporlari <-> rating.
//
// pullReports()  lobiden yeni raporlari ceker, RaceReport'a yazar, raporu
//                yollayanin kendi Madcar ID'sini Discord hesabina baglar.
// buildRaces()   lig sonuclari + Mad+ raporlarindan rating'e girecek yaris
//                listesini kurar:
//                  • ayni yarisi birden fazla Mad+ kullanicisi yolladiysa tek yaris
//                  • bir lig sonucuyla eslesen rapor (zaman + isim ortusmesi)
//                    -> o lig yarisi 'league_madplus' (x1.1), rapor ayrica sayilmaz
//                  • eslesmeyen rapor, bitisten 6 saat sonra 'public' yaris (x0.35)
//                    (lig sonucunu kanala atmaya zaman taniyoruz)
// pushRatings()  Discord hesabi bilinen suruculerin rating'ini lobiye yollar
//                (app profil ekrani).
// ───────────────────────────────────────────────────────────────────────────

const RaceReport   = require('../../models/RaceReport');
const MadcarLink   = require('../../models/MadcarLink');
const MadRating    = require('../../models/MadRating');
const ResultCursor = require('../../models/ResultCursor');
const engine       = require('./engine');
const { isRatingEnabled } = require('./config');

const CURSOR_ID        = 'lobby:race-reports';
// Kisaltildi (6 saat -> 30 dk): rating her calistirmada bastan hesaplandigi icin,
// rapor sonradan bir lig sonucuyla eslesirse public yaris kendiliginden 'league_madplus'a
// doner; cift sayim olmaz. Uzun bekleme sadece profilin gec dolmasina yariyordu.
const PUBLIC_GRACE_MS  = 30 * 60 * 1000;
const MATCH_BEFORE_MS  = 8 * 60 * 60 * 1000;  // sonuc kanala yaristan en gec 8 saat sonra
const MATCH_AFTER_MS   = 60 * 60 * 1000;
const REPORT_DUPLICATE_MS = 2 * 60 * 1000;

// Isim eslestirme: \"K_Møi21\" == \"kmoi21\", \"Ñandú\" == \"nandu\". NFKC suslu
// unicode'u duzeltir, sonra ozel harfler katlanir, aksanlar atilir.
const FOLD = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ß': 'ss', 'ı': 'i', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'þ': 'th' };
const norm = s => String(s || '')
    .normalize('NFKC')
    .replace(/[øØæÆœŒßıłŁđĐþ]/g, c => FOLD[c])
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

// "01:20.123" / "1:20.1" / "80.5" -> saniye; bos, 0 veya gecersiz -> null
function lapSeconds(s) {
    const m = /^\s*(?:(\d+):)?(\d+(?:\.\d+)?)\s*$/.exec(String(s || ''));
    if (!m) return null;
    const t = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
    return t > 0 && t < 900 ? t : null;
}

function lobby() {
    const base = (process.env.MADPLUS_LOBBY_URL || '').trim()
        .replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://').replace(/\/+$/, '');
    const key = (process.env.MADPLUS_LEAGUE_SYNC_KEY || '').trim();
    return base && key ? { base, key } : null;
}

// Oyunun sonuc listesindeki "f" degeri 0-TABANLIDIR: kazanan 0, ikinci 1, ... Henuz
// bitirmemisler Int.MAX_VALUE (uygulama bunu null yollar). Burada ham deger saklanir
// (0 dahil); gercek yer buildRacesFromReports icinde truePlaces() ile +1 yapilir.
// Eskiden 0 null'a cevriliyordu: kazanan "siralanmamis" sayilip siralananlarin ARKASINA
// dusuyordu, diger herkes de bir yer iyi gorunuyordu.
function cleanEntry(e) {
    const raw = e?.position;
    const position = raw === null || raw === undefined || raw === '' ? null
        : Number.isFinite(+raw) && +raw >= 0 && +raw < 1000 ? Math.floor(+raw) : null; // MAX_VALUE vb. -> null
    return {
        position,
        actorNr:    Number.isFinite(+e?.actorNr) ? Math.floor(+e.actorNr) : 0,
        nick:       String(e?.nick || '').trim().slice(0, 40),
        madcarId:   /^[0-9a-f]{8,32}$/i.test(String(e?.madcarId || '')) ? String(e.madcarId).toLowerCase() : null,
        carId:      Number.isFinite(+e?.carId) ? Math.floor(+e.carId) : null,
        bestLap:    String(e?.bestLap || '').slice(0, 16),
        fastestLap: !!e?.fastestLap,
        local:      !!e?.local,
    };
}

async function pullReports() {
    if (!isRatingEnabled()) return { added: 0, skipped: true };
    const l = lobby();
    if (!l) return { added: 0, skipped: true };

    const cursor = await ResultCursor.findOne({ channelId: CURSOR_ID }).lean();
    const [boot = '', seq = '0'] = String(cursor?.lastMessageId || '').split(':');
    const res = await fetch(`${l.base}/v1/races/reports?since=${Number(seq) || 0}&boot=${encodeURIComponent(boot)}`, {
        headers: { 'X-MadPlus-League-Key': l.key },
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`lobby ${res.status}`);
    const data = await res.json();

    let added = 0;
    for (const r of data.reports || []) {
        const entries = (Array.isArray(r.entries) ? r.entries : []).map(cleanEntry).filter(e => e.nick || e.madcarId);
        if (entries.length < 2) continue;
        const finishedAt = new Date(Number(r.finishedAt) || Number(r.receivedAt) || Date.now());
        const out = await RaceReport.updateOne(
            { reportKey: `${data.bootId}:${r.seq}` },
            { $setOnInsert: {
                reporterDiscordId: String(r.reporterDiscordId || ''),
                roomCode: String(r.roomCode || '').slice(0, 32),
                trackId: String(r.trackId || '').slice(0, 40),
                finishedAt, entries,
            } },
            { upsert: true },
        );
        if (out.upsertedCount) added++;

        // Raporu yollayanin kendi satiri -> bu Discord hesabi. Kendi Madcar ID'miz
        // her zaman gorunmuyor (kendi ozelliklerimiz giden trafikte); o zaman
        // oyun ici isimle bagla.
        const mine = entries.find(e => e.local);
        if (mine && r.reporterDiscordId && (mine.madcarId || norm(mine.nick))) {
            await MadcarLink.updateOne(
                { madcarId: mine.madcarId || `nick:${norm(mine.nick)}` },
                { $set: { discordId: String(r.reporterDiscordId), nick: mine.nick } },
                { upsert: true },
            );
        }
    }

    await ResultCursor.updateOne(
        { channelId: CURSOR_ID },
        { $set: { lastMessageId: `${data.bootId}:${data.lastSeq}`, scannedAt: new Date() } },
        { upsert: true },
    );
    return { added };
}

async function buildRaces(leagueRaces) {
    if (!isRatingEnabled()) return [];
    // Placement and earned rating must survive a report becoming a year old.
    const reports = await RaceReport.find({}).lean();
    const links = await MadcarLink.find({}).lean();
    return buildRacesFromReports(leagueRaces, reports, links);
}

// Rapordaki "position" -> gercek yer (1 = kazanan).
//  • Yeni rapor: ham 0-tabanli f saklanir, kazananin f'i 0'dir -> hepsine +1.
//  • Eski rapor: 0 null'a cevrilmisti. Oyun listeyi siralama sirasiyla yollar (dizinin ilk
//    elemani kazanan, f = dizin), yani [null, 1, 2, 3, ...] -> ilk eleman 1, digerleri +1.
//  • Hic bitiren yoksa (hepsi null) ya da zaten gercek yer olan rapora dokunulmaz.
function truePlaces(r) {
    const es = r.entries || [];
    if (es.some(e => e.position === 0)) {
        return { ...r, entries: es.map(e => (e.position == null ? e : { ...e, position: e.position + 1 })) };
    }
    if (es.length >= 2 && es[0].position == null && es[1].position === 1) {
        return { ...r, entries: es.map((e, i) =>
            i === 0 ? { ...e, position: 1 } : (e.position == null ? e : { ...e, position: e.position + 1 })) };
    }
    return r;
}

function buildRacesFromReports(leagueRaces, rawReports, links, now = Date.now()) {
    const reports = rawReports.map(truePlaces);
    const byMadcar = new Map(links.map(l => [l.madcarId, l.discordId]));
    const byNick = new Map();
    for (const l of links) if (l.nick) byNick.set(norm(l.nick), l.discordId);

    const keyOf = (e) => {
        const discordId = (e.madcarId && byMadcar.get(e.madcarId)) || byNick.get(norm(e.nick));
        if (discordId) return { key: `u:${discordId}`, userId: discordId };
        if (e.madcarId) return { key: `m:${e.madcarId}`, userId: null };
        const n = norm(e.nick);
        return n ? { key: `n:${n}`, userId: null } : null;
    };

    // 1) Ayni yaris birden fazla kisiden geldiyse tek yaris
    const groups = new Map();
    const latestGroup = new Map();
    for (const r of [...reports].sort((a, b) => new Date(a.finishedAt) - new Date(b.finishedAt))) {
        const at = new Date(r.finishedAt).getTime();
        if (!Number.isFinite(at)) continue;
        const sig = `${r.roomCode || ''}|` + r.entries.map(e => `${e.position ?? 'x'}:${norm(e.nick)}:${e.bestLap || ''}`).sort().join(',');
        let g = latestGroup.get(sig);
        if (!g || at - new Date(g.report.finishedAt).getTime() > REPORT_DUPLICATE_MS) {
            g = { report: r, owners: new Map() };
            groups.set(`${sig}|${at}`, g);
            latestGroup.set(sig, g);
        }
        const local = r.entries.filter(e => e.local === true);
        if (/^\d{17,20}$/.test(r.reporterDiscordId || '') && local.length === 1) {
            // Keep every reporter's local row; choosing the first report must
            // not discard the other Mad+ users in the same race.
            const e = local[0];
            const identity = e.madcarId ? `m:${e.madcarId}` : `n:${norm(e.nick)}`;
            if (identity !== 'n:') {
                const prev = g.owners.get(identity);
                g.owners.set(identity, prev && prev.userId !== r.reporterDiscordId
                    ? { conflict: true }
                    : { key: `u:${r.reporterDiscordId}`, userId: r.reporterDiscordId, nick: norm(e.nick) });
            }
        }
    }

    const identityInReport = (e, group) => {
        const identity = e.madcarId ? `m:${e.madcarId}` : `n:${norm(e.nick)}`;
        const own = group.owners.get(identity);
        if (own && !own.conflict) return { key: own.key, userId: own.userId };
        return keyOf(e);
    };

    // 2) Lig sonuclari: isimleri hesaplara bagla, eslesen Mad+ raporunu bul
    const matched = new Set();
    const out = [];
    for (const race of [...leagueRaces].sort((a, b) => new Date(a.raceAt) - new Date(b.raceAt))) {
        const raceAt = new Date(race.raceAt).getTime();
        const names = new Set(race.entries.map(e => norm(e.name)).filter(Boolean));
        let hit = null;
        for (const [sig, g] of groups) {
            if (/season\s*standings/i.test(race.track || '')) break;
            if (matched.has(sig)) continue;
            if (race.track && g.report.trackId && norm(race.track) !== norm(g.report.trackId)) continue;
            const ft = new Date(g.report.finishedAt).getTime();
            if (ft > raceAt + MATCH_AFTER_MS || ft < raceAt - MATCH_BEFORE_MS) continue;
            const overlap = g.report.entries.filter(e => names.has(norm(e.nick))).length;
            const need = Math.max(2, Math.ceil(0.6 * Math.min(names.size, g.report.entries.length)));
            if (overlap >= need) { hit = sig; break; }
        }

        const fromReport = new Map();
        const appUsers = new Set();
        if (hit) {
            matched.add(hit);
            const group = groups.get(hit);
            for (const owner of group.owners.values()) {
                if (!owner.conflict) appUsers.add(owner.userId);
            }
            for (const e of group.report.entries) {
                const k = identityInReport(e, group);
                if (k) fromReport.set(norm(e.nick), k);
            }
        }

        const entries = race.entries.map(e => {
            if (e.userId) return e;
            const n = norm(e.name);
            const linked = byNick.get(n);
            if (linked) return { ...e, key: `u:${linked}`, userId: linked };
            const k = fromReport.get(n);           // Mad+ raporundaki Madcar ID
            return k ? { ...e, key: k.key, userId: k.userId } : e;
        }).map(e => ({ ...e, appRecorded: !!e.userId && appUsers.has(e.userId) }));
        out.push({ ...race, entries, appVerified: !!hit, source: hit ? 'league_madplus' : race.source });
    }

    // 3) Eslesmeyen raporlar -> public oda yarisi (6 saat bekledikten sonra)
    for (const [sig, g] of groups) {
        if (matched.has(sig)) continue;
        const r = g.report;
        if (now - new Date(r.finishedAt).getTime() < PUBLIC_GRACE_MS) continue;
        const appUsers = new Set([...g.owners.values()].filter(o => !o.conflict).map(o => o.userId));
        const finished = [], dnf = [];
        // Oyun sonucu ilk bitirenler cizgiyi gectiginde bir kez yollar: o an bitirmemis
        // (hala yarista) herkes position=null gelir. Bunlar DNF DEGIL. Gercek bir en iyi turu
        // (>0) olan null'lar bitirmis sayilir: siralananlarin arkasina, en iyi tura gore dizilir
        // (gercek bitis sirasi bilinmiyor, tur yaklasik sira verir). En iyi turu 00:00.00 olan
        // (hic tur atmamis) null'lar DNF kalir.
        const ordered = [...r.entries].sort((a, b) => {
            const pa = a.position ?? 1e9, pb = b.position ?? 1e9;
            if (pa !== pb) return pa - pb;
            return (lapSeconds(a.bestLap) ?? 1e9) - (lapSeconds(b.bestLap) ?? 1e9);
        });
        for (const e of ordered) {
            const k = identityInReport(e, g);
            if (!k) continue;
            const isDnf = e.position == null && lapSeconds(e.bestLap) == null;
            (isDnf ? dnf : finished).push({ key: k.key, userId: k.userId, name: e.nick, dnf: isDnf,
                appRecorded: !!k.userId && appUsers.has(k.userId) });
        }
        const entries = [...finished, ...dnf].map((e, i) => ({ ...e, position: i + 1 }));
        if (entries.length < 2) continue;
        out.push({ _id: `report:${String(r._id)}`, source: 'public', guildId: '', raceAt: r.finishedAt, memberCount: 0, entries, appVerified: true });
    }
    return canonicalize(out);
}

// ── Yazim farki olan ayni surucu ─────────────────────────────────────────────
// Sonuc tablolari elle yaziliyor: "AlexEspo08", "AlexEspoo08", "AlexExpo08",
// "Proton0"/"ProtonO" ayni kisi ama ayri rating'e bolunuyordu.
//  • iskelet: 0->o, 1/l->i, tekrarlanan harf teke ("espoo" -> "espo")
//  • iskeletler ayni ise ayni kisi
//  • 6+ harfli iskeletlerde TEK harf farki da ayni kisi (kisa adlarda yok:
//    "Leo5"/"Leo6" farkli kisiler olabilir)
//  • grupta Discord'a bagli (u:) kayit varsa hepsi ona baglanir; yoksa en cok
//    gecen yazim grubun anahtari olur.
const skeleton = s => norm(s).replace(/0/g, 'o').replace(/[1l]/g, 'i').replace(/(.)\1+/g, '$1');

function withinOneEdit(a, b) {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { i++; j++; continue; }
        if (++edits > 1) return false;
        if (a.length > b.length) i++;
        else if (b.length > a.length) j++;
        else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
}

const sameDriver = (a, b) => a === b || (a.length >= 6 && b.length >= 6 && withinOneEdit(a, b));

function canonicalize(races) {
    // Her anahtar icin: iskelet, bagli hesap, kac kez gectigi
    const info = new Map(); // key -> { sk, userId, count }
    for (const race of races) {
        for (const e of race.entries || []) {
            const sk = skeleton(e.name || e.key.slice(2));
            if (!sk) continue;
            const cur = info.get(e.key) || { sk, userId: e.userId || null, count: 0 };
            cur.count++;
            if (e.userId) cur.userId = e.userId;
            info.set(e.key, cur);
        }
    }

    // Union-find: ayni surucu sayilan anahtarlari grupla
    const keys = [...info.keys()];
    const parent = new Map(keys.map(k => [k, k]));
    const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
    for (let i = 0; i < keys.length; i++) {
        for (let j = i + 1; j < keys.length; j++) {
            const a = info.get(keys[i]), b = info.get(keys[j]);
            // Iki FARKLI Discord hesabi asla birlesmez
            if (a.userId && b.userId && a.userId !== b.userId) continue;
            if (sameDriver(a.sk, b.sk)) parent.set(find(keys[i]), find(keys[j]));
        }
    }

    // Grup basina kanonik anahtar: Discord hesabi varsa o, yoksa en cok gecen
    const groups = new Map(); // root -> [keys]
    for (const k of keys) {
        const r = find(k);
        if (!groups.has(r)) groups.set(r, []);
        groups.get(r).push(k);
    }
    const canonical = new Map(); // key -> { key, userId }
    for (const members of groups.values()) {
        if (members.length === 1) continue;
        // Grupta birden fazla farkli hesap varsa (zincirleme eslesme) dokunma
        const accounts = new Set(members.map(k => info.get(k).userId).filter(Boolean));
        if (accounts.size > 1) continue;
        const userId = [...accounts][0] || null;
        const target = userId
            ? `u:${userId}`
            : members.reduce((best, k) => (info.get(k).count > info.get(best).count ? k : best), members[0]);
        for (const k of members) canonical.set(k, { key: target, userId });
    }
    if (!canonical.size) return races;

    return races.map(race => ({
        ...race,
        entries: (race.entries || []).map(e => {
            const c = canonical.get(e.key);
            return c ? { ...e, key: c.key, userId: c.userId || e.userId || null } : e;
        }),
    }));
}

async function pushRatings() {
    const l = lobby();
    if (!l) return { skipped: true };
    // Replace the lobby snapshot with an empty one while paused; otherwise
    // old ratings remain visible after the MongoDB reset.
    const rows = isRatingEnabled()
        ? await MadRating.find({ userId: { $ne: null } }).lean()
        : [];
    const drivers = rows.map(r => ({
        discordId: r.userId,
        name: r.name,
        rating: r.rating,
        level: r.level,
        races: r.races,
        wins: r.wins,
        podiums: r.podiums,
        peak: r.peak,
        placement: r.placement,
        placementRaces: engine.PLACEMENT_RACES,
        scanRating: r.scanRating ?? null,
        scanContribution: r.scanContribution ?? 0,
        historicalRaces: r.historicalRaces ?? 0,
        historicalWins: r.historicalWins ?? 0,
        historicalPodiums: r.historicalPodiums ?? 0,
        baseRating: r.baseRating ?? engine.START_RATING,
        appDelta: r.appDelta ?? 0,
        ratingVersion: r.ratingVersion ?? 1,
        rank: r.rank ?? null,
        challenger: !!r.challenger,
        lastRaceAt: r.lastRaceAt ? new Date(r.lastRaceAt).getTime() : null,
        history: (r.history || []).map(h => ({
            at: h.at ? new Date(h.at).getTime() : null,
            rating: h.rating, delta: h.delta, place: h.place, field: h.field,
        })),
    }));
    const res = await fetch(`${l.base}/v1/ratings/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-MadPlus-League-Key': l.key },
        body: JSON.stringify({ drivers }),
        signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`lobby ${res.status}`);
    return { pushed: drivers.length };
}

module.exports = { pullReports, buildRaces, buildRacesFromReports, pushRatings };
