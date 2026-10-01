// models/GlobalBanRequest.js
// Bir sunucu admininin actigi global ban istegi. Istegi acan sunucuda hesap aninda
// banlanir; diger sunuculara (hesap orada uyeyse ya da sonradan girerse) moderator
// kanalinda soru sorulur. Her sunucunun karari targets icinde tutulur.

const mongoose = require('mongoose');

const TargetSchema = new mongoose.Schema({
    guildId:   { type: String, required: true },
    channelId: { type: String, default: null },
    messageId: { type: String, default: null },
    // pending | banned | skipped
    status:    { type: String, default: 'pending' },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
}, { _id: false });

const GlobalBanRequestSchema = new mongoose.Schema({
    userId:          { type: String, required: true, index: true },
    reason:          { type: String, default: '' },
    fromGuildId:     { type: String, required: true },
    fromGuildName:   { type: String, default: '' },
    requestedBy:     { type: String, required: true },
    requestedByName: { type: String, default: '' },
    targets:         { type: [TargetSchema], default: [] },
    createdAt:       { type: Date, default: Date.now },
    // 30 gun sonra istek kendiliginden silinir (Mongo TTL).
    expiresAt:       { type: Date, required: true },
}, { collection: 'antiraid_globalban_requests' });

GlobalBanRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.GlobalBanRequest
    || mongoose.model('GlobalBanRequest', GlobalBanRequestSchema);
