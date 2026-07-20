// DB export/import decision rules (src/db/transfer-rules.js) - M10, offline.
// Manifest contract, PK-range chunk planning, the excluded-tables policy
// (with its NON-NEGOTIABLE migration-table exclusion), path safety for any
// URL-parameter-derived filename, FK-safe apply ordering, and the resumable
// import cursor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    MANIFEST_SCHEMA, parseManifest,
    chunkPlan,
    DEFAULT_EXCLUDED_TABLES, resolveExcluded,
    safeExportFilename,
    fkSafeOrder,
    nextCursor,
} from '../src/db/transfer-rules.js';

// --- manifest ------------------------------------------------------------

const validManifest = {
    version: 1,
    created_at: '2026-07-20T10:00:00.000Z',
    database: 'oddspro',
    schema_head: '20260719000019_sms_campaigns.js',
    tables: [
        { name: 'leagues', rows: 120, chunks: 1, pk: 'id' },
        { name: 'teams', rows: 5000, chunks: 1, pk: 'id' },
    ],
    excluded: ['users', 'sessions'],
};

test('parseManifest accepts a well-formed manifest', () => {
    const r = parseManifest(validManifest);
    assert.equal(r.ok, true);
    assert.deepEqual(r.manifest, validManifest);
});

test('parseManifest never throws and reports a human-readable error on garbage', () => {
    for (const bad of [undefined, null, {}, [], 'nope', 42, { ...validManifest, version: 2 }]) {
        const r = parseManifest(bad);
        assert.equal(r.ok, false);
        assert.equal(typeof r.error, 'string');
        assert.ok(r.error.length > 0);
    }
});

test('parseManifest rejects a manifest with a malformed table entry', () => {
    const r = parseManifest({ ...validManifest, tables: [{ name: 'leagues' }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /rows|chunks|pk/);
});

test('parseManifest coerces numeric-looking strings for rows/chunks (tolerant of hand edits)', () => {
    const r = parseManifest({
        ...validManifest,
        tables: [{ name: 'leagues', rows: '120', chunks: '1', pk: 'id' }],
    });
    assert.equal(r.ok, true);
    assert.equal(r.manifest.tables[0].rows, 120);
});

test('MANIFEST_SCHEMA is exported and usable directly', () => {
    assert.equal(typeof MANIFEST_SCHEMA.safeParse, 'function');
});

// --- chunk planning --------------------------------------------------------

test('chunkPlan returns [] for an empty table (minId == null)', () => {
    assert.deepEqual(chunkPlan({ minId: null, maxId: null, chunkSize: 5000 }), []);
    assert.deepEqual(chunkPlan({ minId: null, maxId: 10, chunkSize: 5000 }), []);
});

test('chunkPlan handles a single-row table', () => {
    assert.deepEqual(chunkPlan({ minId: 7, maxId: 7, chunkSize: 5000 }), [{ from: 7, to: 7 }]);
});

test('chunkPlan handles a chunk size larger than the range (one chunk, ends at maxId)', () => {
    assert.deepEqual(chunkPlan({ minId: 1, maxId: 100, chunkSize: 5000 }), [{ from: 1, to: 100 }]);
});

test('chunkPlan splits an exact multiple of chunkSize', () => {
    assert.deepEqual(chunkPlan({ minId: 1, maxId: 20, chunkSize: 10 }), [
        { from: 1, to: 10 }, { from: 11, to: 20 },
    ]);
});

test('chunkPlan pins the LAST range to end exactly at maxId even with a remainder', () => {
    assert.deepEqual(chunkPlan({ minId: 1, maxId: 25, chunkSize: 10 }), [
        { from: 1, to: 10 }, { from: 11, to: 20 }, { from: 21, to: 25 },
    ]);
});

test('chunkPlan works over a non-1 starting minId (e.g. a table with gaps)', () => {
    assert.deepEqual(chunkPlan({ minId: 500, maxId: 512, chunkSize: 5 }), [
        { from: 500, to: 504 }, { from: 505, to: 509 }, { from: 510, to: 512 },
    ]);
});

test('chunkPlan throws a TypeError on a non-positive-integer chunkSize (programmer error)', () => {
    assert.throws(() => chunkPlan({ minId: 1, maxId: 10, chunkSize: 0 }), TypeError);
    assert.throws(() => chunkPlan({ minId: 1, maxId: 10, chunkSize: -5 }), TypeError);
    assert.throws(() => chunkPlan({ minId: 1, maxId: 10, chunkSize: 1.5 }), TypeError);
    assert.throws(() => chunkPlan({ minId: 1, maxId: 10, chunkSize: 'lots' }), TypeError);
    assert.throws(() => chunkPlan({ minId: 1, maxId: 10, chunkSize: undefined }), TypeError);
});

// --- excluded tables ---------------------------------------------------------

test('DEFAULT_EXCLUDED_TABLES is frozen and matches the spec decision-12 list', () => {
    assert.ok(Object.isFrozen(DEFAULT_EXCLUDED_TABLES));
    assert.deepEqual([...DEFAULT_EXCLUDED_TABLES].sort(), [
        'knex_migrations', 'knex_migrations_lock', 'otp_codes', 'sessions',
        'user_prefs', 'users', 'visit_events', 'visit_sessions', 'visitor_devices',
        'visitors', 'visits',
    ]);
});

test('resolveExcluded returns the defaults, deduped and sorted, with no argument', () => {
    assert.deepEqual(resolveExcluded(), [...DEFAULT_EXCLUDED_TABLES].sort());
    assert.deepEqual(resolveExcluded([]), [...DEFAULT_EXCLUDED_TABLES].sort());
});

test('resolveExcluded unions caller-supplied names, deduped and sorted', () => {
    const r = resolveExcluded(['sms_campaign_recipients', 'users', 'ip_geo']);
    assert.deepEqual(r, [...new Set([...DEFAULT_EXCLUDED_TABLES, 'sms_campaign_recipients', 'ip_geo'])].sort());
    // No duplicate of a name already in both the defaults and the caller list.
    assert.equal(r.filter(t => t === 'users').length, 1);
});

test('resolveExcluded NEVER drops knex_migrations/knex_migrations_lock, even given an unrelated caller list', () => {
    // The API is additive-only (no "un-exclude" input exists), so the strongest
    // reachable test is: no matter what the caller supplies, both migration
    // bookkeeping tables are always present in the result.
    for (const userExcluded of [[], ['teams'], ['leagues', 'standings'], undefined, null, 'not-an-array', {}]) {
        const r = resolveExcluded(userExcluded);
        assert.ok(r.includes('knex_migrations'), `missing for ${JSON.stringify(userExcluded)}`);
        assert.ok(r.includes('knex_migrations_lock'), `missing for ${JSON.stringify(userExcluded)}`);
    }
});

test('resolveExcluded is total against junk input (non-array coerces to empty additions)', () => {
    assert.deepEqual(resolveExcluded('users'), [...DEFAULT_EXCLUDED_TABLES].sort());
    assert.deepEqual(resolveExcluded(42), [...DEFAULT_EXCLUDED_TABLES].sort());
    assert.deepEqual(resolveExcluded({ users: true }), [...DEFAULT_EXCLUDED_TABLES].sort());
});

// --- path safety -------------------------------------------------------------

test('safeExportFilename accepts plain, single-segment names', () => {
    assert.equal(safeExportFilename('manifest.json'), 'manifest.json');
    assert.equal(safeExportFilename('matches.0004.ndjson.gz'), 'matches.0004.ndjson.gz');
    assert.equal(safeExportFilename('20260720_101500'), '20260720_101500');
    assert.equal(safeExportFilename('20260720_101500-pre-import'), '20260720_101500-pre-import');
});

test('safeExportFilename rejects traversal segments', () => {
    assert.equal(safeExportFilename('../etc/passwd'), null);
    assert.equal(safeExportFilename('..'), null);
    assert.equal(safeExportFilename('a/../b'), null);
    assert.equal(safeExportFilename('..\\windows'), null);
});

test('safeExportFilename rejects absolute paths (POSIX and Windows)', () => {
    assert.equal(safeExportFilename('/etc/passwd'), null);
    assert.equal(safeExportFilename('C:\\Windows\\System32'), null);
    assert.equal(safeExportFilename('\\\\server\\share'), null);
});

test('safeExportFilename rejects the empty string and non-strings', () => {
    assert.equal(safeExportFilename(''), null);
    assert.equal(safeExportFilename(undefined), null);
    assert.equal(safeExportFilename(null), null);
    assert.equal(safeExportFilename(42), null);
    assert.equal(safeExportFilename({}), null);
});

test('safeExportFilename rejects a leading dot and embedded slashes/spaces', () => {
    assert.equal(safeExportFilename('.hidden'), null);
    assert.equal(safeExportFilename('foo/bar'), null);
    assert.equal(safeExportFilename('foo bar'), null);
});

// --- FK-safe order -----------------------------------------------------------

test('fkSafeOrder orders a diamond dependency: parents before children', () => {
    // d depends on b and c, which both depend on a.
    const order = fkSafeOrder(['d', 'b', 'c', 'a'], { b: ['a'], c: ['a'], d: ['b', 'c'] });
    assert.deepEqual(order, ['a', 'b', 'c', 'd']);
});

test('fkSafeOrder is deterministic: same inputs -> same output regardless of input array order', () => {
    const deps = { b: ['a'], c: ['a'], d: ['b', 'c'] };
    const o1 = fkSafeOrder(['d', 'b', 'c', 'a'], deps);
    const o2 = fkSafeOrder(['a', 'b', 'c', 'd'], deps);
    const o3 = fkSafeOrder(['c', 'a', 'd', 'b'], deps);
    assert.deepEqual(o1, o2);
    assert.deepEqual(o2, o3);
});

test('fkSafeOrder breaks ties by table name for independent tables', () => {
    // No dependencies at all - every table is "ready" in round 1.
    assert.deepEqual(fkSafeOrder(['zeta', 'alpha', 'mid'], {}), ['alpha', 'mid', 'zeta']);
});

test('fkSafeOrder ignores dependencies on tables outside the given set', () => {
    // 'teams' depends on 'external_thing' which is not part of this plan -
    // it must not block teams from ever becoming ready.
    const order = fkSafeOrder(['teams', 'leagues'], { teams: ['external_thing', 'leagues'] });
    assert.deepEqual(order, ['leagues', 'teams']);
});

test('fkSafeOrder throws a TypeError naming the cycle members', () => {
    assert.throws(
        () => fkSafeOrder(['a', 'b'], { a: ['b'], b: ['a'] }),
        (err) => err instanceof TypeError && /a/.test(err.message) && /b/.test(err.message),
    );
});

test('fkSafeOrder throws on a longer cycle embedded among acyclic tables', () => {
    // x -> y -> z -> x is a cycle; 'standalone' has no deps and is unrelated.
    assert.throws(
        () => fkSafeOrder(['standalone', 'x', 'y', 'z'], { x: ['z'], y: ['x'], z: ['y'] }),
        TypeError,
    );
});

test('fkSafeOrder returns [] for an empty table list', () => {
    assert.deepEqual(fkSafeOrder([], {}), []);
});

// --- resumable import cursor -------------------------------------------------

const cursorManifest = {
    ...validManifest,
    tables: [
        { name: 'leagues', rows: 120, chunks: 2, pk: 'id' },
        { name: 'teams', rows: 5000, chunks: 3, pk: 'id' },
        { name: 'standings', rows: 0, chunks: 0, pk: 'id' },
    ],
};

test('nextCursor starts at the first table/chunk when nothing is done', () => {
    assert.deepEqual(nextCursor(cursorManifest, []), { table: 'leagues', chunk: 0 });
});

test('nextCursor resumes mid-table', () => {
    const done = [{ table: 'leagues', chunk: 0 }, { table: 'leagues', chunk: 1 }, { table: 'teams', chunk: 0 }];
    assert.deepEqual(nextCursor(cursorManifest, done), { table: 'teams', chunk: 1 });
});

test('nextCursor skips a table with zero chunks (empty table)', () => {
    const done = [
        { table: 'leagues', chunk: 0 }, { table: 'leagues', chunk: 1 },
        { table: 'teams', chunk: 0 }, { table: 'teams', chunk: 1 }, { table: 'teams', chunk: 2 },
    ];
    // 'standings' has 0 chunks and must be skipped entirely - nothing left.
    assert.equal(nextCursor(cursorManifest, done), null);
});

test('nextCursor returns null once every table is fully applied', () => {
    const done = [
        { table: 'leagues', chunk: 0 }, { table: 'leagues', chunk: 1 },
        { table: 'teams', chunk: 0 }, { table: 'teams', chunk: 1 }, { table: 'teams', chunk: 2 },
    ];
    assert.equal(nextCursor(cursorManifest, done), null);
});

test('nextCursor is total against a malformed manifest/done pair', () => {
    assert.equal(nextCursor(null, null), null);
    assert.equal(nextCursor({}, undefined), null);
    assert.equal(nextCursor({ tables: 'nope' }, []), null);
    assert.deepEqual(nextCursor(cursorManifest, null), { table: 'leagues', chunk: 0 });
});
