// services/rating/engine.js
// ───────────────────────────────────────────────────────────────────────────
// Mad+ rating -- saf matematik, DB yok. Tum yarislar tarih sirasiyla BASTAN
// oynatilir; agirlik degisince eski yarislar da yeni agirlikla yeniden hesaplanir.
// v2: imported history is replayed separately. Half its TOTAL rating becomes
// the base (2034 -> 1017), then own Mad+ race deltas are added at full weight.
// Only 10 own app reports complete placement; scans never grant a rank.
// Drivers with no imported history open at the SAME scale as everyone else:
// OPENING_RATING = START_RATING * SCAN_CREDIT (1000 * 0.5 = 500), i.e. exactly what
// an average imported driver gets. (Used to be a flat 1000, which put a newcomer
// 500 points above a driver with a short or weak league history.)
// App ledger runs on that 500-centred scale, so field strength and league prestige
// are normalised by OPENING_RATING there (the imported-history replay still uses
// 1000), and own-race deltas get APP_K_MULT so levels are reachable but L10 stays rare.
//
// Yaris basina degisim (surucu i):
//   delta_i = K * kMult_i * W * Σ_j damp_ij * (S_ij - E_ij) / (N - 1)
//     S_ij  : i, j'nin onunde bitirdiyse 1, arkasindaysa 0, ikisi de DNF ise 0.5
//     E_ij  : Elo beklentisi 1 / (1 + 10^((R_j - R_i)/ELO_SCALE))
//     kMult : yerlesme (ilk 10 yaris) 2x
//     damp  : yerlesmis surucu, yerlesmemis rakibe karsi 0.5 (yeni gelen
//             rastgele sonucla yerlesmis birini fazla oynatmasin)
//
//   W (yaris agirligi) = kaynak x rakip gucu x taninirlik x kadro x lig prestiji
//     kaynak    : lig 1.0 | lig + host Mad+ 1.1 | public oda 0.35
//     rakip gucu: sahanin ortalama rating'i / 1000        (0.6 .. 1.6)
//     taninirlik: 0.4 + 0.6 x yerlesmis surucu orani     (hic taninan yoksa az)
//     kadro     : sqrt((N-1)/9), en fazla 1               (10+ kisi = tam)
//     prestij   : (0.35 + 0.45 x aktiflik + 0.2 x sunucu buyuklugu) x lig rating'i
//                 aktiflik = son 90 gunde ligde yarisan surucu / 30 (en fazla 1)
//                 buyukluk = sqrt(uye / 700), en fazla 1 (M25 ~683 uye = tam)
//                 lig rating'i = o aktif suruculerin ort. rating'i / 1000 (0.7..1.4)
//                 public odalarda 1
//   W en az 0.1, en fazla 1.6.
//
// Seviyeler FACEIT tablosu: L1 100-500 ... L10 2001+. Rating 100'un altina
// inmez. Madcar kucuk bir toplum oldugu icin FACEIT'in 400 olcegi puanlari
// ~700-1350 arasina sikistiriyordu; ELO_SCALE 1500 + K 100 ile ayni
// basari farki 100-2200 araligina yayiliyor (sentetik 420 yarislik
// simulasyonda: medyan ~1000, ust %2 L10, yaris basina ort. |degisim| ~17).
// Challenger: Level 10 olup yerlesmis suruculer arasinda ilk CHALLENGER_TOP.
// ───────────────────────────────────────────────────────────────────────────

const START_RATING            = 1000;
const SCAN_CREDIT             = 0.5;
const OPENING_RATING          = START_RATING * SCAN_CREDIT;
const APP_K_MULT              = 1.4; // tuning knob for own-race deltas (raised 1.0 -> 1.4: drivers found levels too grindy)
const K_BASE                  = 100;
const ELO_SCALE               = 1500;
const RATING_FLOOR            = 100;
const CHALLENGER_TOP          = 10;
const PLACEMENT_RACES         = 10;
const PLACEMENT_K_MULT        = 2;
const PLACEMENT_OPPONENT_DAMP = 0.5;
const SOURCE_WEIGHT           = { league: 1.0, league_madplus: 1.1, public: 0.35 };
const WEIGHT_MIN              = 0.1;
const WEIGHT_MAX              = 1.6;
const LEAGUE_WINDOW_MS        = 90 * 24 * 60 * 60 * 1000;
// Sunucu buyuklugu tavani: en buyuk Madcar ligi (M25) ~683 uye -> 700 = tam puan.
// sqrt: 50 uye 0.27, 200 uye 0.53, 400 uye 0.76, 700+ uye 1.0
const MEMBERS_FULL            = 700;
const HISTORY_KEEP            = 30;
// Galibiyet terimi (Plackett-Luce ilk sira): kazanan, kazanma ihtimali
// ne kadar dusukse o kadar ek puan alir; digerleri kazanma ihtimalleri
// oraninda az kaybeder (toplam sifir). Ikili Elo P1 ile P2'yi neredeyse
// esit sayiyordu: 19 galibiyetli surucu 7 galibiyetliyle basabasti.
const WIN_WEIGHT              = 0.3;
// Sezon sonu puan tablosu = bir sezonun tamami: tek yaristan agir sayilir,
// ilk 3 kaydi (3 kisilik) kadro cezasi almaz.
const SEASON_WEIGHT           = 1.25;
const isSeasonTable = race => /season\s*standings/i.test(race.track || '');

// Seviye esikleri (FACEIT): L1 100-500, L2 501-750, L3 751-900, L4 901-1050,
// L5 1051-1200, L6 1201-1350, L7 1351-1530, L8 1531-1750, L9 1751-2000, L10 2001+
const LEVEL_THRESHOLDS = [501, 751, 901, 1051, 1201, 1351, 1531, 1751, 2001];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const round1 = v => Math.round(v * 10) / 10;

function levelOf(rating) {
    return 1 + LEVEL_THRESHOLDS.filter(t => rating >= t).length;
}

function expected(ra, rb) {
    return 1 / (1 + Math.pow(10, (rb - ra) / ELO_SCALE));
}

function fieldFactors(keys, players, center = START_RATING) {
    let wSum = 0, rSum = 0, established = 0;
    for (const k of keys) {
        const p = players.get(k);
        const est = p.races >= PLACEMENT_RACES;
        if (est) established++;
        const w = est ? 1 : 0.5; // yerlesmemis rating'i daha az guvenilir
        wSum += w;
        rSum += p.rating * w;
    }
    const avg = wSum ? rSum / wSum : center;
    const share = keys.length ? established / keys.length : 0;
    return {
        strength:    clamp(avg / center, 0.6, 1.6),
        recognition: 0.4 + 0.6 * share,
        size:        Math.min(1, Math.sqrt((keys.length - 1) / 9)),
        avgRating:   avg,
        establishedShare: share,
    };
}

function leaguePrestige(race, players, guildActivity, center = START_RATING) {
    if (race.source === 'public') return { prestige: 1, activeDrivers: 0 };
    const raceAt = new Date(race.raceAt).getTime();
    const act = guildActivity.get(race.guildId) || new Map();
    const active = [...act.entries()].filter(([, at]) => at >= raceAt - LEAGUE_WINDOW_MS).map(([k]) => k);
    const avg = active.length
        ? active.reduce((s, k) => s + (players.get(k)?.rating ?? center), 0) / active.length
        : center;
    const activity = Math.min(1, active.length / 30);
    const size = race.memberCount > 0 ? Math.min(1, Math.sqrt(race.memberCount / MEMBERS_FULL)) : 0;
    const ratingFactor = clamp(avg / center, 0.7, 1.4);
    return {
        prestige: clamp((0.35 + 0.45 * activity + 0.2 * size) * ratingFactor, 0.3, 1.4),
        activeDrivers: active.length,
    };
}

function newPlayer(entry, opening = START_RATING) {
    return {
        key: entry.key, userId: entry.userId || null, name: entry.name || '',
        rating: opening, races: 0, wins: 0, podiums: 0, peak: opening,
        history: [], lastRaceAt: null,
    };
}

// Only the authenticated reporter's own row is a Mad+ placement race.
// Source labels, Discord scans and another driver's report are not evidence.
function isAppEntry(race, entry) {
    return !isSeasonTable(race) && race.appVerified === true &&
        entry.appRecorded === true && !!entry.userId && entry.key === `u:${entry.userId}`;
}

/**
 * @param races RaceResult benzeri objeler (entries bitis sirasinda, DNF'ler sonda)
 * @returns { players: Map<key, player>, raceWeights: [...] }
 */
function replay(races, players = new Map(), appMode = false, freeze = {}) {
    const ledger = appMode ? 'app' : 'scan';
    const frozenMap = freeze.frozen || null;   // Map "ledger:raceId" -> kayit
    const freezeOut = freeze.out || null;      // yeni/guncellenen kayitlar buraya
    const guildActivity = new Map();
    const raceWeights = [];
    const raceInfo = new Map();   // raceId -> { track, at, results } (yalniz Mad+ yarislari)

    const sorted = [...races]
        .filter(r => !r.ignored)
        .sort((a, b) => new Date(a.raceAt) - new Date(b.raceAt));

    for (const race of sorted) {
        const seen = new Set();
        const entries = (race.entries || []).filter(e => e?.key && !seen.has(e.key) && seen.add(e.key));
        if (entries.length < 2) continue;

        for (const e of entries) {
            if (!players.has(e.key)) players.set(e.key, newPlayer(e, appMode ? OPENING_RATING : START_RATING));
            const p = players.get(e.key);
            if (e.userId && !p.userId) p.userId = e.userId;
            if (e.name) p.name = e.name;
        }

        const keys = entries.map(e => e.key);
        const center = appMode ? OPENING_RATING : START_RATING;
        const rid = String(race._id || race.messageId || '');
        const freezeId = `${ledger}:${rid}`;
        const hash = entries.map(e => `${e.key}${e.dnf ? '!' : ''}${isAppEntry(race, e) ? '*' : ''}`).join('|');
        const rec = rid && frozenMap ? frozenMap.get(freezeId) : null;
        let f, lp, source, weight, deltas;
        if (rec && rec.entriesHash === hash) {
            // Dondurulmus yaris: yaris aninda hesaplanan degerler aynen kullanilir.
            const byKey = new Map(rec.deltas);
            deltas = keys.map(k => byKey.get(k) ?? 0);
            weight = rec.weight;
            source = rec.info?.source ?? (SOURCE_WEIGHT[race.source] ?? 1);
            f = rec.info || {};
            lp = { prestige: rec.info?.prestige ?? 1, activeDrivers: rec.info?.activeDrivers ?? 0 };
        } else {
            f = fieldFactors(keys, players, center);
            lp = leaguePrestige(race, players, guildActivity, center);
            source = SOURCE_WEIGHT[race.source] ?? 1;
            const season = isSeasonTable(race);
            const size = season ? 1 : f.size;
            weight = clamp(source * f.strength * f.recognition * size * lp.prestige * (season ? SEASON_WEIGHT : 1), WEIGHT_MIN, WEIGHT_MAX);

            const before = keys.map(k => players.get(k).rating);
            const strengths = before.map(r => Math.pow(10, r / ELO_SCALE));
            const totalStrength = strengths.reduce((a, b) => a + b, 0);
            const winProb = strengths.map(s => s / totalStrength);
            deltas = keys.map((k, i) => {
                const me = players.get(k);
                const meEstablished = me.races >= PLACEMENT_RACES;
                let sum = 0;
                for (let j = 0; j < keys.length; j++) {
                    if (j === i) continue;
                    const opp = players.get(keys[j]);
                    const s = entries[i].dnf && entries[j].dnf ? 0.5 : (i < j ? 1 : 0);
                    const damp = meEstablished && opp.races < PLACEMENT_RACES ? PLACEMENT_OPPONENT_DAMP : 1;
                    sum += damp * (s - expected(before[i], before[j]));
                }
                const kMult = meEstablished ? 1 : PLACEMENT_K_MULT;
                const winScore = (i === 0 && !entries[0].dnf ? 1 : 0) - winProb[i];
                return K_BASE * (appMode ? APP_K_MULT : 1) * kMult * weight * (sum / (keys.length - 1) + WIN_WEIGHT * winScore);
            });
            if (freezeOut && rid) {
                freezeOut.push({
                    freezeId, ledger, raceId: rid, entriesHash: hash, weight,
                    deltas: keys.map((k, i) => [k, deltas[i]]),
                    info: {
                        source, strength: f.strength, recognition: f.recognition, size: f.size,
                        avgRating: f.avgRating, establishedShare: f.establishedShare,
                        prestige: lp.prestige, activeDrivers: lp.activeDrivers,
                    },
                });
            }
        }

        const raceAt = new Date(race.raceAt);
        keys.forEach((k, i) => {
            // A matched league/app race is scored once per driver: either
            // imported history or their own app ledger, never both.
            if (isAppEntry(race, entries[i]) !== appMode) return;
            const p = players.get(k);
            const prev = p.rating;
            p.rating = Math.max(RATING_FLOOR, p.rating + deltas[i]);   // 100'un altina inmez
            const applied = p.rating - prev;
            p.races += 1;
            if (i === 0 && !entries[i].dnf) p.wins += 1;
            if (i < 3 && !entries[i].dnf) p.podiums += 1;
            p.peak = Math.max(p.peak, p.rating);
            p.lastRaceAt = raceAt;
            p.history.push({
                raceId: String(race._id || race.messageId || ''),
                at: raceAt,
                delta: round1(applied),
                rating: round1(p.rating),
                weight: round1(weight * 100) / 100,
                place: entries[i].dnf ? 0 : i + 1,
                field: keys.length,
                track: String(race.track || '').slice(0, 80),
            });
            if (p.history.length > HISTORY_KEEP) p.history.shift();
        });

        if (race.source !== 'public' && race.guildId) {
            if (!guildActivity.has(race.guildId)) guildActivity.set(race.guildId, new Map());
            const act = guildActivity.get(race.guildId);
            for (const k of keys) act.set(k, raceAt.getTime());
        }

        if (appMode && entries.some(e => isAppEntry(race, e))) {
            raceInfo.set(String(race._id || race.messageId || ''), {
                track: String(race.track || '').slice(0, 80),
                at: raceAt.getTime(),
                results: entries.map((e, i) => ({
                    id: e.userId || null, name: String(e.name || '').slice(0, 40),
                    place: e.dnf ? 0 : i + 1, dnf: !!e.dnf,
                })),
            });
        }

        raceWeights.push({
            raceId: String(race._id || race.messageId || ''),
            weight, source, ...f, prestige: lp.prestige, activeDrivers: lp.activeDrivers,
        });
    }

    for (const p of players.values()) {
        p.rating = round1(p.rating);
        p.peak = round1(p.peak);
        p.level = levelOf(p.rating);
        p.placement = p.races < PLACEMENT_RACES;
        p.challenger = false;
        p.rank = null;
    }
    // Siralama (sadece yerlesmis suruculer) + Challenger: L10'lar arasinda ilk 10
    const ranked = [...players.values()].filter(p => !p.placement).sort((a, b) => b.rating - a.rating);
    ranked.forEach((p, i) => {
        p.rank = i + 1;
        p.challenger = p.level >= 10 && i < CHALLENGER_TOP;
    });
    return { players, raceWeights, raceInfo };
}

// opts.frozen: Map "ledger:raceId" -> dondurulmus kayit (yoksa her sey bastan hesaplanir)
// Donus: freezes = yeni hesaplanan/guncellenen kayitlar (DB'ye yazilmali).
function recompute(races, opts = {}) {
    const valid = races.filter(r => !r.ignored);
    const freezes = [];
    const fz = { frozen: opts.frozen || null, out: freezes };
    const scanned = replay(valid.filter(r => r.source !== 'public'), new Map(), false, fz);
    const seeds = new Map();
    for (const old of scanned.players.values()) {
        if (!old.races) continue;
        const scanContribution = round1(old.rating * SCAN_CREDIT);
        const baseRating = Math.max(RATING_FLOOR, scanContribution);
        seeds.set(old.key, {
            ...newPlayer(old), rating: baseRating, peak: baseRating,
            scanRating: old.rating, scanContribution, baseRating,
            historicalRaces: old.races, historicalWins: old.wins,
            historicalPodiums: old.podiums,
        });
    }
    const live = replay(valid.filter(r => r.entries?.some(e => isAppEntry(r, e))), seeds, true, fz);
    for (const [key, p] of live.players) {
        if (!p.races && !p.historicalRaces) {
            live.players.delete(key);
            continue;
        }
        p.scanRating ??= null;
        p.scanContribution ??= 0;
        p.baseRating ??= OPENING_RATING;
        p.historicalRaces ??= 0;
        p.historicalWins ??= 0;
        p.historicalPodiums ??= 0;
        p.appDelta = round1(p.rating - p.baseRating);
        p.ratingVersion = 2;
    }
    return {
        players: live.players,
        raceInfo: live.raceInfo,
        freezes,
        raceWeights: [
            ...scanned.raceWeights.map(w => ({ ...w, ledger: 'scan' })),
            ...live.raceWeights.map(w => ({ ...w, ledger: 'app' })),
        ],
    };
}

module.exports = {
    START_RATING, OPENING_RATING, APP_K_MULT, K_BASE, ELO_SCALE, RATING_FLOOR, CHALLENGER_TOP, PLACEMENT_RACES, SOURCE_WEIGHT, LEVEL_THRESHOLDS,
    SCAN_CREDIT, levelOf, expected, recompute,
};
