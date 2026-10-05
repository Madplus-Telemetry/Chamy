// models/BreakReminder.js
// Last break-reminder DM sent to a driver (events/breakReminder.js).
// Persisted so a restart never re-sends a reminder for the same session.

const { Schema, model } = require('mongoose');

module.exports = model('BreakReminder', new Schema({
    userId:     { type: String, required: true, unique: true },
    level:      { type: Number, default: 0 },     // 1 = soft (2h), 2 = firm (4h)
    lastSentAt: { type: Date, default: null },
}, { timestamps: true }));
