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
    exportStamp, stampToIso,
    chunkFileName, chunkSizeFor,
    isIntegerPkType,
    ndjsonLine,
    formatBytes,
    buildExportListing,
    exportRequestSchema,
    buildUploadPlan,
    buildFkDeps,
    importConfirmPhrase, matchesImportConfirm,
    importApplySchema,
    shouldSkipSafetyExport,
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

// --- parseManifest string-tolerance (Task 4 fold-in fix) --------------------
// parseManifest previously required an ALREADY-PARSED object despite the
// `raw` param name and the "hand-edited manifest is external data / never
// throws" intent - the apply-time staged-file re-read needs to hand it the
// raw file TEXT. These prove the string path round-trips and never throws.

test('parseManifest accepts a manifest passed as a JSON STRING (the staged manifest.json file text)', () => {
    const r = parseManifest(JSON.stringify(validManifest));
    assert.equal(r.ok, true);
    assert.deepEqual(r.manifest, validManifest);
});

test('parseManifest NEVER THROWS on a malformed JSON string - reports ok:false with a human-readable error', () => {
    for (const bad of ['{not valid json', '', '   ', '[1,2,', 'undefined', '{"a":}']) {
        assert.doesNotThrow(() => parseManifest(bad));
        const r = parseManifest(bad);
        assert.equal(r.ok, false);
        assert.equal(typeof r.error, 'string');
        assert.ok(r.error.length > 0);
    }
});

test('parseManifest treats a well-formed-JSON-but-wrong-shape string the same as the object case', () => {
    // '42' and '"nope"' are both valid JSON that parse to a non-object -
    // schema validation (not JSON.parse) is what rejects these.
    assert.equal(parseManifest('42').ok, false);
    assert.equal(parseManifest('"nope"').ok, false);
    assert.equal(parseManifest('null').ok, false);
});

test('parseManifest still validates an already-parsed OBJECT directly (unchanged prior behavior)', () => {
    const r = parseManifest(validManifest);
    assert.equal(r.ok, true);
    assert.deepEqual(r.manifest, validManifest);
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

// --- export stamp ----------------------------------------------------------

test('exportStamp derives YYYYMMDD_HHMMSS from an ISO instant', () => {
    assert.equal(exportStamp(new Date('2026-07-20T15:04:05.123Z')), '20260720_150405');
    assert.equal(exportStamp(new Date('2026-01-02T00:00:00.000Z')), '20260102_000000');
});

test('stampToIso reverses exportStamp (round trip, seconds precision)', () => {
    const d = new Date('2026-07-20T15:04:05.000Z');
    assert.equal(stampToIso(exportStamp(d)), d.toISOString());
});

test('stampToIso parses the leading stamp of a suffixed name (Task 4 pre-import dirs)', () => {
    assert.equal(stampToIso('20260720_150405-pre-import'), '2026-07-20T15:04:05.000Z');
});

test('stampToIso returns null on anything that doesn\'t start with the expected shape', () => {
    for (const bad of [null, undefined, 42, '', 'not-a-stamp', '2026-07-20', '20260720']) {
        assert.equal(stampToIso(bad), null);
    }
});

// --- chunk file naming -------------------------------------------------------

test('chunkFileName zero-pads the index to 4 digits', () => {
    assert.equal(chunkFileName('matches', 0), 'matches.0000.ndjson.gz');
    assert.equal(chunkFileName('odds_markets', 444), 'odds_markets.0444.ndjson.gz');
    assert.equal(chunkFileName('teams', 12), 'teams.0012.ndjson.gz');
});

test('chunkFileName throws on a bad table or index (programmer error)', () => {
    assert.throws(() => chunkFileName('', 0), TypeError);
    assert.throws(() => chunkFileName(null, 0), TypeError);
    assert.throws(() => chunkFileName('teams', -1), TypeError);
    assert.throws(() => chunkFileName('teams', 1.5), TypeError);
    assert.throws(() => chunkFileName('teams', 'x'), TypeError);
});

// --- per-table chunk size -----------------------------------------------------

test('chunkSizeFor pins matches to 500 and everything else to 5000', () => {
    assert.equal(chunkSizeFor('matches'), 500);
    assert.equal(chunkSizeFor('odds_markets'), 5000);
    assert.equal(chunkSizeFor('teams'), 5000);
    assert.equal(chunkSizeFor('fixture_ai_insights'), 5000);
});

// --- PK type classification ---------------------------------------------------

test('isIntegerPkType accepts the live schema\'s integer PK types (case-insensitive)', () => {
    for (const t of ['int', 'bigint', 'mediumint', 'smallint', 'tinyint', 'INT', 'BIGINT']) {
        assert.equal(isIntegerPkType(t), true, `expected ${t} to be integer-like`);
    }
});

test('isIntegerPkType rejects the live schema\'s non-integer PK types', () => {
    // ip_geo.ip and settings.key are both varchar single-column PKs.
    for (const t of ['varchar', 'enum', 'decimal', 'char', 'text', '', null, undefined, 42]) {
        assert.equal(isIntegerPkType(t), false, `expected ${JSON.stringify(t)} to be rejected`);
    }
});

// --- NDJSON row serialization -------------------------------------------------

test('ndjsonLine serializes one JSON object per line, newline-terminated', () => {
    assert.equal(ndjsonLine({ id: 1, name: 'Arsenal' }), '{"id":1,"name":"Arsenal"}\n');
    assert.equal(ndjsonLine({ id: 2, note: null }), '{"id":2,"note":null}\n');
});

// --- byte formatting -----------------------------------------------------

test('formatBytes formats sub-KB sizes with no decimal', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(500), '500 B');
    assert.equal(formatBytes(1023), '1023 B');
});

test('formatBytes crosses unit boundaries at exact powers of 1024 without drift', () => {
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
    assert.equal(formatBytes(1024 * 1024 * 1024 * 1024), '1.0 TB');
});

test('formatBytes formats a realistic export size with one decimal', () => {
    assert.equal(formatBytes(1_500_000), '1.4 MB');
});

test('formatBytes is total against negative/NaN/non-numeric input', () => {
    assert.equal(formatBytes(-5), '0 B');
    assert.equal(formatBytes(NaN), '0 B');
    assert.equal(formatBytes(undefined), '0 B');
    assert.equal(formatBytes('nope'), '0 B');
});

// --- export listing mapper -----------------------------------------------

test('buildExportListing sums file bytes and validates the manifest', () => {
    const r = buildExportListing([{
        stamp: '20260720_100000',
        created_at: '2026-07-20T10:00:00.000Z',
        files: [{ name: 'manifest.json', bytes: 500 }, { name: 'teams.0000.ndjson.gz', bytes: 1500 }],
        manifest: validManifest,
    }]);
    assert.equal(r.length, 1);
    assert.equal(r[0].bytes, 2000);
    assert.equal(r[0].manifest_ok, true);
    assert.equal(r[0].created_at, '2026-07-20T10:00:00.000Z');
});

test('buildExportListing flags manifest_ok false for a missing or invalid manifest', () => {
    const r = buildExportListing([
        { stamp: '20260720_100000', files: [], manifest: null },
        { stamp: '20260719_100000', files: [], manifest: { version: 1 } },
    ]);
    assert.equal(r[0].manifest_ok, false);
    assert.equal(r[1].manifest_ok, false);
});

test('buildExportListing sorts newest stamp first', () => {
    const r = buildExportListing([
        { stamp: '20260601_000000', files: [] },
        { stamp: '20260720_120000', files: [] },
        { stamp: '20260715_083000', files: [] },
    ]);
    assert.deepEqual(r.map(e => e.stamp), ['20260720_120000', '20260715_083000', '20260601_000000']);
});

test('buildExportListing is total against a non-array or malformed entries', () => {
    assert.deepEqual(buildExportListing(null), []);
    assert.deepEqual(buildExportListing(undefined), []);
    const r = buildExportListing([{}]);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0].files, []);
    assert.equal(r[0].bytes, 0);
    assert.equal(r[0].manifest_ok, false);
});

// --- export request schema ----------------------------------------------

test('exportRequestSchema accepts an empty body and an excluded list', () => {
    assert.deepEqual(exportRequestSchema.parse({}), {});
    assert.deepEqual(exportRequestSchema.parse({ excluded: ['ip_geo'] }), { excluded: ['ip_geo'] });
});

test('exportRequestSchema rejects a non-array/non-string excluded field', () => {
    assert.throws(() => exportRequestSchema.parse({ excluded: 'ip_geo' }));
    assert.throws(() => exportRequestSchema.parse({ excluded: [42] }));
});

// ===========================================================================
// Task 4 - import
// ===========================================================================

// --- upload plan -------------------------------------------------------------

test('buildUploadPlan lists every chunk file in manifest.tables order, using chunkFileName', () => {
    const plan = buildUploadPlan(cursorManifest);
    assert.deepEqual(plan, [
        { table: 'leagues', chunk: 0, file: 'leagues.0000.ndjson.gz' },
        { table: 'leagues', chunk: 1, file: 'leagues.0001.ndjson.gz' },
        { table: 'teams', chunk: 0, file: 'teams.0000.ndjson.gz' },
        { table: 'teams', chunk: 1, file: 'teams.0001.ndjson.gz' },
        { table: 'teams', chunk: 2, file: 'teams.0002.ndjson.gz' },
        // 'standings' has 0 chunks (empty table) - contributes nothing.
    ]);
});

test('buildUploadPlan is total against a malformed/empty manifest (never throws)', () => {
    assert.deepEqual(buildUploadPlan(null), []);
    assert.deepEqual(buildUploadPlan(undefined), []);
    assert.deepEqual(buildUploadPlan({}), []);
    assert.deepEqual(buildUploadPlan({ tables: 'nope' }), []);
    assert.deepEqual(buildUploadPlan({ tables: [{ name: '', chunks: 3 }] }), []);
    assert.deepEqual(buildUploadPlan({ tables: [{ chunks: 3 }] }), []);
});

// --- FK dependency map -------------------------------------------------------

test('buildFkDeps builds a {child:[parents]} map from information_schema-shaped rows', () => {
    const rows = [
        { child: 'b', parent: 'a' },
        { child: 'c', parent: 'a' },
        { child: 'd', parent: 'b' },
        { child: 'd', parent: 'c' },
    ];
    assert.deepEqual(buildFkDeps(rows, ['a', 'b', 'c', 'd']), { b: ['a'], c: ['a'], d: ['b', 'c'] });
});

test('buildFkDeps drops an edge referencing a table OUTSIDE the given set (e.g. a default-excluded parent like users)', () => {
    const rows = [
        { child: 'admin_audit', parent: 'users' }, // users is not part of this import
        { child: 'teams', parent: 'leagues' },
    ];
    const deps = buildFkDeps(rows, ['admin_audit', 'teams', 'leagues']);
    assert.deepEqual(deps, { teams: ['leagues'] });
    assert.equal(deps.admin_audit, undefined);
});

test('buildFkDeps dedups repeated (child,parent) pairs (a composite FK repeats once per column)', () => {
    const rows = [
        { child: 'fixtures', parent: 'teams' },
        { child: 'fixtures', parent: 'teams' },
        { child: 'fixtures', parent: 'leagues' },
    ];
    assert.deepEqual(buildFkDeps(rows, ['fixtures', 'teams', 'leagues']), { fixtures: ['teams', 'leagues'] });
});

test('buildFkDeps ignores self-referencing rows and accepts a Set or an array for tableSet', () => {
    assert.deepEqual(buildFkDeps([{ child: 'a', parent: 'a' }], ['a']), {});
    assert.deepEqual(buildFkDeps([{ child: 'b', parent: 'a' }], new Set(['a', 'b'])), { b: ['a'] });
});

test('buildFkDeps is total against malformed rows/tableSet (never throws)', () => {
    assert.deepEqual(buildFkDeps(null, ['a']), {});
    assert.deepEqual(buildFkDeps(undefined, ['a']), {});
    assert.deepEqual(buildFkDeps([{}, { child: 1, parent: 2 }, { child: 'a' }], ['a']), {});
    assert.deepEqual(buildFkDeps([{ child: 'b', parent: 'a' }], null), {});
});

// --- destructive-action confirm ---------------------------------------------

test('importConfirmPhrase embeds the live database name', () => {
    assert.equal(importConfirmPhrase('oddspro'), 'IMPORT oddspro');
    assert.equal(importConfirmPhrase(''), 'IMPORT ');
    assert.equal(importConfirmPhrase(undefined), 'IMPORT ');
});

test('matchesImportConfirm requires an EXACT (case/whitespace-sensitive) match', () => {
    assert.equal(matchesImportConfirm('IMPORT oddspro', 'oddspro'), true);
    assert.equal(matchesImportConfirm('import oddspro', 'oddspro'), false);
    assert.equal(matchesImportConfirm('IMPORT oddspro ', 'oddspro'), false);
    assert.equal(matchesImportConfirm(' IMPORT oddspro', 'oddspro'), false);
    assert.equal(matchesImportConfirm('IMPORT other_db', 'oddspro'), false);
    assert.equal(matchesImportConfirm('', 'oddspro'), false);
    assert.equal(matchesImportConfirm(null, 'oddspro'), false);
    assert.equal(matchesImportConfirm(undefined, 'oddspro'), false);
    assert.equal(matchesImportConfirm(42, 'oddspro'), false);
});

// --- apply request schema -----------------------------------------------------

test('importApplySchema accepts a well-formed {stamp, confirm} body', () => {
    const r = importApplySchema.parse({ stamp: '20260720_101500', confirm: 'IMPORT oddspro' });
    assert.deepEqual(r, { stamp: '20260720_101500', confirm: 'IMPORT oddspro' });
});

test('importApplySchema rejects a missing/empty stamp or confirm, or wrong types', () => {
    assert.throws(() => importApplySchema.parse({}));
    assert.throws(() => importApplySchema.parse({ stamp: '20260720_101500' }));
    assert.throws(() => importApplySchema.parse({ confirm: 'IMPORT oddspro' }));
    assert.throws(() => importApplySchema.parse({ stamp: '', confirm: 'IMPORT oddspro' }));
    assert.throws(() => importApplySchema.parse({ stamp: '20260720_101500', confirm: '' }));
    assert.throws(() => importApplySchema.parse({ stamp: 42, confirm: 'IMPORT oddspro' }));
});

// --- shouldSkipSafetyExport (fix pass 2, MEDIUM finding) --------------------
// Gates whether runImportApply's safety export re-runs on a resumed apply.
// Skip iff a VALID pre-import manifest is already on disk (the pristine
// snapshot from a prior attempt); never skip on a missing or malformed one -
// that's either a genuine first run or a torn snapshot, and either way a
// fresh safety export is required before any row is written.

test('shouldSkipSafetyExport returns true for a valid manifest passed as a raw JSON string (the on-disk case)', () => {
    assert.equal(shouldSkipSafetyExport(JSON.stringify(validManifest)), true);
});

test('shouldSkipSafetyExport returns true for a valid manifest passed as an already-parsed object', () => {
    assert.equal(shouldSkipSafetyExport(validManifest), true);
});

test('shouldSkipSafetyExport returns false when there is no prior snapshot (null/missing)', () => {
    assert.equal(shouldSkipSafetyExport(null), false);
    assert.equal(shouldSkipSafetyExport(undefined), false);
});

test('shouldSkipSafetyExport returns false on a malformed/torn manifest string (never throws)', () => {
    assert.doesNotThrow(() => shouldSkipSafetyExport('{"version":1,'));
    assert.equal(shouldSkipSafetyExport('{"version":1,'), false);
    assert.equal(shouldSkipSafetyExport(''), false);
    assert.equal(shouldSkipSafetyExport('not json at all'), false);
});

test('shouldSkipSafetyExport returns false on a well-formed-JSON-but-wrong-shape manifest', () => {
    assert.equal(shouldSkipSafetyExport('{}'), false);
    assert.equal(shouldSkipSafetyExport('null'), false);
    assert.equal(shouldSkipSafetyExport(JSON.stringify({ ...validManifest, tables: [{ name: 'leagues' }] })), false);
});
