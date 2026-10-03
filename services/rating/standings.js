// services/rating/standings.js
// Son hesaplamadaki yaris siralamalari (raceId -> { track, at, results }).
// recomputeAll yazar, pushRatings lobiye gonderir. Bellekte tutulur; bot yeni
// acildiysa bos kalir ve lobi onceki tabloyu korur.

let latest = new Map();

module.exports = {
    set(map) { latest = map instanceof Map ? map : new Map(); },
    get() { return latest; },
};
