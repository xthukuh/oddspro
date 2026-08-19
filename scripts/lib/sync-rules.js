// Pure DB-sync planning rules (zero imports, offline-testable - the
// scripts/*-rules.js idiom used throughout src/db/). Backs a future
// scripts/db-sync.js (pull the live warehouse into the local dev DB) and is
// also where INSTANCE_TABLES now lives verbatim, moved out of
// scripts/deploy-remote.js so the two scripts share one definition of "never
// touch these on a routine sync/deploy".
//
// Three classes of table:
//   - canonical: API-Football-sourced (leagues/teams/fixtures/standings/
//     fixture_* detail tables) - REPLACE-only, live rows always win.
//   - trio: matches/odds_markets - the bookmaker-scraped pair; a window pull
//     also needs a DELETE first (see windowDeleteSql) because a vanished
//     remote row (an odds market that disappeared) would otherwise survive
//     locally forever - REPLACE alone can't remove rows.
//   - derived: fixture_predictions/daily_slips - computed by our own engine,
//     REPLACE-only like canonical.

// Instance-unique tables: NEVER shipped/synced across environments (remote
// records win on a deploy; a sync pull must never touch them either).
// `settings` is deliberately NOT here - see deploy-remote.js's own comment.
export const INSTANCE_TABLES = [
    'users', 'sessions', 'otp_codes', 'user_prefs', 'personal_access_tokens',
    'user_slips', 'visits', 'visitors', 'visit_sessions', 'visitor_devices',
    'visit_events', 'ip_geo', 'admin_audit',
    'sms_templates', 'sms_campaigns', 'sms_campaign_recipients',
];

function assertDate(label, value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(`sync-rules: ${label} must be a YYYY-MM-DD date (got ${JSON.stringify(value)})`);
    }
}

// fixtures.kickoff / matches.start_time window - the two "root" date columns
// every other date-scoped table's window ultimately derives from.
const kickoffWindow = (col) => (since, until) => {
    assertDate('since', since);
    assertDate('until', until);
    return `${col} >= '${since}' AND ${col} < '${until}'`;
};

// fixture_id IN (SELECT id FROM fixtures WHERE kickoff window) - shared by
// every fixture_* detail table plus fixture_predictions.
const fixtureIdWindow = (since, until) => {
    assertDate('since', since);
    assertDate('until', until);
    return `fixture_id IN (SELECT id FROM fixtures WHERE kickoff >= '${since}' AND kickoff < '${until}')`;
};

// match_id IN (SELECT id FROM matches WHERE start_time window) - odds_markets
// has no date column of its own, it hangs off matches.
const oddsMarketsWindow = (since, until) => {
    assertDate('since', since);
    assertDate('until', until);
    return `match_id IN (SELECT id FROM matches WHERE start_time >= '${since}' AND start_time < '${until}')`;
};

const slipDateWindow = (since, until) => {
    assertDate('since', since);
    assertDate('until', until);
    return `slip_date >= '${since}' AND slip_date < '${until}'`;
};

// Ordered FK-sane: parents before children, matches before odds_markets,
// fixtures before every fixture_* detail table.
export const SYNC_TABLES = [
    { name: 'leagues', cls: 'canonical', dateWhere: null },
    { name: 'teams', cls: 'canonical', dateWhere: null },
    { name: 'league_aliases', cls: 'canonical', dateWhere: null },
    { name: 'team_aliases', cls: 'canonical', dateWhere: null },
    { name: 'fixtures', cls: 'canonical', dateWhere: kickoffWindow('kickoff') },
    { name: 'standings', cls: 'canonical', dateWhere: null },
    { name: 'matches', cls: 'trio', dateWhere: kickoffWindow('start_time') },
    { name: 'odds_markets', cls: 'trio', dateWhere: oddsMarketsWindow },
    { name: 'fixture_statistics', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_events', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_lineups', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_players', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_prematch', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_api_predictions', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_ai_insights', cls: 'canonical', dateWhere: fixtureIdWindow },
    { name: 'fixture_predictions', cls: 'derived', dateWhere: fixtureIdWindow },
    { name: 'daily_slips', cls: 'derived', dateWhere: slipDateWindow },
];

// Build the ordered pull plan. `tables` null/empty = every SYNC_TABLES entry;
// an instance table or an unrecognized name throws (loud, not a silent skip -
// a typo in a table list should never quietly sync the wrong thing). Output
// is always in SYNC_TABLES order, independent of the input order/dedup.
export function planPull({ tables, since, until, full = false } = {}) {
    const requested = tables && tables.length ? tables : SYNC_TABLES.map(t => t.name);
    const wanted = new Set();
    for (const name of requested) {
        if (INSTANCE_TABLES.includes(name)) {
            throw new Error(`planPull: "${name}" is an instance table and can never be synced`);
        }
        if (!SYNC_TABLES.some(t => t.name === name)) {
            throw new Error(`planPull: unknown table "${name}"`);
        }
        wanted.add(name);
    }
    const plan = [];
    for (const entry of SYNC_TABLES) {
        if (!wanted.has(entry.name)) continue;
        if (full || entry.dateWhere === null) {
            plan.push({ table: entry.name, mode: 'full', where: null });
        } else {
            plan.push({ table: entry.name, mode: 'window', where: entry.dateWhere(since, until) });
        }
    }
    return plan;
}

// mariadb-dump argv for one table. Full mode carries --add-drop-table (the
// table is recreated wholesale); window mode carries --no-create-info
// (structure already exists) + the --where filter. --replace on both means
// re-importing a row already present overwrites it rather than erroring on
// the PK - the whole point of a REPLACE-only sync for canonical/derived
// tables (see the module comment).
export function dumpArgs({ db, table, where, full }) {
    return [
        '--compact', '--quick', '--single-transaction', '--no-tablespaces',
        '--default-character-set=utf8mb4',
        full ? '--add-drop-table' : '--no-create-info',
        '--replace',
        ...(where ? [`--where=${where}`] : []),
        db, table,
    ];
}

// Prepended to an import stream ahead of a --compact dump (which emits no
// SET FOREIGN_KEY_CHECKS lines of its own) so cross-table REPLACE order
// never trips an FK, and a stale UNIQUE/strict-mode setting on the target
// can't reject an otherwise-valid row mid-import.
export function importPreamble() {
    return 'SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0; SET SQL_MODE="";\n';
}

// The trio's odds_markets has no delete of its own (its FK to matches
// cascades - see the migration's ON DELETE CASCADE) but a windowed matches
// pull DOES need a DELETE first: REPLACE only overwrites rows that reappear
// in the dump, it can never remove a row that vanished on the remote (e.g. a
// bookmaker market pulled from the board). This function returns null for
// every other table, but that does NOT mean nothing is ever deleted for
// them: a full-mode dump's --add-drop-table recreates the table wholesale
// (DROP TABLE then CREATE TABLE - every existing row goes with it), and a
// windowed dump's --no-create-info/--replace never deletes a row outside
// the window, it only overwrites/inserts rows that reappear (live wins by
// design). This helper's null return only means "no EXTRA delete step is
// needed beyond what the dump mode itself already does".
export function windowDeleteSql(table, since, until) {
    if (table === 'matches') {
        assertDate('since', since);
        assertDate('until', until);
        return `DELETE FROM matches WHERE start_time >= '${since}' AND start_time < '${until}'`;
    }
    return null;
}

// The `status` command's SQL text, run identically against local and remote
// (through whatever DB connection the caller holds) so the two result sets
// are directly comparable by compareStatus. No DB access here - pure SQL
// generation, kept in this zero-import module for the same offline-testable
// reason as everything else in scripts/lib/sync-rules.js.
export function statusRows() {
    const tableList = SYNC_TABLES.map(t => `'${t.name}'`).join(', ');
    return [
        {
            key: 'tables',
            sql: `SELECT table_name, table_rows, ROUND((data_length + index_length) / 1048576, 2) AS mb`
                + ` FROM information_schema.tables`
                + ` WHERE table_schema = DATABASE() AND table_name IN (${tableList})`
                + ` ORDER BY table_name`,
        },
        {
            key: 'matches_by_day',
            sql: `SELECT DATE(start_time) AS day, provider, COUNT(*) AS n, MAX(updated_at) AS last_updated`
                + ` FROM matches WHERE start_time >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)`
                + ` GROUP BY DATE(start_time), provider ORDER BY day DESC, provider`,
        },
        {
            key: 'freshness',
            sql: `SELECT (SELECT MAX(updated_at) FROM matches) AS matches_updated_at,`
                + ` (SELECT MAX(kickoff) FROM fixtures) AS fixtures_max_kickoff,`
                + ` (SELECT MAX(updated_at) FROM fixtures) AS fixtures_updated_at`,
        },
        { key: 'migration', sql: `SELECT MAX(name) AS name FROM knex_migrations` },
    ];
}

// Comparable scalar for a row/timestamp/name value: Date -> epoch ms, number/
// string pass through as-is (ISO timestamps and knex migration names - both
// zero-padded-timestamp-prefixed - sort correctly as plain strings), null/
// undefined -> null (sorts as "furthest behind").
function normalize(v) {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) return v.getTime();
    return v;
}

function markerFor(l, r) {
    const nl = normalize(l);
    const nr = normalize(r);
    if (nl === null && nr === null) return '=';
    if (nl === null) return '<';
    if (nr === null) return '>';
    if (nl < nr) return '<';
    if (nl > nr) return '>';
    return '=';
}

// Side-by-side comparison of two statusRows() result sets (same shape as
// produced by executing statusRows()'s SQL against each DB). `<` = local is
// behind (smaller row count / older timestamp / older migration), `>` =
// local is ahead, `=` = equal. Rows only present on one side compare against
// null (treated as "furthest behind" on the missing side).
export function compareStatus(local, remote) {
    const rows = [];

    const localTables = new Map((local.tables || []).map(r => [r.table_name, r]));
    const remoteTables = new Map((remote.tables || []).map(r => [r.table_name, r]));
    const names = new Set([...localTables.keys(), ...remoteTables.keys()]);
    for (const name of [...names].sort()) {
        const l = localTables.get(name);
        const r = remoteTables.get(name);
        const lRows = l ? Number(l.table_rows) || 0 : 0;
        const rRows = r ? Number(r.table_rows) || 0 : 0;
        rows.push({ key: `tables.${name}`, local: lRows, remote: rRows, marker: markerFor(lRows, rRows) });
    }

    const lf = local.freshness || {};
    const rf = remote.freshness || {};
    for (const field of ['matches_updated_at', 'fixtures_max_kickoff', 'fixtures_updated_at']) {
        const l = lf[field] ?? null;
        const r = rf[field] ?? null;
        rows.push({ key: `freshness.${field}`, local: l, remote: r, marker: markerFor(l, r) });
    }

    const lm = (local.migration || {}).name ?? null;
    const rm = (remote.migration || {}).name ?? null;
    rows.push({ key: 'migration', local: lm, remote: rm, marker: markerFor(lm, rm) });

    return rows;
}

// --- dump completeness -------------------------------------------------------
// Round 1 fix (2026-08-19): a shared cPanel host was found live to KILL a
// long-running remote mariadb-dump connection mid-stream (matches/
// odds_markets on the two dead DBs) - gzip closes its OWN output cleanly
// regardless, so `gzip -t` passes on a truncated file. `gzip -t` verifies
// the GZIP FRAME is intact, never that the SQL inside is the whole dump.
// The real signal is mariadb-dump's own completion marker: it writes
// `-- Dump completed on <date> (<version>)` as its LAST line, but only when
// it exits 0 - a killed connection never gets to print it. `--compact`
// (used for every pull dump, to keep them small/fast) suppresses that
// native line, so pull dumps carry an explicit marker of our own instead,
// appended by the remote shell ONLY after mariadb-dump itself exits 0 (see
// db-sync.js's buildRemoteDumpCmd: `(mariadb-dump ... && echo '<marker>') |
// gzip -9` under `set -o pipefail`, so a killed dump propagates a non-zero
// exit through the whole pipe instead of gzip silently reporting success).
export const OWN_DUMP_MARKER = '-- oddspro-sync: complete';
const NATIVE_DUMP_MARKER = '-- Dump completed on';

// tailText: the last ~2 KB of the DECOMPRESSED dump (db-sync.js reads this
// by streaming the file through zlib and keeping only the tail - the file
// itself can be gigabytes, this check must never load it all into memory).
export function dumpLooksComplete(tailText) {
    if (typeof tailText !== 'string' || !tailText.length) return false;
    return tailText.includes(NATIVE_DUMP_MARKER) || tailText.includes(OWN_DUMP_MARKER);
}

// --- chunked backup planning -------------------------------------------------
// A single mariadb-dump invocation covering millions of rows is exactly the
// kind of long-running remote query the host was found killing. Splitting a
// big table's data into bounded PK-range chunks (each its own short-lived
// remote invocation, independently retried/verified) keeps every individual
// remote query short enough to finish before a connection-kill threshold.
export const BACKUP_CHUNK_SIZE = 100000;

// Split an inclusive [minId, maxId] id range (a table's MIN(id)/MAX(id),
// queried remotely) into consecutive half-open [from, to) ranges of at most
// chunkSize ids each - the last range absorbs the remainder. minId/maxId
// null (empty table, or no qualifying rows) -> []. Ranges use `id >= from
// AND id < to`, matching the `--where=` clause db-sync.js builds per chunk.
export function planIdChunks({ minId, maxId, chunkSize }) {
    if (minId == null || maxId == null) return [];
    if (!Number.isFinite(minId) || !Number.isFinite(maxId)) {
        throw new Error(`planIdChunks: minId/maxId must be finite numbers (got ${minId}, ${maxId})`);
    }
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
        throw new Error(`planIdChunks: chunkSize must be a positive number (got ${chunkSize})`);
    }
    if (minId > maxId) throw new Error(`planIdChunks: minId (${minId}) must be <= maxId (${maxId})`);
    const chunks = [];
    let from = minId;
    while (from <= maxId) {
        const to = Math.min(from + chunkSize, maxId + 1);
        chunks.push({ from, to });
        from = to;
    }
    return chunks;
}
