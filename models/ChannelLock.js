const mongoose = require('mongoose');

// Snapshot of the SendMessages overwrite state taken right before a channel is locked,
// so unlock can put every overwrite back exactly as it was.
// state: true = explicit allow, false = explicit deny, null = neutral / no overwrite
const channelLockSchema = new mongoose.Schema({
    channelId:  { type: String, required: true, unique: true },
    guildId:    { type: String, default: '' },
    overwrites: [{
        _id:   false,
        id:    { type: String, required: true },
        state: { type: Boolean, default: null },
    }],
}, { timestamps: true });

module.exports = mongoose.model('ChannelLock', channelLockSchema);
