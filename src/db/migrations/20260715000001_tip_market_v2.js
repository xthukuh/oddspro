// Widen the tip vocabulary for M3 any-market tips (spec 2026-07-15):
// tip_market must fit side-specific team-total keys ('TT:H:O 1.5'), and
// DNB pushes settle as 'void' (stake returned - neither hit nor miss).
export async function up(knex) {
    await knex.raw('ALTER TABLE fixture_predictions MODIFY tip_market VARCHAR(32) NULL COMMENT \'canonical tip market key, e.g. "1X", "O 2.5", "TT:H:O 1.5"\'');
    await knex.raw("ALTER TABLE fixture_predictions MODIFY tip_outcome ENUM('hit','miss','void') NULL");
}

export async function down(knex) {
    await knex.raw("ALTER TABLE fixture_predictions MODIFY tip_outcome ENUM('hit','miss') NULL");
    await knex.raw('ALTER TABLE fixture_predictions MODIFY tip_market VARCHAR(8) NULL');
}
