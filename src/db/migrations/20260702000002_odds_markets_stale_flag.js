// Stale odds retention: markets that vanish from a subsequent bookmaker
// update are no longer deleted - they are flagged stale and kept as the
// last-seen price (greyed out in the UI, excluded from sort/filter pivots).
// Existing rows default to fresh (is_stale = 0); no backfill needed.

export async function up(knex) {
    await knex.schema.alterTable('odds_markets', t => {
        t.boolean('is_stale').notNullable().defaultTo(false);
    });
}

export async function down(knex) {
    await knex.schema.alterTable('odds_markets', t => {
        t.dropColumn('is_stale');
    });
}
