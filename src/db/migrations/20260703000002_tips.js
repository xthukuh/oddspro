// Phase 12b "Tip" column: the safest bettable outcome per fixture (any
// canonical market, not just O 2.5) with a blended confidence, stored on the
// existing pick ledger so it freezes at kickoff and settles like hot picks.
// tip_outcome is owned by the settle pass (mirrors result_goals/outcome).

export async function up(knex) {
    await knex.schema.alterTable('fixture_predictions', t => {
        t.string('tip_market', 8).nullable();          // canonical market key, e.g. '1X', 'O 2.5'
        t.decimal('tip_price', 8, 2).nullable();       // bookmaker price at compute time
        t.decimal('tip_confidence', 5, 4).nullable();  // blended market+stats+API confidence 0..1
        t.enu('tip_outcome', ['hit', 'miss']).nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('fixture_predictions', t => {
        t.dropColumn('tip_market');
        t.dropColumn('tip_price');
        t.dropColumn('tip_confidence');
        t.dropColumn('tip_outcome');
    });
}
