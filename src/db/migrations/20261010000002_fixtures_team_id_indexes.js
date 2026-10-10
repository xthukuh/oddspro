// fixtures carried no index on home_team_id/away_team_id (the init migration
// indexes only kickoff, status and (league_id, season)). Two call sites run
// the exact same shape of query over this table in team-id chunks of up to
// 500 (TEAM_ID_CHUNK) or more:
//   WHERE status IN (<FINAL_STATUSES>) AND (home_team_id IN (<chunk>) OR away_team_id IN (<chunk>))
// - src/prematch.js's updatePrematchSnapshots() (the pre-match history pull)
// - src/hotpicks.js's loadTeamHistory() (shared with src/enrich.js's AI
//   rolling-stats projection)
// Every chunk full-scanned fixtures. The 2026-09-04 sweep lost its whole
// pre-match step - and 102 of that day's 261 snapshots PERMANENTLY, since
// fixture_prematch rows never write again once a fixture's kickoff has
// passed - to one history query carrying ~3,800 team ids over this unindexed
// column: long enough that the live host closed the connection mid-statement
// (see src/prematch.js's TEAM_ID_CHUNK comment).
//
// Two composites, team_id leading in each: home_team_id/away_team_id is far
// more selective than status (which only ever holds a handful of distinct
// codes - FINAL_STATUSES is 6 of them), so leading on it lets MySQL range-
// scan straight to the matching rows; status trails so it is still applied
// as an index condition (no row lookup needed) rather than a second filter
// pass. Two single-column-led composites rather than one two-column index,
// because the query ORs home_team_id against away_team_id - an index can
// only serve one side of an OR as a range scan, so each side needs its own
// leading column before MySQL can combine them (index merge / union).
// kickoff is deliberately NOT part of either index: neither query filters or
// orders by it in SQL (it is only selected, then windowed/sorted in JS by
// src/db/prematch-calc.js and src/db/goals-rules.js), so adding it would
// only grow the index for no query-plan benefit.
//
// Idempotent-safe: checked against information_schema before CREATE/DROP so
// this migration is harmless to re-run against a schema that already has
// the index (e.g. applied by hand during an incident, ahead of `npm run
// migrate` catching up) - same information_schema-via-knex.raw() pattern as
// src/db-info.js's dbOverview(), the only other place this codebase queries it.
const INDEXES = [
    { name: 'fixtures_home_team_id_status_index', columns: '(home_team_id, status)' },
    { name: 'fixtures_away_team_id_status_index', columns: '(away_team_id, status)' },
];

async function indexExists(knex, table, indexName) {
    const [rows] = await knex.raw(
        `SELECT COUNT(1) AS cnt FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, indexName],
    );
    return Number(rows[0].cnt) > 0;
}

export async function up(knex) {
    for (const { name, columns } of INDEXES) {
        if (await indexExists(knex, 'fixtures', name)) continue;
        await knex.raw(`CREATE INDEX ${name} ON fixtures ${columns}`);
    }
}

export async function down(knex) {
    for (const { name } of INDEXES) {
        if (!(await indexExists(knex, 'fixtures', name))) continue;
        await knex.raw(`DROP INDEX ${name} ON fixtures`);
    }
}
