// Shareable user slips (engine-v2 Phase 4): a saved betslip-playground book
// entry per row. Legs are SELF-CONTAINED JSON (the oddspro.betslips idiom) so
// a slip renders and settles regardless of the loaded date. `code` is the
// human-friendly share handle (6-char Crockford base32, collision-retried at
// insert); `source_code` records provenance when a slip was loaded from
// someone else's code and copied. created_at IS the timeline stamp. The
// settle pass alone owns legs_hit/outcome/settled_at.
export async function up(knex) {
    await knex.schema.createTable('user_slips', table => {
        table.increments('id');
        table.bigInteger('user_id').unsigned().notNullable()
            .references('id').inTable('users').onDelete('CASCADE');
        table.string('code', 8).notNullable().unique();
        table.string('title', 80).nullable();
        table.json('legs').notNullable();
        table.decimal('combined_odds', 12, 2).nullable();
        table.integer('legs_total').notNullable().defaultTo(0);
        table.integer('legs_hit').nullable();
        table.enu('outcome', ['won', 'lost', 'void']).nullable()
            .comment('NULL = pending; owned solely by the settle pass');
        table.string('source_code', 8).nullable();
        table.datetime('settled_at').nullable();
        table.timestamps(true, true);
        table.index(['user_id', 'created_at']);
    });
}

export async function down(knex) {
    await knex.schema.dropTable('user_slips');
}
