// Live match minute: API-Football's fixture.status.elapsed, refreshed by the
// same paths that refresh status/scores (date fetch + results settle). Only
// meaningful while a fixture is in play; stays at its last seen value once
// final (display reads it for live statuses only).

export async function up(knex) {
    await knex.schema.alterTable('fixtures', t => {
        t.smallint('elapsed').unsigned().nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('fixtures', t => {
        t.dropColumn('elapsed');
    });
}
