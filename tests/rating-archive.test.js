const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractMessage, validateRace, raceIdentity } = require('../services/rating/archive');
const race = (round = 1) => ({ series: 'F1', season: 1, round, type: 'race', track: 'Monza', basis: 'explicit_positions', complete: true, entries: [{ position: 1, name: 'Joci' }, { position: 2, name: 'Tonin' }] });
test('same top six at different rounds and sprint remain distinct', () => {
    assert.notEqual(raceIdentity(race(1), 'a', 0), raceIdentity(race(2), 'b', 0));
    assert.notEqual(raceIdentity(race(), 'a', 0), raceIdentity({ ...race(), type: 'sprint' }, 'a', 1));
    assert.equal(raceIdentity(race(), 'a', 0), raceIdentity(race(), 'b', 0));
});
test('points, incomplete standings and duplicate positions cannot become races', () => {
    assert.equal(validateRace({ ...race(), basis: 'points' }), false);
    assert.equal(validateRace({ ...race(), complete: false }), false);
    assert.equal(validateRace({ ...race(), entries: [{ position: 1, name: 'A' }, { position: 1, name: 'B' }] }), false);
});
test('all images and races extracted, repeated round deduplicated', async () => {
    let count = 0;
    const msg = { attachments: new Map([1, 2, 3, 4].map(i => [i, { url: `image${i}`, contentType: 'image/png' }])), embeds: [] };
    const result = await extractMessage(msg, 'F1 S1', { fetchImage: async () => ({ base64: 'ok' }), generate: async () => JSON.stringify({ kind: 'results', races: [race(++count), race(9)] }) });
    assert.equal(count, 4); assert.equal(result.races.length, 5); assert.equal(result.needsReview, false);
});
test('download failures remain retryable errors', async () => {
    const msg = { attachments: new Map([[1, { url: 'broken', contentType: 'image/png' }]]), embeds: [] };
    await assert.rejects(extractMessage(msg, '', { fetchImage: async () => null }), /download failed/);
});
test('unreadable evidence requires review', async () => {
    const result = await extractMessage({ attachments: new Map(), embeds: [] }, '', { fetchImage: async () => null, generate: async () => JSON.stringify({ kind: 'unreadable', races: [race()] }) });
    assert.equal(result.needsReview, true);
});

test('season finals remain until every explicitly expected round is present', () => {
    const { completeSeason } = require('../services/rating/archive');
    assert.equal(completeSeason([1, 2], null), false);
    assert.equal(completeSeason([1, 3], 3), false);
    assert.equal(completeSeason([1, 2, 3], 3), true);
});
