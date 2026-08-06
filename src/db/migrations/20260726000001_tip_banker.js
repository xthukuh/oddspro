// The Banker: the safest market the book offers on a fixture, persisted beside
// the value Tip rather than replacing it (2026-07-26 study).
//
// Two outputs, two jobs. tip_* stays the value pick behind its 1.20 price floor.
// tip_banker_* is the safety pick behind a 1.01 floor - over 1,199 settled tips
// it hit 92.1% against the Tip's 70.8% at a comparable flat-stake ROI, and was
// the only selector to clear 80% on all 14 replay days. Keeping BOTH columns is
// what lets the two accumulate settled evidence side by side on one population
// instead of splitting the ledger into two regimes.
//
// tip_banker_outcome mirrors tip_outcome exactly, including 'void' (a DNB push
// on a draw returns the stake), and is owned solely by the settle pass.
export async function up(knex) {
    await knex.schema.alterTable('fixture_predictions', table => {
        table.string('tip_banker_market', 32).nullable()
            .comment('safest offered market at the banker price floor, e.g. "O 0.5"');
        table.decimal('tip_banker_price', 8, 2).nullable();
        table.decimal('tip_banker_prob', 5, 4).nullable()
            .comment('devigged win probability of the banker market');
        table.enu('tip_banker_outcome', ['hit', 'miss', 'void']).nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('fixture_predictions', table => {
        table.dropColumn('tip_banker_market');
        table.dropColumn('tip_banker_price');
        table.dropColumn('tip_banker_prob');
        table.dropColumn('tip_banker_outcome');
    });
}
