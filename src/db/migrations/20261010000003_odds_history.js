// Odds history (owner requirement 2026-10-10): an append-only log of every
// odds price CHANGE with the time it was observed, the ledger of every logged
// look at a match, and frozen target snapshots (opening / T-24h / T-3h / T-1h
// / closing). Spec: docs/dev/specs/2026-10-10-1600-odds-history-targets.md.
//
// odds_markets and matches are deliberately NOT altered: an ALTER on the
// 17 M row odds_markets is exactly the long statement the live host kills.
// Times are EAT wall-clock DATETIME(3) like every other warehouse datetime.
// Nothing here is ever updated or deleted by the app; rows go only with
// their match (ON DELETE CASCADE). Each FK is declared AFTER the composite
// index that leads with match_id, so the engine reuses that index for the
// constraint instead of building a redundant single-column one (on a log
// this size a spare index is real disk).

const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

export async function up(knex) {
    // One row per logged look at one match (one saveMatches transaction),
    // including a look that changed nothing - this is what makes target lag
    // honest ("unchanged, last looked at 11:55" vs "not looked at since 09:00").
    await knex.schema.createTable('odds_observations', t => {
        t.bigIncrements('id').unsigned().primary();
        t.bigint('match_id').unsigned().notNullable();
        t.datetime('observed_at', { precision: 3 }).notNullable();
        t.enu('kind', ['first', 'baseline', 'update']).notNullable();
        t.string('source', 16).nullable().comment('light | full | manual | due | cli');
        t.datetime('kickoff_at').notNullable().comment('canonical kickoff the pre-match gate used');
        t.integer('markets').unsigned().notNullable().defaultTo(0).comment('snapshot size');
        t.integer('changes').unsigned().notNullable().defaultTo(0).comment('odds_changes rows written');
        _base(knex, t);
        t.index(['match_id', 'observed_at'], 'odds_observations_match_observed_index');
        t.foreign('match_id').references('id').inTable('matches').onDelete('CASCADE');
    });

    // One row per price event of one market identity (type_name, name,
    // handicap - never type_id). Unchanged prices write nothing.
    await knex.schema.createTable('odds_changes', t => {
        t.bigIncrements('id').unsigned().primary();
        t.bigint('match_id').unsigned().notNullable();
        t.string('type_name').notNullable();
        t.string('name').notNullable();
        t.decimal('handicap', 6, 1).nullable();
        t.decimal('odds', 8, 2).notNullable();
        t.decimal('prev_odds', 8, 2).nullable();
        t.enu('event', ['first_seen', 'changed', 'stale', 'revived', 'baseline']).notNullable();
        t.datetime('observed_at', { precision: 3 }).notNullable();
        _base(knex, t);
        t.index(['match_id', 'observed_at'], 'odds_changes_match_observed_index');
        t.foreign('match_id').references('id').inTable('matches').onDelete('CASCADE');
    });

    // One row per (match, target), written once. The markets are not copied:
    // as_of_change_id is the cutoff into the append-only log, replayed on
    // read (frozen by construction - see the spec).
    await knex.schema.createTable('odds_target_snapshots', t => {
        t.bigIncrements('id').unsigned().primary();
        t.bigint('match_id').unsigned().notNullable();
        t.enu('target', ['opening', 't24h', 't3h', 't1h', 'closing']).notNullable();
        t.datetime('kickoff_at').notNullable().comment('canonical kickoff at freeze time');
        t.datetime('target_at', { precision: 3 }).notNullable();
        t.datetime('observed_at', { precision: 3 }).nullable().comment('last logged look at or before target_at');
        t.integer('lag_seconds').nullable().comment('target_at - observed_at');
        t.enu('quality', ['ok', 'lagged', 'missing', 'baseline']).notNullable();
        t.integer('markets').unsigned().notNullable().defaultTo(0);
        t.bigint('as_of_change_id').unsigned().nullable();
        _base(knex, t);
        t.unique(['match_id', 'target'], { indexName: 'odds_target_snapshots_match_target_unique' });
        t.foreign('match_id').references('id').inTable('matches').onDelete('CASCADE');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('odds_target_snapshots');
    await knex.schema.dropTableIfExists('odds_changes');
    await knex.schema.dropTableIfExists('odds_observations');
}
