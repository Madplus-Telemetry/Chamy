// models/RaceResult.js
// Tek bir yarisin bitis sirasi -- Mad+ rating'in ham verisi.
// source: 'league' (lig sonuc kanali), 'league_madplus' (lig + host Mad+ verisi),
//         'public' (Madcar public oda, Mad+ raporu).
// Rating her zaman bu kayitlardan BASTAN hesaplanir (services/rating/engine).

const { Schema, model } = require('mongoose');

const entrySchema = new Schema({
    position: { type: Number, default: 0 },
    key:      { type: String, required: true },   // 'u:<discordId>' veya 'n:<normalize ad>'
    userId:   { type: String, default: null },
    name:     { type: String, default: '' },
    dnf:      { type: Boolean, default: false },
}, { _id: false });

const raceResultSchema = new Schema({
    source:      { type: String, default: 'league' },
    guildId:     { type: String, default: '' },
    guildName:   { type: String, default: '' },
    channelId:   { type: String, default: '' },
    messageId:   { type: String, default: null },
    raceAt:      { type: Date, required: true },
    series:      { type: String, default: '' },
    track:       { type: String, default: '' },
    memberCount: { type: Number, default: 0 },
    entries:     { type: [entrySchema], default: [] },
    sourceMessageId: String,
    archiveJob: String,
    evidenceHash: String,
    archiveSeason: Number,
    archiveRound: Number,
    archiveType: String,
    supersededByArchive: String,
    ignored:     { type: Boolean, default: false },   // elle haric tutmak icin
}, { timestamps: true });

raceResultSchema.index({ messageId: 1 }, { unique: true, sparse: true });
raceResultSchema.index({ raceAt: 1 });

module.exports = model('RaceResult', raceResultSchema);

