// events/m25AliasFix.js
// ───────────────────────────────────────────────────────────────────────────
// TEK SEFERLIK: M25 sezon finali kayitlarindaki surucu kimliklerini duzeltir.
//
// 1) M25 alias tablosunu (DriverAlias) yazar. Eslesmeler elle dogrulandi:
//    #wall-of-champions etiketleri + S7'nin etiketli metin tablolari ile
//    resim tablolarindaki adlar sira/puan uzerinden karsilastirildi.
//    Bundan sonra normal sonuc taramasi da bu tabloyu kullanir.
// 2) Butun M25 RaceResult kayitlarini bu tabloyla yeniden anahtarlar
//    ("Joci33" yanlis hesaptan dogru hesaba, "Brunex6 | Reserve" -> Brunex...).
// 3) Sezon ayiraci olmadigi icin "S6 final" diye kaydedilen tablo aslinda
//    S7'nin 7. yaris sonrasi ara tablosu: haric tutulur (S7 finali wall'dan
//    zaten var), S6 finali wall-of-champions ilk 3'u ile eklenir.
// Isaret: onetimejobs { key: JOB_KEY }.
// ───────────────────────────────────────────────────────────────────────────

const mongoose    = require('mongoose');
const RaceResult  = require('../models/RaceResult');
const DriverAlias = require('../models/DriverAlias');
const { norm, resolve } = require('../services/rating/identity');

const JOB_KEY   = 'm25-alias-fix-v1';
const M25_GUILD = '1264284618727886858';

// Discord hesabi bilinen suruculer: userId -> [gosterim adi, ...yazilislar]
const BY_ID = {
    '974329678749925456':  ['KMoi21', 'K_Møi21', 'K_Møl21', 'KMo i21', 'Kmoi'],
    '1329798548270878772': ['Joci33', 'Joci', 'J_Cøi33'],
    '1238912410996441088': ['Leo5', 'Leo'],
    '1113145360769097738': ['Speedracer'],
    '1304232214426292265': ['Brunex', 'Brunex6'],
    '625988504148639746':  ['Tituu', 'Tituu77', 'Tituu33'],
    '1340440162605338777': ['CarlosGames', 'CarlosGamesYT'],
    '1190017157816385638': ['Subbie4th', 'Subble4th'],
    '1213777355852480552': ['AlexEspo08', 'Alexespo'],
    '1063678959318990898': ['Proton0', 'Proton'],
    '1420983569605726208': ['salami', 'salami16', 'clsalami16'],
    '1092852596340965527': ['Tonin'],
    '1365400427088056510': ['Endryel'],
    '1435403110603427840': ['Pierre'],
    '640269779361464336':  ['Mikaela'],
    '764279983681568803':  ['Richu7', 'Richu'],
    '555767059062194188':  ['Goatmeer'],
    '1390254736732717200': ['Kristian'],
    '1404540340542636263': ['Xant'],
    '1256602727929221192': ['Floppastappen', 'Flopastappen'],
    '695025251196862506':  ['Bemtevi'],
    '1148635712699240559': ['Kubson'],
    '1096081980862500874': ['ElWalter'],
};

// Hesabi bilinmeyen ama ayni kisi olan yazilislar: canonical -> [gosterim, ...yazilislar]
const BY_NAME = {
    jamcorp02:      ['Jamcorp02', 'JamcorpO2', 'Jamcorop'],
    kimiraikkonen7: ['Kimiraikkonen7', 'Kimiraikonnen7'],
};

// S6 finali (#wall-of-champions): Joci, Leo, Speedracer. Tarih: S6 son tablo gunu.
const S6_FINAL = {
    messageId: 'm25-fix:F1:S6',
    raceAt: new Date('2025-06-08T11:14:20.827Z'),
    ids: ['1329798548270878772', '1238912410996441088', '1113145360769097738'],
};
const S7_PARTIAL_MESSAGE = '1399318754432782407';

async function seedAliases() {
    const ops = [];
    for (const [userId, names] of Object.entries(BY_ID)) {
        for (const n of names) ops.push({ name: norm(n), userId, canonical: null, display: names[0] });
    }
    for (const [canonical, names] of Object.entries(BY_NAME)) {
        for (const n of names) ops.push({ name: norm(n), userId: null, canonical, display: names[0] });
    }
    await DriverAlias.bulkWrite(ops.map(o => ({
        updateOne: {
            filter: { guildId: M25_GUILD, name: o.name },
            update: { $set: { guildId: M25_GUILD, ...o } },
            upsert: true,
        },
    })), { ordered: false });
    return new Map(ops.map(o => [o.name, o]));
}

async function run() {
    const jobs = mongoose.connection.collection('onetimejobs');
    if (await jobs.findOne({ key: JOB_KEY })) return;

    const aliases = await seedAliases();
    const displayOf = id => BY_ID[id]?.[0] || '';

    // S6/S7 duzeltmesi
    await RaceResult.updateOne(
        { messageId: S7_PARTIAL_MESSAGE },
        { $set: { series: 'M25 F1 S7 WDC after R7 (partial)', ignored: true } },
    );
    await RaceResult.updateOne(
        { messageId: S6_FINAL.messageId },
        { $setOnInsert: {
            source: 'league', guildId: M25_GUILD, guildName: 'Madcar 25™', channelId: '1436834302150053998',
            messageId: S6_FINAL.messageId, raceAt: S6_FINAL.raceAt, series: 'M25 F1 S6 WDC final (top 3)',
            track: 'Season standings', memberCount: 686,
            entries: S6_FINAL.ids.map((id, i) => ({ key: `u:${id}`, userId: id, name: displayOf(id), dnf: false, position: i + 1 })),
        } },
        { upsert: true },
    );

    // Yeniden anahtarlama. Uye adi tahmini (index) bilerek kullanilmiyor:
    // yanlis eslesmenin kaynagi oydu; mevcut u: anahtarlari alias yoksa korunur.
    const races = await RaceResult.find({ guildId: M25_GUILD }).lean();
    let changed = 0;
    for (const race of races) {
        const seen = new Set();
        const entries = [];
        for (const e of race.entries || []) {
            let who = resolve(e.name, null, null, aliases);
            // Alias'ta yoksa eski kimlik (uye adindan bulunan hesap) kalsin.
            if (!who || (!aliases.has(norm(e.name)) && e.userId)) who = { key: e.key, userId: e.userId, name: who?.name ?? e.name };
            if (!who.name && who.userId) who.name = displayOf(who.userId);
            if (seen.has(who.key)) continue;
            seen.add(who.key);
            entries.push({ ...who, dnf: !!e.dnf, position: entries.length + 1 });
        }
        const before = JSON.stringify((race.entries || []).map(e => e.key));
        const after  = JSON.stringify(entries.map(e => e.key));
        if (before !== after || race.entries.some((e, i) => e.name !== entries[i]?.name)) {
            await RaceResult.updateOne({ _id: race._id }, { $set: { entries } });
            changed++;
        }
    }

    await jobs.updateOne({ key: JOB_KEY }, { $set: { key: JOB_KEY, doneAt: new Date(), aliases: aliases.size, changed } }, { upsert: true });
    console.log(`[M25-ALIAS] done: ${aliases.size} aliases, ${changed}/${races.length} races re-keyed`);
}

module.exports = (client) => {
    const start = () => setTimeout(() => {
        const go = () => run().catch(err => console.error('[M25-ALIAS] failed:', err.message));
        if (mongoose.connection.readyState === 1) go();
        else mongoose.connection.once('connected', go);
    }, 60 * 1000).unref?.();
    if (client.isReady?.()) start();
    else client.once('ready', start);
};
