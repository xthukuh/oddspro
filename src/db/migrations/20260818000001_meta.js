// Cross-instance meta key/value table. The live host runs three concurrent
// `src/server.js` processes; this table is the shared home for state that
// must not be triplicated (warehouse_version, last_success, column_catalog,
// refresh_request), read/written through src/meta.js.
export async function up(knex) {
    await knex.schema.createTable('meta', t => {
        t.string('k', 64).primary();
        t.text('v', 'longtext').nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    });
    await knex('meta').insert({ k: 'warehouse_version', v: '0' });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('meta');
}
