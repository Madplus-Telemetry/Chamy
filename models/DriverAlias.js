// models/DriverAlias.js
// Bir ligde ayni surucunun farkli yazilislari -> tek kimlik.
// Sonuc tablolari cogu zaman resim ve etiketsiz; "Joci", "Joci33", "J_Cøi33"
// ayni kisi. userId varsa o hesaba, yoksa canonical ad anahtarina baglanir.
// Uye adindan tahminin ONUNE gecer (yanlis hesaba baglanmayi engeller).

const { Schema, model } = require('mongoose');

const driverAliasSchema = new Schema({
    guildId:   { type: String, required: true },
    name:      { type: String, required: true },   // normalize edilmis yazilis
    userId:    { type: String, default: null },    // biliniyorsa Discord hesabi
    canonical: { type: String, default: null },    // hesap yoksa: tek ad anahtari
    display:   { type: String, default: '' },      // gosterim adi
}, { timestamps: true });

driverAliasSchema.index({ guildId: 1, name: 1 }, { unique: true });

module.exports = model('DriverAlias', driverAliasSchema);
