// lib/antiraid/configStore.js
// Antiraid config'i 60 sn onbellekli okur. Hot path (her join / her silme) her
// seferinde Mongo'ya gitmesin diye. GlobalBan listesini de ayni sekilde cache'ler.

const AntiraidConfig = require('../../models/AntiraidConfig');
const GlobalBan = require('../../models/GlobalBan');

const DEFAULTS = {
    enabled: false,
    joinWindowMs: 10_000,
    joinThreshold: 6,
    minAccountAgeMs: 7 * 24 * 60 * 60 * 1000,
    nukeWindowMs: 10_000,
    nukeThreshold: 4,
    whitelistUserIds: [],
    whitelistRoleIds: [],
    alertChannelId: null,
    toneScan: false,
    toneCursors: {},
};

const cache = new Map(); // guildId -> { cfg, at }
const TTL_MS = 60_000;

async function get(guildId) {
    const hit = cache.get(guildId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.cfg;
    let doc = null;
    try {
        doc = await AntiraidConfig.findOne({ guildId }).lean();
    } catch (err) {
        if (hit) return hit.cfg; // Mongo hiccup: stale cache
        console.error('[ANTIRAID] config load failed:', err.message);
        return { ...DEFAULTS, guildId };
    }
    const cfg = { ...DEFAULTS, ...(doc || {}), guildId };
    cache.set(guildId, { cfg, at: Date.now() });
    return cfg;
}

function invalidate(guildId) {
    if (guildId) cache.delete(guildId); else cache.clear();
}

function isWhitelisted(cfg, userId, roleCache) {
    if (cfg.whitelistUserIds?.includes(userId)) return true;
    if (roleCache && cfg.whitelistRoleIds?.length) {
        for (const rid of cfg.whitelistRoleIds) if (roleCache.has(rid)) return true;
    }
    return false;
}

// --- Global ban listesi (kesin raid hesaplari) ---
let globalBanCache = { ids: new Set(), manual: new Set(), at: 0 };
const GLOBAL_TTL_MS = 120_000;

async function globalBanSet() {
    if (Date.now() - globalBanCache.at < GLOBAL_TTL_MS) return globalBanCache.ids;
    try {
        // Sadece kesinler: elle eklenenler ya da 2+ ayri sunucuda raide karisanlar.
        // Tek sunucuda gorulen hesap o sunucuda zaten banli; baska yerde atilmaz.
        const rows = await GlobalBan.find(
            { $or: [{ addedBy: { $ne: 'auto' } }, { 'hitGuilds.1': { $exists: true } }] },
            { userId: 1, addedBy: 1 },
        ).lean();
        globalBanCache = {
            ids: new Set(rows.map(r => r.userId)),
            // Bot sahibinin elle ekledikleri: antiraid acik olmasa bile her sunucuda uygulanir.
            manual: new Set(rows.filter(r => r.addedBy && r.addedBy !== 'auto').map(r => r.userId)),
            at: Date.now(),
        };
    } catch (err) {
        console.error('[ANTIRAID] global ban load failed:', err.message);
    }
    return globalBanCache.ids;
}

/** Cache yuklendikten sonra: bu hesap bot sahibinin elle ekledigi bir global ban mi? */
function isManualGlobalBan(userId) {
    return globalBanCache.manual.has(userId);
}

function invalidateGlobalBans() { globalBanCache.at = 0; }

module.exports = {
    DEFAULTS, get, invalidate,
    isWhitelisted, globalBanSet, invalidateGlobalBans,
};
