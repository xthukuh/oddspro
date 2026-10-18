// Pinnacle reference odds + the Sharp-anchored Pick shadow (2026-10-18).
//
// Research the same day (memory pinnacle-sharp-line-edge): our walk-forward
// calibration converges on the Kenyan price, so tips stay near -6% flat ROI.
// The one lever found is Pinnacle's sharp line (API-Football bookmaker 4):
// in the 1.50-2.20 band, legs whose best Kenyan price beats Pinnacle's
// devigged fair price returned +8% to +31% over 7 days. API-Football keeps
// odds only ~7 days after a fixture, so capture has to run daily from now on
// for a forward test to exist at all.
//
// reference_odds: append-only, one row per (fixture, bookmaker, market) per
// distinct upstream `update` stamp. A repeated capture of an unchanged line
// is an INSERT IGNORE no-op on the unique key. Never written at or after the
// canonical kickoff (the odds-history freeze rule, enforced by the writer).
//
// anchored_picks: the SHADOW card. One row per eligible fixture (its best
// leg), re-derived while the fixture is upcoming and frozen once it kicks
// off; settle columns are written exactly once by the settle pass. Never
// shown, never part of the live Pick or the daily card.

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
    await knex.schema.createTable('reference_odds', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('fixture_id').unsigned().notNullable();
        t.smallint('bookmaker_id').unsigned().notNullable().comment('API-Football bookmaker id (4 = Pinnacle)');
        t.string('market', 8).notNullable().comment("engine vocabulary: '1','X','2','O 2.5','U 2.5', ...");
        t.decimal('price', 8, 2).notNullable();
        t.datetime('source_updated_at').notNullable().comment('API `update` stamp, EAT wall clock');
        t.datetime('captured_at', { precision: 3 }).notNullable();
        t.string('source', 16).nullable().comment('full | due | cli');
        _base(knex, t);
        t.unique(['fixture_id', 'bookmaker_id', 'market', 'source_updated_at'], { indexName: 'reference_odds_line_unique' });
        t.index(['fixture_id', 'captured_at'], 'reference_odds_fixture_captured_index');
        t.foreign('fixture_id').references('id').inTable('fixtures').onDelete('CASCADE');
    });

    await knex.schema.createTable('anchored_picks', t => {
        t.bigIncrements('id').unsigned().primary();
        t.date('pick_date').notNullable().comment('EAT date of the canonical kickoff');
        t.integer('fixture_id').unsigned().notNullable();
        t.string('market', 8).notNullable();
        t.decimal('price', 8, 2).notNullable().comment('best Kenyan price at build time');
        t.string('provider', 16).notNullable();
        t.decimal('ref_price', 8, 2).notNullable().comment('Pinnacle price of the same market');
        t.decimal('fair_prob', 6, 4).notNullable().comment('Pinnacle devigged (multiplicative) probability');
        t.decimal('ratio', 6, 4).notNullable().comment('price x fair_prob');
        t.boolean('strong').notNullable().defaultTo(false);
        t.boolean('on_card').notNullable().defaultTo(false);
        t.datetime('ref_updated_at').nullable().comment('source_updated_at of the Pinnacle line used');
        t.datetime('computed_at').notNullable();
        t.enu('outcome', ['hit', 'miss', 'void']).nullable();
        t.string('score', 16).nullable();
        t.datetime('settled_at').nullable();
        _base(knex, t);
        t.unique(['fixture_id'], { indexName: 'anchored_picks_fixture_unique' });
        t.index(['pick_date'], 'anchored_picks_date_index');
        t.foreign('fixture_id').references('id').inTable('fixtures').onDelete('CASCADE');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('anchored_picks');
    await knex.schema.dropTableIfExists('reference_odds');
}
