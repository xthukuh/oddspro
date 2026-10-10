// Append-only ledger of daily production health snapshots (src/health.js).
//
// The writer instance lands one row per EAT day: the verdict, its reason codes
// and the full snapshot payload (the same JSON shape the host cron script
// appends to ~/ops/health/ledger.ndjson). Read back through the admin-only
// GET /api/admin/health/ledger|latest, so monitoring no longer depends on SSH
// access to the host. About 10 KB a row, one row a day: no retention needed.
// `day` is indexed, not unique: the one-per-day rule lives in the scheduler
// (src/db/health-rules.js#snapshotDecision), which keeps a deliberate manual
// re-take possible without a schema change.
export async function up(knex) {
    await knex.schema.createTable('health_snapshots', t => {
        t.bigIncrements('id');
        t.date('day').notNullable().comment('EAT calendar day the snapshot describes');
        t.datetime('taken_at').notNullable().comment('EAT wall clock');
        t.enu('verdict', ['GREEN', 'AMBER', 'RED']).notNullable();
        t.json('reasons').nullable().comment('reason codes, RED first, then AMBER, then carried');
        t.json('payload').nullable().comment('the full snapshot object; never carries a phone number');
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.index(['day'], 'health_snapshots_day_index');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('health_snapshots');
}
