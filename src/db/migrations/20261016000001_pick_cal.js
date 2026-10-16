// The Pick (2026-10-16, src/db/pick-rules.js) reuses the tip_banker_* columns:
// from this date they hold one market per game priced 1.50-2.20, chosen by our
// walk-forward residual calibration, instead of the retired Banker (the
// shortest price on the board, O 0.5 in 30% of games). Rows written before
// the switch keep their old banker values untouched (frozen past kickoff);
// readers tell the two apart with pick-rules isPick().
//
// tip_banker_prob keeps its meaning (the devigged book probability). This
// column carries OUR calibrated win chance - the number the Pick was chosen
// by, ranked by and shown with - so no reader re-derives it from cells that
// may have moved since the sweep wrote the row.
export async function up(knex) {
    await knex.schema.alterTable('fixture_predictions', table => {
        table.decimal('tip_banker_cal', 5, 4).nullable()
            .comment('our calibrated win chance of the Pick (pick-rules.js), 2026-10-16+');
    });
}

export async function down(knex) {
    await knex.schema.alterTable('fixture_predictions', table => {
        table.dropColumn('tip_banker_cal');
    });
}
