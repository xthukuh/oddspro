// Daily MultiBet slips (engine-v2 final touches, spec 2026-08-06-0100):
// one row per EAT day. Legs are SELF-CONTAINED JSON (fixture, teams,
// kickoff, market, prices, calibrated prob, reasoning) so a slip renders
// and settles regardless of what else changes - the oddspro.betslips leg
// idiom. Freeze discipline: the builder never rewrites a row once any leg
// has kicked off; the settle pass alone owns legs_hit/outcome/settled_at.
// backfilled marks rows written by the hindsight-free replay generator so
// the timeline is honest about live vs replayed entries.
export async function up(knex) {
    await knex.schema.createTable('daily_slips', table => {
        table.increments('id');
        table.date('slip_date').notNullable().unique();
        table.enu('status', ['published', 'no_slip']).notNullable();
        table.enu('mood', ['green', 'amber', 'red']).notNullable();
        table.json('legs').notNullable();
        table.decimal('combined_odds', 10, 2).nullable();
        table.integer('legs_total').notNullable().defaultTo(0);
        table.integer('legs_hit').nullable();
        table.enu('outcome', ['won', 'lost', 'void']).nullable()
            .comment('NULL = pending; owned solely by the settle pass');
        table.string('algo_version', 32).notNullable();
        table.boolean('backfilled').notNullable().defaultTo(false);
        table.datetime('computed_at').notNullable();
        table.datetime('settled_at').nullable();
        table.timestamps(true, true);
    });
}

export async function down(knex) {
    await knex.schema.dropTable('daily_slips');
}
