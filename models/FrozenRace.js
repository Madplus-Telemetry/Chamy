// models/FrozenRace.js
// Yaris aninda hesaplanan rating degisimleri (FACEIT/Elo tarzi): yaris bir kez
// o anki rating'lerle hesaplanir ve dondurulur; sonradan baska surucularin
// rating'i degisse de eski yarislar yeniden hesaplanmaz.
const mongoose = require('mongoose');

const frozenRaceSchema = new mongoose.Schema({
    freezeId:    { type: String, required: true, unique: true },   // "<ledger>:<raceId>"
    ledger:      { type: String, enum: ['scan', 'app'], required: true },
    raceId:      { type: String, required: true },
    entriesHash: { type: String, required: true },   // sonuclar degisirse yeniden hesaplanir
    weight:      { type: Number, required: true },
    deltas:      { type: [[mongoose.Schema.Types.Mixed]], default: [] },   // [[key, delta], ...]
    info:        { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

module.exports = mongoose.models.FrozenRace || mongoose.model('FrozenRace', frozenRaceSchema);
