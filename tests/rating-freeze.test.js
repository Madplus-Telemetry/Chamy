const assert = require('node:assert/strict');
const { test } = require('node:test');
const engine = require('../services/rating/engine');

const names = ['A', 'B', 'C', 'D', 'E', 'F'];
function race(i, order = names) {
    return {
        _id: `r${i}`, source: 'league_madplus', appVerified: true, guildId: 'g', memberCount: 700,
        raceAt: new Date(Date.UTC(2026, 0, 1) + i * 864e5),
        entries: order.map((n, k) => ({ key: `u:${n}`, userId: n, appRecorded: true, name: n, position: k + 1 })),
    };
}
const rating = (res, k) => res.players.get(`u:${k}`).rating;
const toMap = freezes => new Map(freezes.map(f => [f.freezeId, JSON.parse(JSON.stringify(f))]));

test('first compute emits a freeze for every race and changes nothing', () => {
    const races = Array.from({ length: 15 }, (_, i) => race(i));
    const plain = engine.recompute(races);
    const withOpts = engine.recompute(races, { frozen: new Map() });
    assert.equal(rating(plain, 'A'), rating(withOpts, 'A'));
    assert.ok(withOpts.freezes.filter(f => f.ledger === 'app').length === 15);
});

test('frozen races keep their deltas when later races change the field', () => {
    const early = Array.from({ length: 12 }, (_, i) => race(i));
    const first = engine.recompute(early);
    const frozen = toMap(first.freezes);
    const history = first.players.get('u:B').history.map(h => h.delta);

    // Without freeze, adding a late race where B and others get very different results
    // would not touch earlier deltas either, so also rewrite the past ordering of rating
    // by adding an EARLIER race that shifts everyone's rating.
    const earlier = { ...race(-5, [...names].reverse()), _id: 'rEarly' };
    const unfrozen = engine.recompute([earlier, ...early]);
    const frozenRun = engine.recompute([earlier, ...early], { frozen });

    const keep = frozenRun.players.get('u:B').history.map(h => h.delta);
    // the 12 original races carry the exact deltas they had at first compute
    assert.deepEqual(keep.slice(-12).slice(-history.length), history.slice(-keep.slice(-12).length));
    assert.notEqual(rating(unfrozen, 'B'), rating(first, 'B'));
});

test('changed race results are recomputed instead of reusing a stale freeze', () => {
    const races = Array.from({ length: 12 }, (_, i) => race(i));
    const frozen = toMap(engine.recompute(races).freezes);
    const fixed = races.map((r, i) => i === 3 ? race(3, [...names].reverse()) : r);
    const res = engine.recompute(fixed, { frozen });
    const redo = res.freezes.filter(f => f.ledger === 'app');
    assert.deepEqual(redo.map(f => f.raceId), ['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'].slice(0, 1));
});

test('a repeated run with freezes reproduces the same ratings and emits nothing', () => {
    const races = Array.from({ length: 20 }, (_, i) => race(i, i % 3 ? names : [...names].reverse()));
    const first = engine.recompute(races);
    const second = engine.recompute(races, { frozen: toMap(first.freezes) });
    assert.equal(second.freezes.length, 0);
    for (const n of names) assert.equal(rating(second, n), rating(first, n));
});
