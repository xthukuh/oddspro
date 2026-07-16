// M4.1 AI enrichment (spec 2026-07-16): AI becomes a measurable multi-signal
// evidence source instead of a boolean adjudicator. One row per
// (fixture, kind, provider); upserted while kickoff > NOW() and frozen after.
//
// payload is JSON + schema_ver rather than typed columns on purpose: a new
// fact field costs a version bump, NOT a forward-only migration.
//
// fixture_id is INT UNSIGNED to match fixtures.id (int(10) unsigned) and
// fixture_predictions.fixture_id - a BIGINT here fails the FK with errno 150.
export async function up(knex) {
    await knex.schema.createTable('fixture_ai_insights', t => {
        t.integer('fixture_id').unsigned().notNullable()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.enu('kind', ['blind', 'anchored']).notNullable();
        t.string('provider', 32).notNullable();          // 'gemini' | 'openrouter'
        t.string('model_tag', 64).notNullable();         // incl. '+search' / '#e<N>'
        t.smallint('schema_ver').unsigned().notNullable();
        t.json('payload').notNullable();                 // facts + probabilities
        t.json('sources').nullable();                    // grounding citations
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.primary(['fixture_id', 'kind', 'provider']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('fixture_ai_insights');
}
