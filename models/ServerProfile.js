// models/ServerProfile.js
// Chamy'nin sunucu başına öğrendiği yapılandırılmış profil — owner, staff,
// race host'ları, yarış düzeni, takvim, puan tablosu, aktivite özeti.
// services/serverProfile.js yazar; events/ommy.js okur (prompt context +
// get_server_profile tool).

const { Schema, model } = require('mongoose');

const personSchema = new Schema({
    userId: { type: String, default: '' },
    name:   { type: String, default: '' },
    detail: { type: String, default: '' },   // rol adı, host kanıtı vs.
    score:  { type: Number, default: 0 },    // rol pozisyonu / mesaj sayısı / confidence
}, { _id: false });

const eventSchema = new Schema({
    title:     { type: String, default: '' },
    series:    { type: String, default: '' },
    track:     { type: String, default: '' },
    startsAt:  { type: Date,   default: null },
    timeText:  { type: String, default: '' },   // saat çözülemediyse yazıldığı hali
    host:      { type: String, default: '' },
    source:    { type: String, default: 'message' }, // discord_event | message
    sourceUrl: { type: String, default: '' },
}, { _id: false });

const standingRowSchema = new Schema({
    position: { type: Number, default: null },
    name:     { type: String, default: '' },
    team:     { type: String, default: '' },
    points:   { type: Number, default: null },
}, { _id: false });

const standingSchema = new Schema({
    series: { type: String, default: '' },
    asOf:   { type: Date,   default: null },
    rows:   { type: [standingRowSchema], default: [] },
}, { _id: false });

const leagueSchema = new Schema({
    name:   { type: String, default: '' },
    format: { type: String, default: '' },
    status: { type: String, default: '' },
}, { _id: false });

const serverProfileSchema = new Schema({
    guildId:        { type: String, required: true, unique: true },
    guildName:      { type: String, default: '' },
    ownerId:        { type: String, default: '' },
    ownerName:      { type: String, default: '' },
    memberCount:    { type: Number, default: 0 },
    timezone:       { type: String, default: '' },     // IANA, örn. Europe/Istanbul
    timezoneManual: { type: Boolean, default: false }, // Commander sabitlediyse AI ezmez
    games:          { type: [String], default: [] },   // sunucunun oynadığı oyunlar (Gemma) — Mad+ Leagues filtresi
    inviteUrl:      { type: String, default: '' },     // Chamy'nin olusturdugu suresiz davet (vanity yoksa)

    staff:         { type: [personSchema], default: [] },
    hosts:         { type: [personSchema], default: [] },
    activeMembers: { type: [personSchema], default: [] },
    peakHoursUtc:  { type: [Number], default: [] },
    busiestDays:   { type: [String], default: [] },

    raceSchedule: {
        summary: { type: String,   default: '' },
        days:    { type: [String], default: [] },
        times:   { type: [String], default: [] },
    },
    leagues:   { type: [leagueSchema],   default: [] },
    // Yonetici elle duzelttiyse AI/otomatik yenileme ezmez. status: active|upcoming|finished|removed
    leagueOverrides: { type: [leagueSchema], default: [] },
    calendar:  { type: [eventSchema],    default: [] },
    standings: { type: [standingSchema], default: [] },
    notes:     { type: [String],         default: [] },

    refreshedAt: { type: Date,   default: null },
    lastError:   { type: String, default: '' },
}, { timestamps: true });

module.exports = model('ServerProfile', serverProfileSchema);
