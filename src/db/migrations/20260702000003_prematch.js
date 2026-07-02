const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

// Common table setup: charset + created_at/updated_at maintained by MySQL.
function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

// Historical pre-match snapshots: one row per fixture, upserted on every
// pipeline run while the fixture is upcoming and frozen once kickoff passes,
// so later matches never alter an old fixture's pre-match view.
// `history_fetched_at` is the fetch-once flag for the team-history backfill
// (last-N team fixtures + full head-to-head from API-Football).

export async function up(knex) {
    await knex.schema.alterTable('fixtures', t => {
        t.datetime('history_fetched_at').nullable(); // fetch-once flag (sibling of stats_fetched_at)
    });

    await knex.schema.createTable('fixture_prematch', t => {
        t.integer('fixture_id').unsigned().primary()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.smallint('home_rank').unsigned().nullable();
        t.string('home_form', 16).nullable();
        t.smallint('away_rank').unsigned().nullable();
        t.string('away_form', 16).nullable();
        t.string('h2h', 16).nullable();                    // "2W-1D-0L", home perspective
        t.smallint('h2h_count').unsigned().nullable();     // all known finished meetings before kickoff
        t.smallint('h2h_n').unsigned().nullable();         // meetings inside the H2H window
        t.smallint('h2h_home_goals').unsigned().nullable();
        t.smallint('h2h_away_goals').unsigned().nullable();
        t.smallint('home_oth_n').unsigned().nullable();    // last-N vs all other teams
        t.smallint('home_oth_gf').unsigned().nullable();
        t.smallint('home_oth_ga').unsigned().nullable();
        t.smallint('away_oth_n').unsigned().nullable();
        t.smallint('away_oth_gf').unsigned().nullable();
        t.smallint('away_oth_ga').unsigned().nullable();
        t.datetime('computed_at').notNullable();
        _base(knex, t);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('fixture_prematch');
    await knex.schema.alterTable('fixtures', t => {
        t.dropColumn('history_fetched_at');
    });
}
