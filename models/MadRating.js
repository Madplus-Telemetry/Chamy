// models/MadRating.js
// Mad+ surucu rating'i -- services/rating/engine.recompute() ciktisi.
// Elle yazilmaz; her hesaplamada RaceResult'lardan bastan uretilir.

const { Schema, model } = require('mongoose');

const historySchema = new Schema({
    raceId: String,
    at:     Date,
    delta:  Number,
    rating: Number,
    weight: Number,
    place:  Number,
    field:  Number,
}, { _id: false });

const madRatingSchema = new Schema({
    key:        { type: String, required: true, unique: true },
    userId:     { type: String, default: null, index: true },
    name:       { type: String, default: '' },
    rating:     { type: Number, default: 1000 },
    level:      { type: Number, default: 4 },
    races:      { type: Number, default: 0 },
    wins:       { type: Number, default: 0 },
    podiums:    { type: Number, default: 0 },
    peak:       { type: Number, default: 1000 },
    placement:  { type: Boolean, default: true },   // ilk 10 yaris
    rank:       { type: Number, default: null },    // yerlesmis suruculer arasinda sira
    challenger: { type: Boolean, default: false },  // Level 10 + ilk 10
    history:    { type: [historySchema], default: [] },
    lastRaceAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = model('MadRating', madRatingSchema);
