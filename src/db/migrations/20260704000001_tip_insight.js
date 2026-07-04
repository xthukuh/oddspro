// Phase 13 tip insight: justification + eligibility + AI review columns on
// the pick ledger. tip_breakdown persists the full bestTip blend (components,
// effective weights, samples, runners-up) so every tip is auditable;
// tip_skip_reason marks fixtures that never got a tip (insufficient_history /
// no_markets / no_pick); tip_ai_* mirror the hot-pick adjudicator columns for
// the web-grounded tip reviewer (veto flags but never clears a tip - the
// outcome still settles, so the AI's value is measurable).

export async function up(knex) {
    await knex.schema.alterTable('fixture_predictions', t => {
        t.json('tip_breakdown').nullable();           // bestTip return, verbatim
        t.string('tip_skip_reason', 64).nullable();   // why no tip was emitted
        t.enu('tip_ai_verdict', ['confirm', 'veto', 'error']).nullable();
        t.string('tip_ai_reason', 512).nullable();
        t.string('tip_ai_model', 64).nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('fixture_predictions', t => {
        t.dropColumn('tip_breakdown');
        t.dropColumn('tip_skip_reason');
        t.dropColumn('tip_ai_verdict');
        t.dropColumn('tip_ai_reason');
        t.dropColumn('tip_ai_model');
    });
}
