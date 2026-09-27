const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const untouched = new Proxy({}, {
    get(_target, key) { throw new Error(`Unexpected dependency access: ${String(key)}`); },
});

function load(file, { env = {}, deps = {}, globals = {} } = {}) {
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
        module: mod,
        exports: mod.exports,
        process: { env },
        console: { log() {}, error() {} },
        AbortSignal,
        ...globals,
        require(name) {
            if (Object.hasOwn(deps, name)) return deps[name];
            if (name === './config' || name === '../services/rating/config') {
                return load('services/rating/config.js', { env });
            }
            if (name === 'discord.js') {
                return { ChannelType: {}, PermissionsBitField: { Flags: {} } };
            }
            return untouched;
        },
    }, { filename: file });
    return mod.exports;
}

test('rating stays paused unless the release switch explicitly enables it', () => {
    for (const value of [undefined, '', 'false', '0', '1', 'yes']) {
        assert.equal(load('services/rating/config.js', {
            env: { MADPLUS_RATING_ENABLED: value },
        }).isRatingEnabled(), false);
    }
    for (const value of ['true', ' TRUE ']) {
        assert.equal(load('services/rating/config.js', {
            env: { MADPLUS_RATING_ENABLED: value },
        }).isRatingEnabled(), true);
    }
});

test('direct imports and recomputes do not access Discord, MongoDB or HTTP while paused', async () => {
    const ingest = load('services/rating/ingest.js');
    const madplus = load('services/rating/madplus.js');
    assert.equal((await ingest.ingestGuild(untouched)).scanned, 0);
    assert.equal((await ingest.recomputeAll()).players, 0);
    assert.equal((await madplus.pullReports()).added, 0);
    assert.deepEqual(plain(await madplus.buildRaces(untouched)), []);
});

test('a paused rating snapshot clears stale app data without reading old MongoDB ratings', async () => {
    const sent = [];
    const madplus = load('services/rating/madplus.js', {
        env: { MADPLUS_LOBBY_URL: 'https://lobby.invalid', MADPLUS_LEAGUE_SYNC_KEY: 'test' },
        globals: { fetch: async (url, options) => {
            sent.push({ url, body: JSON.parse(options.body) });
            return { ok: true };
        } },
    });
    assert.equal((await madplus.pushRatings()).pushed, 0);
    assert.deepEqual(sent, [{ url: 'https://lobby.invalid/v1/ratings/sync', body: { drivers: [] } }]);
});

test('the release switch restores the existing Discord results import', async () => {
    const saved = [], cursors = [];
    const message = {
        id: 'race-message', content: 'Race results\n1 Alice\n2 Bob', embeds: [],
        attachments: new Map(), author: { bot: false },
        createdAt: new Date('2026-09-24T12:00:00Z'), createdTimestamp: 1,
    };
    const channel = {
        id: 'results-channel', name: 'results', type: 0,
        isTextBased: () => true, isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
        messages: { fetch: async () => new Map([['race-message', message]]) },
    };
    const guild = {
        id: 'madcar-guild', name: 'Madcar test', memberCount: 0,
        channels: { cache: new Map([['results-channel', channel]]) },
        members: { me: {}, cache: new Map() },
    };
    const ingest = load('services/rating/ingest.js', {
        env: { MADPLUS_RATING_ENABLED: 'true', GEMINI_API_KEY: 'test' },
        deps: {
            '../../models/ServerProfile': { findOne: () => ({ lean: async () => ({ games: ['Madcar'] }) }) },
            '../../models/ResultCursor': {
                findOne: () => ({ lean: async () => null }),
                updateOne: async (...args) => cursors.push(args),
            },
            '../../models/RaceResult': { updateOne: async (...args) => saved.push(args) },
            '../../lib/gemma': { generate: async () => JSON.stringify({
                isRaceResult: true, entries: [{ name: 'Alice' }, { name: 'Bob' }],
            }) },
            './identity': load('services/rating/identity.js', {
                deps: { '../../models/DriverAlias': { find: () => ({ lean: async () => [] }) } },
            }),
        },
    });
    assert.deepEqual(plain(await ingest.ingestGuild(guild)), { scanned: 1, added: 1 });
    assert.equal(saved.length, 1);
    assert.equal(saved[0][1].$setOnInsert.source, 'league');
    assert.equal(saved[0][1].$setOnInsert.entries.length, 2);
    assert.equal(cursors.length, 1);
});

test('paused scheduler only clears snapshots, including on later ticks', async () => {
    let pushes = 0, interval;
    const register = load('events/ratingSync.js', {
        deps: {
            '../services/rating/ingest': {
                ingestGuild: () => assert.fail('Discord import ran'),
                recomputeAll: () => assert.fail('DB recompute ran'),
            },
            '../services/rating/madplus': {
                pullReports: () => assert.fail('App import ran'),
                pushRatings: async () => { pushes++; return { pushed: 0 }; },
            },
        },
        globals: {
            setTimeout: () => assert.fail('Import startup scheduled while paused'),
            setInterval: fn => { interval = fn; return { unref() {} }; },
        },
    });
    register({ isReady: () => true });
    await new Promise(resolve => setImmediate(resolve));
    await interval();
    assert.equal(pushes, 2);
});

test('enabled scheduler restores imports and publishes even an empty recompute', async () => {
    const calls = [];
    let startup;
    const register = load('events/ratingSync.js', {
        env: { MADPLUS_RATING_ENABLED: 'true', GEMINI_API_KEY: 'test' },
        deps: {
            '../services/rating/ingest': {
                ingestGuild: async () => { calls.push('scan'); return { scanned: 0, added: 0 }; },
                recomputeAll: async () => { calls.push('recompute'); return { players: 0, races: 0 }; },
            },
            '../services/rating/madplus': {
                pullReports: async () => { calls.push('pull'); return { added: 0 }; },
                pushRatings: async () => { calls.push('push'); return { pushed: 0 }; },
            },
        },
        globals: {
            setTimeout: fn => { startup = fn; return { unref() {} }; },
            setInterval: () => ({ unref() {} }),
        },
    });
    register({ isReady: () => true, guilds: { cache: new Map([['g', { id: 'g' }]]) } });
    await startup();
    assert.deepEqual(calls, ['pull', 'scan', 'recompute', 'push']);
});

test('manual rating commands cannot refill or display stale ratings while paused', async () => {
    const builder = new Proxy({}, { get: () => () => builder });
    const command = load('commands/rating.js', {
        deps: {
            'discord.js': { SlashCommandBuilder: function () { return builder; }, PermissionsBitField: {} },
            '../services/rating/ingest': {},
        },
    });
    for (const sub of ['scan', 'recalc', 'show', 'top']) {
        let response;
        await command.execute({
            options: { getSubcommand: () => sub },
            reply: async value => { response = value; },
        });
        assert.match(response.content, /paused until the public release/);
        assert.equal(response.ephemeral, true);
    }
});

test('FACEIT levels, rating floor and challenger (L10 + top 10)', () => {
    const engine = load('services/rating/engine.js');
    const cases = [[100, 1], [500, 1], [501, 2], [750, 2], [751, 3], [900, 3], [901, 4], [1050, 4], [1051, 5],
        [1200, 5], [1201, 6], [1350, 6], [1351, 7], [1530, 7], [1531, 8], [1750, 8], [1751, 9], [2000, 9], [2001, 10], [2600, 10]];
    for (const [r, lv] of cases) assert.equal(engine.levelOf(r), lv, `rating ${r}`);

    // A always wins, Z always last: after many races A is on top, nobody is below the floor.
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'Z'];
    const races = [];
    for (let i = 0; i < 400; i++) {
        races.push({ _id: `r${i}`, source: 'league', guildId: 'g', memberCount: 700, raceAt: new Date(Date.UTC(2025, 0, 1) + i * 864e5),
            entries: names.map((n, k) => ({ key: n, name: n, position: k + 1 })) });
    }
    const { players } = engine.recompute(races);
    const a = players.get('A'), z = players.get('Z');
    assert.equal(a.rank, 1);
    assert.ok(z.rating >= engine.RATING_FLOOR);
    for (const p of players.values()) assert.equal(p.challenger, p.level >= 10 && p.rank <= engine.CHALLENGER_TOP);
    assert.ok([...players.values()].filter(p => p.challenger).length <= 10);
});
