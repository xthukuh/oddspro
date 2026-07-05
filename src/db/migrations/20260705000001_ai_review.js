// AI adjudicator v2: structured review storage. The v1 adjudicators kept
// only a one-line reason string; v2 verdicts carry the model's own
// probability estimate, per-check findings (competition context, verified
// team news, market view) and google_search grounding citations - persisted
// verbatim so every confirm/veto is auditable in the web popover, exactly
// like tip_breakdown made the rule blend auditable.

export async function up(knex) {
    await knex.schema.alterTable('fixture_predictions', t => {
        t.json('ai_review').nullable();     // hot-pick adjudicator structured verdict
        t.json('tip_ai_review').nullable(); // tip reviewer structured verdict
    });
}

export async function down(knex) {
    await knex.schema.alterTable('fixture_predictions', t => {
        t.dropColumn('ai_review');
        t.dropColumn('tip_ai_review');
    });
}
