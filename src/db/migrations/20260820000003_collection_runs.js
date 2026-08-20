// Append-only ledger of every refresh job the writer instance finishes.
//
// The pipeline already grades each run ok/partial/error (summarizeSteps,
// src/db/auto-rules.js) and then throws the verdict away in a log line.
// Persisting it is what makes outage detection a lookup instead of a
// statistical guess: no successful run for a stretch = outage, a partial run
// = degraded. Bounded by COLLECTION_RUNS_RETENTION_DAYS (default 90); at the
// 10-minute light cadence that is roughly 13k rows.
export async function up(knex) {
    await knex.schema.createTable('collection_runs', t => {
        t.bigIncrements('id');
        t.datetime('started_at').notNullable();
        t.datetime('finished_at').notNullable();
        t.string('mode', 16).notNullable().comment('full | light | manual');
        t.json('dates').nullable().comment('match dates this pass covered');
        t.enu('verdict', ['ok', 'partial', 'error', 'cancelled']).notNullable();
        t.json('step_failures').nullable().comment('[{step, error}], empty on ok');
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.index(['finished_at'], 'collection_runs_finished_at_index');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('collection_runs');
}
