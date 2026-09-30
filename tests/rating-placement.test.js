const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const engine = require('../services/rating/engine');

// Pure report assembly without MongoDB, Discord or an HTTP connection.
const mod = { exports: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../services/rating/madplus.js'), 'utf8'), {
    module: mod, exports: mod.exports,
    require: name => name === './engine' ? engine : {},
});
const { buildRacesFromReports } = mod.exports;
const ids = Array.from({ length: 12 }, (_, i) => String(100000000000000001n + BigInt(i)));
const names = ['Aster', 'Bruno', 'Cem', 'Deniz', 'Efe', 'Firat', 'Gizem', 'Hugo', 'Iris', 'Jules', 'Kaan', 'Luna'];
const key = i => `u:${ids[i]}`;
const start = Date.UTC(2026, 0, 1);
const day = 86400000;
const plain = x => JSON.parse(JSON.stringify(x));

function race(i, app = false, order = ids) {
    return {
        _id: `race:${i}`, source: app ? 'league_madplus' : 'league',
        appVerified: app, guildId: 'guild', memberCount: 700, raceAt: new Date(start + i * day),
        entries: order.map((id, index) => ({ key: `u:${id}`, userId: id, name: names[ids.indexOf(id)],
            position: index + 1, appRecorded: app, dnf: false })),
    };
}

function report(i, reporter = 0, at = start + i * day) {
    return {
        _id: `report:${i}:${reporter}`, roomCode: 'ROOM', trackId: 'monza',
        finishedAt: new Date(at), reporterDiscordId: ids[reporter],
        entries: ids.map((id, index) => ({ nick: names[index], madcarId: `car${index}`,
            position: index + 1, local: index === reporter, bestLap: '01:20.00' })),
    };
}

test('imported history halves the total, preserves history stats and never unlocks rank', () => {
    const { players } = engine.recompute(Array.from({ length: 40 }, (_, i) => race(i)));
    for (const p of players.values()) {
        assert.equal(p.scanContribution, Math.round(p.scanRating * 5) / 10);
        assert.equal(p.rating, Math.max(100, p.scanContribution));
        assert.equal(p.baseRating, p.rating);
        assert.equal(p.historicalRaces, 40);
        assert.equal(p.races, 0);
        assert.equal(p.appDelta, 0);
        assert.equal(p.placement, true);
        assert.equal(p.rank, null);
        assert.equal(p.challenger, false);
        assert.deepEqual(p.history, []);
    }
    assert.equal(players.get(key(0)).historicalWins, 40);
});

test('ninth app race stays unranked; tenth unlocks; full app deltas add to the half-history base', () => {
    const history = Array.from({ length: 39 }, (_, i) => race(i));
    const live = Array.from({ length: 10 }, (_, i) => race(100 + i, true));
    const nine = engine.recompute([...history, ...live.slice(0, 9)]).players.get(key(0));
    assert.equal(nine.races, 9);
    assert.equal(nine.historicalRaces, 39);
    assert.equal(nine.placement, true);
    assert.equal(nine.rank, null);
    assert.equal(nine.challenger, false);
    const all = [...history, ...live];
    const ten = engine.recompute(all).players.get(key(0));
    assert.equal(ten.races, 10);
    assert.equal(ten.placement, false);
    assert.equal(ten.rank, 1);
    assert.equal(ten.rating, Math.round((ten.baseRating + ten.appDelta) * 10) / 10);
    assert.ok(ten.appDelta > 0);
    assert.ok(Math.abs(ten.history.reduce((sum, h) => sum + h.delta, 0) - ten.appDelta) < 1);
    assert.equal(ten.history.length, 10);
    assert.deepEqual(plain(engine.recompute([...all].reverse()).players.get(key(0))), plain(ten));
    assert.deepEqual(plain(engine.recompute(all).players.get(key(0))), plain(ten));
});

test('app-only newcomers retain the 1000 start and poor performance loses points', () => {
    const p = engine.recompute([race(0, true)]).players.get(key(11));
    assert.equal(p.baseRating, 1000);
    assert.equal(p.scanContribution, 0);
    assert.equal(p.scanRating, null);
    assert.equal(p.historicalRaces, 0);
    assert.ok(p.appDelta < 0);
    assert.equal(p.races, 1);
});

test('source label alone and season tables never grant placement credit', () => {
    const noProof = race(0, true);
    noProof.appVerified = false;
    const season = { ...race(1, true), track: 'Season standings' };
    const p = engine.recompute([noProof, season]).players.get(key(0));
    assert.equal(p.races, 0);
    assert.equal(p.historicalRaces, 2);
    assert.equal(p.placement, true);
});

test('matched race scores the app driver once, and gives non-app drivers only historical credit', () => {
    const r = race(0, true);
    for (let i = 1; i < r.entries.length; i++) r.entries[i].appRecorded = false;
    const p = engine.recompute([r]).players;
    assert.equal(p.get(key(0)).races, 1);
    assert.equal(p.get(key(0)).historicalRaces, 0);
    assert.equal(p.get(key(1)).races, 0);
    assert.equal(p.get(key(1)).historicalRaces, 1);
});

test('multiple reports of one public race credit only each reporter once', () => {
    const reports = [report(0, 0), report(0, 1, start + 500), report(0, 0, start + 700)];
    const races = buildRacesFromReports([], reports, [], start + day);
    assert.equal(races.length, 1);
    const p = engine.recompute(races).players;
    assert.equal(p.size, 2);
    assert.equal(p.get(key(0)).races, 1);
    assert.equal(p.get(key(1)).races, 1);
    assert.equal(p.has(key(2)), false);
});

test('identical finishing orders on different days are distinct placement races', () => {
    const races = buildRacesFromReports([], [report(0), report(1)], [], start + 2 * day);
    assert.equal(races.length, 2);
    assert.equal(engine.recompute(races).players.get(key(0)).races, 2);
});

test('a Discord match and its app report do not produce two rated races', () => {
    const history = { ...race(0), track: 'monza' };
    const result = buildRacesFromReports([history], [report(0)], [], start + day);
    assert.equal(result.length, 1);
    assert.equal(result[0].source, 'league_madplus');
    const p = engine.recompute(result).players;
    assert.equal(p.get(key(0)).races, 1);
    assert.equal(p.get(key(0)).historicalRaces, 0);
    assert.equal(p.get(key(1)).races, 0);
});

test('a season table cannot consume an app race or complete placement', () => {
    const history = { ...race(0), track: 'Season standings' };
    const result = buildRacesFromReports([history], [report(0)], [], start + day);
    assert.equal(result.length, 2);
    const p = engine.recompute(result).players.get(key(0));
    assert.equal(p.historicalRaces, 1);
    assert.equal(p.races, 1);
});

test('missing, conflicting or ambiguous local identity never grants placement credit', () => {
    const a = report(0);
    a.entries.forEach(e => { e.local = false; });
    assert.equal(engine.recompute(buildRacesFromReports([], [a], [], start + day)).players.size, 0);
    const b = report(1);
    b.entries[1].local = true;
    assert.equal(engine.recompute(buildRacesFromReports([], [b], [], start + 2 * day)).players.size, 0);
    const c = report(2), d = report(2);
    d.reporterDiscordId = ids[1];
    assert.equal(engine.recompute(buildRacesFromReports([], [c, d], [], start + 3 * day)).players.size, 0);
});

test('public grace period and ignored results are still respected', () => {
    assert.equal(buildRacesFromReports([], [report(0)], [], start + 1000).length, 0);
    const r = { ...race(0, true), ignored: true };
    assert.equal(engine.recompute([r]).players.size, 0);
});

test('unclassified results rank by best lap; one lap alone is not enough', () => {
    const lapReport = (laps, positions = null) => {
        const r = report(0);
        r.entries = r.entries.slice(0, 3).map((e, i) => ({ ...e, position: positions ? positions[i] : null, bestLap: laps[i] }));
        return r;
    };
    // nobody classified, real laps -> ranked by lap, nobody is DNF
    const a = buildRacesFromReports([], [lapReport(['01:22.00', '01:20.50', '01:21.00'])], [], start + day)[0];
    assert.deepEqual(plain(a.entries.map(e => e.name)), ['Bruno', 'Cem', 'Aster']);
    assert.ok(a.entries.every(e => !e.dnf));
    // only one real lap -> old behaviour, everyone DNF
    const b = buildRacesFromReports([], [lapReport(['01:22.00', '00:00.000', ''])], [], start + day)[0];
    assert.ok(b.entries.every(e => e.dnf));
    // classified drivers stay ahead; null ones are DNF, ordered by lap
    const c = buildRacesFromReports([], [lapReport(['01:30.00', '01:20.00', '01:19.00'], [1, null, null])], [], start + day)[0];
    assert.deepEqual(plain(c.entries.map(e => e.name)), ['Aster', 'Cem', 'Bruno']);
    assert.deepEqual(plain(c.entries.map(e => e.dnf)), [false, true, true]);
});

test('public race counts 30 minutes after the finish', () => {
    assert.equal(buildRacesFromReports([], [report(0)], [], start + 20 * 60000).length, 0);
    assert.equal(buildRacesFromReports([], [report(0)], [], start + 31 * 60000).length, 1);
});
