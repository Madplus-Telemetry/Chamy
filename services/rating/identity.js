// services/rating/identity.js
// Sonuc tablosundaki bir ismi surucu kimligine cevirir.
// Sira: <@id> etiketi > lig alias tablosu (DriverAlias) > sunucu uye adi > ad anahtari.

const DriverAlias = require('../../models/DriverAlias');

// "K_Møi21" == "kmoi21", "𝐓𝐨𝐧𝐢𝐧" == "tonin"
const FOLD = { 'ø': 'o', 'Ø': 'o', 'æ': 'ae', 'Æ': 'ae', 'œ': 'oe', 'Œ': 'oe', 'ß': 'ss', 'ı': 'i', 'ł': 'l', 'Ł': 'l', 'đ': 'd', 'Đ': 'd', 'þ': 'th' };
const norm = s => String(s || '')
    .normalize('NFKC')
    .replace(/[øØæÆœŒßıłŁđĐþ]/g, c => FOLD[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** "Brunex6 | Reserve", "DK33 (R)" -> "Brunex6", "DK33" */
const cleanName = s => String(s || '')
    .replace(/<@!?\d+>/g, '')
    .replace(/\s*[|/\-–(\[]\s*(reserve|res|sub|substitute|r)\s*[)\]]?\s*$/i, '')
    .trim();

/** guildId -> Map(normName -> { userId, canonical, display }) */
async function loadAliases(guildId) {
    const rows = await DriverAlias.find({ guildId }).lean().catch(() => []);
    return new Map(rows.map(r => [r.name, r]));
}

/**
 * @param raw     tablodaki ad (etiket olabilir)
 * @param mention Gemma'nin verdigi userId (varsa)
 * @param index   uye adi -> id (memberIndex)
 * @param aliases loadAliases sonucu
 * @returns { key, userId, name } | null
 */
function resolve(raw, mention, index, aliases) {
    const name = cleanName(raw).slice(0, 60);
    const n = norm(name);
    const id = String(mention || raw || '').match(/\d{15,21}/)?.[0] || null;
    if (id) return { key: `u:${id}`, userId: id, name: name || String(raw || '') };
    const a = n && aliases?.get(n);
    if (a?.userId) return { key: `u:${a.userId}`, userId: a.userId, name: name || a.display };
    if (a?.canonical) return { key: `n:${a.canonical}`, userId: null, name: a.display || name };
    const uid = n && index?.get(n);
    if (uid) return { key: `u:${uid}`, userId: uid, name };
    return n ? { key: `n:${n}`, userId: null, name } : null;
}

module.exports = { norm, cleanName, loadAliases, resolve };
