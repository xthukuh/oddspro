// Records that a bookmaker listing has its home/away sides the opposite way
// round from the canonical fixture it is linked to.
//
// This is not a linking mistake. API-Football keeps `home_team_id`/
// `away_team_id` in the fixtures upsert merge list, so it can SWAP a fixture's
// sides after we have already linked it (neutral-venue ties and friendlies are
// where it happens), and nothing re-checked the orientation afterwards. The
// link stays correct - same two teams, same kickoff - but the read layer pairs
// the BOOKMAKER's team names with the CANONICAL score, so the row then displays
// a result the wrong way round: fixture 1548857 rendered as
// "FC Annecy - FC Sion 4-0" when Sion won 4-0 (found 2026-08-19, 13 rows over
// 7 fixtures, both providers agreeing with each other and against the fixture).
//
// The flag is maintained by the link pass's orientation re-validation and read
// by src/db/records.js, which swaps the displayed score. The stored score
// columns stay in the canonical fixture's orientation, so the settle pass - the
// most failure-prone SQL in the codebase - needs no change at all.
export async function up(knex) {
    await knex.schema.alterTable('matches', t => {
        t.boolean('sides_swapped').notNullable().defaultTo(false)
            .comment('bookmaker home/away is reversed vs the linked fixture; read layer swaps the score');
    });
}

export async function down(knex) {
    await knex.schema.alterTable('matches', t => {
        t.dropColumn('sides_swapped');
    });
}
