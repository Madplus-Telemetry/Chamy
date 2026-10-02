// models/RaceReport.js
// Mad+ uygulamasindan gelen yaris sonucu -- oyunun kendi yaris sonu tablosu
// (Photon PR event). Lobi -> Chamy (services/rating/madplus.pullReports).

const { Schema, model } = require('mongoose');

const reportEntrySchema = new Schema({
    position:   { type: Number, default: null },   // null = DNF
    actorNr:    { type: Number, default: 0 },
    nick:       { type: String, default: '' },
    madcarId:   { type: String, default: null },   // Madcar hesap ID'si (16 hex), biliniyorsa
    carId:      { type: Number, default: null },
    bestLap:    { type: String, default: '' },
    fastestLap: { type: Boolean, default: false },
    local:      { type: Boolean, default: false },  // raporu yollayan kisinin kendisi
    // Faz 1 (golge veri, rating'i etkilemez): telefonun telemetriden tahmin ettigi tur sureleri
    // ve sollama sayilari. Birden fazla raporlayicidan capraz dogrulanacak.
    lapTimesMs: { type: [Number], default: [] },
    overtakes:  { type: Number, default: 0 },
    overtaken:  { type: Number, default: 0 },
}, { _id: false });

const raceReportSchema = new Schema({
    reportKey:         { type: String, required: true, unique: true }, // `${bootId}:${seq}`
    reporterDiscordId: { type: String, default: '' },
    roomCode:          { type: String, default: '' },
    trackId:           { type: String, default: '' },
    finishedAt:        { type: Date, required: true },
    entries:           { type: [reportEntrySchema], default: [] },
}, { timestamps: true });

raceReportSchema.index({ finishedAt: 1 });

module.exports = model('RaceReport', raceReportSchema);
