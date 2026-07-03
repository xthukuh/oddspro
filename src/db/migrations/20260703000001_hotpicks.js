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

// Phase 12 hot picks (Over 2.5 goals, rule-based):
// - fixture_api_predictions: API-Football /predictions payload per fixture
//   (external evidence, fetch-once via fixtures.predictions_fetched_at);
// - fixture_predictions: our pick ledger - every evaluated upcoming fixture
//   gets a row (signals kept for calibration), `hot` marks the picks. Rows
//   freeze at kickoff (selection rule, like fixture_prematch) and are settled
//   against canonical final scores (result_goals/outcome) by the hotpicks
//   action, never rewritten after.

export async function up(knex) {
    await knex.schema.alterTable('fixtures', t => {
        t.datetime('predictions_fetched_at').nullable(); // fetch-once flag (sibling of history_fetched_at)
    });

    await knex.schema.createTable('fixture_api_predictions', t => {
        t.integer('fixture_id').unsigned().primary()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.string('advice', 255).nullable();          // e.g. "Combo Double chance : X or draw and -3.5 goals"
        t.decimal('percent_home', 5, 2).nullable();  // parsed from "45%"
        t.decimal('percent_draw', 5, 2).nullable();
        t.decimal('percent_away', 5, 2).nullable();
        t.string('under_over', 8).nullable();        // API string, e.g. "+2.5" / "-3.5"
        t.string('goals_home', 8).nullable();        // API string, e.g. "-2.5" (verbatim; raw has everything)
        t.string('goals_away', 8).nullable();
        t.json('raw').nullable();
        _base(knex, t);
    });

    await knex.schema.createTable('fixture_predictions', t => {
        t.integer('fixture_id').unsigned().primary()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.string('market', 16).notNullable().defaultTo('O 2.5');
        t.boolean('hot').notNullable().defaultTo(false);
        t.decimal('score', 6, 3).nullable();         // composite confidence (ranking/tooltips)
        t.json('signals').nullable();                // [{key, value, threshold, pass}] audit trail
        t.decimal('over_price', 8, 2).nullable();    // prices seen at compute time
        t.decimal('under_price', 8, 2).nullable();
        t.decimal('implied_over', 6, 4).nullable();  // vig-removed P(over 2.5)
        t.boolean('api_advice_supports').nullable(); // API-Football signal: true/false/null=neutral
        t.enu('ai_verdict', ['confirm', 'veto', 'error']).nullable();
        t.string('ai_reason', 512).nullable();
        t.string('ai_model', 64).nullable();
        t.tinyint('result_goals').unsigned().nullable(); // settled from canonical FT scores
        t.enu('outcome', ['hit', 'miss']).nullable();
        t.datetime('computed_at').notNullable();
        _base(knex, t);
        t.index(['hot', 'computed_at']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('fixture_predictions');
    await knex.schema.dropTableIfExists('fixture_api_predictions');
    await knex.schema.alterTable('fixtures', t => {
        t.dropColumn('predictions_fetched_at');
    });
}
