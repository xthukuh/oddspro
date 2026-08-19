// Pure DB-sync planning rules (scripts/lib/sync-rules.js). Zero imports, no
// DB/network - covers the table plan builder, mariadb-dump argv builder, the
// windowed-delete SQL for the trio tables, and the local/remote status
// comparison markers used by a future `scripts/db-sync.js`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INSTANCE_TABLES, SYNC_TABLES, planPull, dumpArgs, importPreamble, windowDeleteSql,
    statusRows, compareStatus, dumpLooksComplete, OWN_DUMP_MARKER, BACKUP_CHUNK_SIZE,
    planIdChunks,
} from '../scripts/lib/sync-rules.js';

const SINCE = '2026-08-01';
const UNTIL = '2026-08-19';

// ---- planPull ---------------------------------------------------------------

test('planPull rejects an instance table (users)', () => {
    assert.throws(() => planPull({ tables: ['users'], since: SINCE, until: UNTIL }), /users/);
});

test('planPull rejects an unknown table name', () => {
    assert.throws(() => planPull({ tables: ['nonsense'], since: SINCE, until: UNTIL }), /nonsense/);
});

test('planPull default table set (null/empty tables) excludes every INSTANCE_TABLE', () => {
    const plan = planPull({ since: SINCE, until: UNTIL });
    const names = plan.map(p => p.table);
    for (const t of INSTANCE_TABLES) assert.ok(!names.includes(t), `${t} must not appear in the default plan`);
    const plan2 = planPull({ tables: [], since: SINCE, until: UNTIL });
    assert.deepEqual(plan2.map(p => p.table), names);
});

test('planPull default plan matches SYNC_TABLES in order', () => {
    const plan = planPull({ since: SINCE, until: UNTIL });
    assert.deepEqual(plan.map(p => p.table), SYNC_TABLES.map(t => t.name));
});

test('planPull orders output by SYNC_TABLES order regardless of input order', () => {
    const plan = planPull({ tables: ['matches', 'leagues', 'fixtures'], since: SINCE, until: UNTIL });
    assert.deepEqual(plan.map(p => p.table), ['leagues', 'fixtures', 'matches']);
});

test('planPull mode is "window" for a date-scoped table, "full" for a full-only table', () => {
    const plan = planPull({ tables: ['fixtures', 'leagues'], since: SINCE, until: UNTIL });
    const fixtures = plan.find(p => p.table === 'fixtures');
    const leagues = plan.find(p => p.table === 'leagues');
    assert.equal(fixtures.mode, 'window');
    assert.ok(fixtures.where && fixtures.where.includes(SINCE) && fixtures.where.includes(UNTIL));
    assert.equal(leagues.mode, 'full');
    assert.equal(leagues.where, null);
});

test('planPull forces mode "full" for every table when opts.full is set', () => {
    const plan = planPull({ tables: ['fixtures', 'matches'], since: SINCE, until: UNTIL, full: true });
    for (const row of plan) {
        assert.equal(row.mode, 'full');
        assert.equal(row.where, null);
    }
});

test('planPull odds_markets window clause references matches.start_time', () => {
    const plan = planPull({ tables: ['odds_markets'], since: SINCE, until: UNTIL });
    const row = plan[0];
    assert.equal(row.mode, 'window');
    assert.match(row.where, /SELECT id FROM matches WHERE start_time >= '2026-08-01' AND start_time < '2026-08-19'/);
});

test('planPull fixture_statistics window clause references fixtures.kickoff', () => {
    const plan = planPull({ tables: ['fixture_statistics'], since: SINCE, until: UNTIL });
    assert.match(plan[0].where, /SELECT id FROM fixtures WHERE kickoff >= '2026-08-01' AND kickoff < '2026-08-19'/);
});

test('planPull daily_slips window clause uses slip_date', () => {
    const plan = planPull({ tables: ['daily_slips'], since: SINCE, until: UNTIL });
    assert.match(plan[0].where, /slip_date >= '2026-08-01' AND slip_date < '2026-08-19'/);
});

test('planPull throws on a malformed since/until date for a windowed table', () => {
    assert.throws(() => planPull({ tables: ['fixtures'], since: '2026/08/01', until: UNTIL }), /date/i);
    assert.throws(() => planPull({ tables: ['fixtures'], since: SINCE, until: 'not-a-date' }), /date/i);
});

test('planPull does not require valid dates for a full-only-table-only request', () => {
    assert.doesNotThrow(() => planPull({ tables: ['leagues'], since: 'garbage', until: 'garbage' }));
});

// ---- dumpArgs -----------------------------------------------------------------

test('dumpArgs windowed mode carries --no-create-info, --replace and --where', () => {
    const argv = dumpArgs({ db: 'oddspro', table: 'fixtures', where: "kickoff >= '2026-08-01'", full: false });
    assert.deepEqual(argv, [
        '--compact', '--quick', '--single-transaction', '--no-tablespaces',
        '--default-character-set=utf8mb4', '--no-create-info', '--replace',
        "--where=kickoff >= '2026-08-01'", 'oddspro', 'fixtures',
    ]);
});

test('dumpArgs full mode carries --add-drop-table and no --where', () => {
    const argv = dumpArgs({ db: 'oddspro', table: 'leagues', where: null, full: true });
    assert.deepEqual(argv, [
        '--compact', '--quick', '--single-transaction', '--no-tablespaces',
        '--default-character-set=utf8mb4', '--add-drop-table', '--replace',
        'oddspro', 'leagues',
    ]);
    assert.ok(!argv.some(a => a.startsWith('--where=')));
});

// ---- importPreamble -----------------------------------------------------------

test('importPreamble disables FK/unique checks and relaxes SQL_MODE', () => {
    const p = importPreamble();
    assert.equal(p, 'SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0; SET SQL_MODE="";\n');
});

// ---- windowDeleteSql -----------------------------------------------------------

test('windowDeleteSql deletes matches by start_time window (odds_markets cascades via FK)', () => {
    const sql = windowDeleteSql('matches', SINCE, UNTIL);
    assert.equal(sql, `DELETE FROM matches WHERE start_time >= '${SINCE}' AND start_time < '${UNTIL}'`);
});

test('windowDeleteSql is null for odds_markets (handled by the matches delete)', () => {
    assert.equal(windowDeleteSql('odds_markets', SINCE, UNTIL), null);
});

test('windowDeleteSql is null for fixtures and every other canonical/derived table', () => {
    assert.equal(windowDeleteSql('fixtures', SINCE, UNTIL), null);
    assert.equal(windowDeleteSql('leagues', SINCE, UNTIL), null);
    assert.equal(windowDeleteSql('fixture_predictions', SINCE, UNTIL), null);
    assert.equal(windowDeleteSql('daily_slips', SINCE, UNTIL), null);
});

// ---- statusRows -----------------------------------------------------------------

test('statusRows returns an array of {key, sql} with no DB access', () => {
    const rows = statusRows();
    assert.ok(Array.isArray(rows));
    const keys = rows.map(r => r.key);
    assert.deepEqual(keys, ['tables', 'matches_by_day', 'freshness', 'migration']);
    for (const r of rows) assert.equal(typeof r.sql, 'string');
    assert.match(rows.find(r => r.key === 'tables').sql, /table_schema\s*=\s*DATABASE\(\)/i);
    assert.match(rows.find(r => r.key === 'migration').sql, /knex_migrations/);
});

// ---- compareStatus -----------------------------------------------------------------

test('compareStatus marks "<" when local is behind on a table row count', () => {
    const local = { tables: [{ table_name: 'fixtures', table_rows: 100, mb: 1 }], freshness: {}, migration: {} };
    const remote = { tables: [{ table_name: 'fixtures', table_rows: 150, mb: 1.5 }], freshness: {}, migration: {} };
    const rows = compareStatus(local, remote);
    const row = rows.find(r => r.key === 'tables.fixtures');
    assert.equal(row.marker, '<');
    assert.equal(row.local, 100);
    assert.equal(row.remote, 150);
});

test('compareStatus marks ">" when local is ahead on a table row count', () => {
    const local = { tables: [{ table_name: 'fixtures', table_rows: 200, mb: 1 }], freshness: {}, migration: {} };
    const remote = { tables: [{ table_name: 'fixtures', table_rows: 150, mb: 1.5 }], freshness: {}, migration: {} };
    const rows = compareStatus(local, remote);
    assert.equal(rows.find(r => r.key === 'tables.fixtures').marker, '>');
});

test('compareStatus marks "=" when equal', () => {
    const local = { tables: [{ table_name: 'fixtures', table_rows: 150, mb: 1.5 }], freshness: {}, migration: {} };
    const remote = { tables: [{ table_name: 'fixtures', table_rows: 150, mb: 1.5 }], freshness: {}, migration: {} };
    const rows = compareStatus(local, remote);
    assert.equal(rows.find(r => r.key === 'tables.fixtures').marker, '=');
});

test('compareStatus marks freshness timestamps behind/ahead (older = "<")', () => {
    const local = { tables: [], freshness: { matches_updated_at: '2026-08-10T00:00:00.000Z' }, migration: {} };
    const remote = { tables: [], freshness: { matches_updated_at: '2026-08-15T00:00:00.000Z' }, migration: {} };
    const rows = compareStatus(local, remote);
    assert.equal(rows.find(r => r.key === 'freshness.matches_updated_at').marker, '<');
});

test('compareStatus marks migration name lag lexicographically', () => {
    const local = { tables: [], freshness: {}, migration: { name: '20260801000000_a.js' } };
    const remote = { tables: [], freshness: {}, migration: { name: '20260810000000_b.js' } };
    const rows = compareStatus(local, remote);
    assert.equal(rows.find(r => r.key === 'migration').marker, '<');
});

// ---- dumpLooksComplete ---------------------------------------------------------
// Round 1 fix: `gzip -t` verifies the gzip FRAME, never that mariadb-dump
// actually finished - a shared host killing the connection mid-stream still
// closes gzip's output cleanly. These tests pin the completeness contract.

test('dumpLooksComplete is true when the native mariadb-dump trailer is present', () => {
    const tail = '...\nINSERT INTO `x` VALUES (1,2,3);\n-- Dump completed on 2026-08-19 12:00:00\n';
    assert.equal(dumpLooksComplete(tail), true);
});

test('dumpLooksComplete is true when our own --compact marker is present', () => {
    const tail = `...\nINSERT INTO \`x\` VALUES (1,2,3);\n${OWN_DUMP_MARKER}\n`;
    assert.equal(dumpLooksComplete(tail), true);
});

test('dumpLooksComplete is false on a truncated tail (mid-INSERT, no trailer)', () => {
    const tail = "...\nINSERT INTO `matches` (`id`,`metadata`) VALUES (1,'{\"partial";
    assert.equal(dumpLooksComplete(tail), false);
});

test('dumpLooksComplete is false on empty/non-string input', () => {
    assert.equal(dumpLooksComplete(''), false);
    assert.equal(dumpLooksComplete(null), false);
    assert.equal(dumpLooksComplete(undefined), false);
});

test('dumpLooksComplete only matches a trailer inside the given tail, not elsewhere', () => {
    // Sanity: the function trusts its input is already "the tail" - it does
    // no seeking itself. A trailer-shaped string anywhere in the given text
    // counts (the caller is responsible for handing it a bounded tail).
    assert.equal(dumpLooksComplete('-- Dump completed on X'), true);
});

// ---- planIdChunks ---------------------------------------------------------------

test('planIdChunks: empty table (null minId/maxId) yields no chunks', () => {
    assert.deepEqual(planIdChunks({ minId: null, maxId: null, chunkSize: BACKUP_CHUNK_SIZE }), []);
    assert.deepEqual(planIdChunks({ minId: null, maxId: 5, chunkSize: BACKUP_CHUNK_SIZE }), []);
    assert.deepEqual(planIdChunks({ minId: 1, maxId: null, chunkSize: BACKUP_CHUNK_SIZE }), []);
});

test('planIdChunks: exact multiple of chunkSize splits evenly, half-open ranges', () => {
    const chunks = planIdChunks({ minId: 1, maxId: 200000, chunkSize: 100000 });
    assert.deepEqual(chunks, [{ from: 1, to: 100001 }, { from: 100001, to: 200001 }]);
});

test('planIdChunks: remainder produces a final smaller chunk', () => {
    const chunks = planIdChunks({ minId: 1, maxId: 250000, chunkSize: 100000 });
    assert.deepEqual(chunks, [
        { from: 1, to: 100001 },
        { from: 100001, to: 200001 },
        { from: 200001, to: 250001 },
    ]);
});

test('planIdChunks: a single-row table (minId === maxId) yields one chunk', () => {
    assert.deepEqual(planIdChunks({ minId: 42, maxId: 42, chunkSize: 100000 }), [{ from: 42, to: 43 }]);
});

test('planIdChunks: a range smaller than chunkSize yields one chunk covering it exactly', () => {
    assert.deepEqual(planIdChunks({ minId: 10, maxId: 50, chunkSize: 100000 }), [{ from: 10, to: 51 }]);
});

test('planIdChunks: chunks tile the whole range with no gaps or overlaps', () => {
    const chunks = planIdChunks({ minId: 1, maxId: 999999, chunkSize: 100000 });
    for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].from, chunks[i - 1].to);
    assert.equal(chunks[0].from, 1);
    assert.equal(chunks[chunks.length - 1].to, 1000000);
});

test('planIdChunks throws on a non-positive or non-finite chunkSize', () => {
    assert.throws(() => planIdChunks({ minId: 1, maxId: 10, chunkSize: 0 }), /chunkSize/);
    assert.throws(() => planIdChunks({ minId: 1, maxId: 10, chunkSize: -5 }), /chunkSize/);
    assert.throws(() => planIdChunks({ minId: 1, maxId: 10, chunkSize: NaN }), /chunkSize/);
});

test('planIdChunks throws when minId > maxId', () => {
    assert.throws(() => planIdChunks({ minId: 10, maxId: 1, chunkSize: 100000 }), /minId/);
});

test('BACKUP_CHUNK_SIZE is 100000', () => {
    assert.equal(BACKUP_CHUNK_SIZE, 100000);
});
