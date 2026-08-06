// Multi-card days (engine-v2, owner directive 2026-08-06): the day's legs
// split into small cards (legs carry a `card` index inside the legs JSON).
// `outcome` keeps its STRICT all-cards meaning (unchanged semantics);
// cards_won/cards_total surface the any-green survivability the grouping
// buys (35/35 days with >=1 winning card in the replay).
export async function up(knex) {
    await knex.schema.alterTable('daily_slips', table => {
        table.integer('cards_total').notNullable().defaultTo(0);
        table.integer('cards_won').nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('daily_slips', table => {
        table.dropColumn('cards_total');
        table.dropColumn('cards_won');
    });
}
