// One row per warning about a span of match dates.
//
// `kind` is deliberately open text: a future discovery (missing provider,
// linker gap, late settlement) is a new kind value and needs no schema change.
// The unique index makes the detector idempotent AND makes a dismissal stick,
// since re-proposing the same span would collide with the dismissed row.
export async function up(knex) {
    await knex.schema.createTable('data_notices', t => {
        t.bigIncrements('id');
        t.string('kind', 32).notNullable();
        t.enu('severity', ['degraded', 'outage']).notNullable();
        t.enu('status', ['unconfirmed', 'approved', 'dismissed']).notNullable().defaultTo('unconfirmed');
        t.enu('source', ['auto', 'manual']).notNullable().defaultTo('auto');
        t.date('date_from').notNullable();
        t.date('date_to').notNullable();
        t.string('title', 80).notNullable();
        t.string('note', 240).notNullable();
        t.json('evidence').nullable();
        t.bigInteger('created_by').unsigned().nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.foreign('created_by').references('users.id').onDelete('SET NULL');
        t.unique(['source', 'kind', 'date_from', 'date_to'], 'data_notices_span_unique');
        t.index(['date_from', 'date_to'], 'data_notices_span_index');
    });

    // The one known historical event. It predates collection_runs, so it can
    // never be auto-detected; it is recorded by hand, approved, once.
    // 2026-08-19 is deliberately NOT included: 469 rows against a recovering
    // day is thin but the pass succeeded, and flagging it would teach readers
    // that the ribbon fires on ordinary variation.
    await knex('data_notices').insert({
        kind: 'odds_outage',
        severity: 'outage',
        status: 'approved',
        source: 'manual',
        date_from: '2026-08-16',
        date_to: '2026-08-18',
        title: 'No odds collected',
        note: 'Collection was down. Odds for these games were never captured.',
        evidence: JSON.stringify({
            outage_start: '2026-08-16T01:20:00+03:00',
            outage_end: '2026-08-19T00:00:00+03:00',
            rows_by_day: { '2026-08-16': 1049, '2026-08-17': 203, '2026-08-18': 57 },
            healthy_band: [1000, 3000],
            doc: 'docs/research/2026-08-19-odds-durability-and-outage-damage.md',
        }),
        created_by: null,
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('data_notices');
}
