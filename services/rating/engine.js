// services/rating/engine.js
// ───────────────────────────────────────────────────────────────────────────
// Mad+ rating -- saf matematik, DB yok. Tum yarislar tarih sirasiyla BASTAN
// oynatilir; agirlik degisince eski yarislar da yeni agirlikla yeniden hesaplanir.
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

function fieldFactors(keys, players) {
    let wSum = 0, rSum = 0, established = 0;
    for (const k of keys) {
        const p = players.get(k);
        const est = p.races >= PLACEMENT_RACES;
        if (est) established++;
        const w = est ? 1 : 0.5; // yerlesmemis rating'i daha az guvenilir
        wSum += w;
        rSum += p.rating * w;
    }
    const avg = wSum ? rSum / wSum : START_RATING;
    const share = keys.length ? established / keys.length : 0;
    return {
        strength:    clamp(avg / START_RATING, 0.6, 1.6),
        recognition: 0.4 + 0.6 * share,
        size:        Math.min(1, Math.sqrt((keys.length - 1) / 9)),
        avgRating:   avg,
        establishedShare: share,
    };
}

function leaguePrestige(race, players, guildActivity) {
    if (race.source === 'public') return { prestige: 1, activeDrivers: 0 };
    const raceAt = new Date(race.raceAt).getTime();
    const act = guildActivity.get(race.guildId) || new Map();
    const active = [...act.entries()].filter(([, at]) => at >= raceAt - LEAGUE_WINDOW_MS).map(([k]) => k);
    const avg = active.length
        ? active.reduce((s, k) => s + (players.get(k)?.rating ?? START_RATING), 0) / active.length
        : START_RATING;
    const activity = Math.min(1, active.length / 30);
    const size = race.memberCount > 0 ? Math.min(1, Math.sqrt(race.memberCount / MEMBERS_FULL)) : 0;
    const ratingFactor = clamp(avg / START_RATING, 0.7, 1.4);
    return {
        prestige: clamp((0.35 + 0.45 * activity + 0.2 * size) * ratingFactor, 0.3, 1.4),
        activeDrivers: active.length,
    };
}

function newPlayer(entry) {
    return {
        key: entry.key, userId: entry.userId || null, name: entry.name || '',
        rating: START_RATING, races: 0, wins: 0, podiums: 0, peak: START_RATING,
        history: [], lastRaceAt: null,
    };
}

/**
 * @param races RaceResult benzeri objeler (entries bitis sirasinda, DNF'ler sonda)
 * @returns { players: Map<key, player>, raceWeights: [...] }
 */
function recompute(races) {
    const players = new Map();
    const guildActivity = new Map();
    const raceWeights = [];

    const sorted = [...races]
        .filter(r => !r.ignored)
        .sort((a, b) => new Date(a.raceAt) - new Date(b.raceAt));

    for (const race of sorted) {
        const seen = new Set();
        const entries = (race.entries || []).filter(e => e?.key && !seen.has(e.key) && seen.add(e.key));
        if (entries.length < 2) continue;

        for (const e of entries) {
            if (!players.has(e.key)) players.set(e.key, newPlayer(e));
            const p = players.get(e.key);
            if (e.userId && !p.userId) p.userId = e.userId;
            if (e.name) p.name = e.name;
        }

        const keys = entries.map(e => e.key);
        const f = fieldFactors(keys, players);
        const lp = leaguePrestige(race, players, guildActivity);
        const source = SOURCE_WEIGHT[race.source] ?? 1;
        const weight = clamp(source * f.strength * f.recognition * f.size * lp.prestige, WEIGHT_MIN, WEIGHT_MAX);

        const before = keys.map(k => players.get(k).rating);
        const deltas = keys.map((k, i) => {
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
            return K_BASE * kMult * weight * sum / (keys.length - 1);
        });

        const raceAt = new Date(race.raceAt);
        keys.forEach((k, i) => {
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
            });
            if (p.history.length > HISTORY_KEEP) p.history.shift();
        });

        if (race.source !== 'public' && race.guildId) {
            if (!guildActivity.has(race.guildId)) guildActivity.set(race.guildId, new Map());
            const act = guildActivity.get(race.guildId);
            for (const k of keys) act.set(k, raceAt.getTime());
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
    return { players, raceWeights };
}

module.exports = {
    START_RATING, K_BASE, ELO_SCALE, RATING_FLOOR, CHALLENGER_TOP, PLACEMENT_RACES, SOURCE_WEIGHT, LEVEL_THRESHOLDS,
    levelOf, expected, recompute,
};
