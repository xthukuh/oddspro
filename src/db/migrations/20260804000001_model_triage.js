// Model-triage storage (docs/dev/specs/2026-08-04-2200-openrouter-model-triage-
// design.md): ONE append-only JSON-blob table for the self-contained
// src/modeltriage/ add-on. kind is 'snapshot' (normalized catalog pull),
// 'qualification' (probe results) or 'shortlist' (the ranked per-task
// recommendation the admin panel and auto-switch read). Diffs are derivable
// from consecutive snapshots, so no event table. Kept a plain string (not an
// enum) on purpose: the add-on is designed to lift out as a standalone tool,
// and a new row kind must not need a migration.
export async function up(knex) {
    await knex.schema.createTable('model_triage', table => {
        table.increments('id');
        table.string('kind', 16).notNullable();
        table.json('payload').notNullable();
        table.timestamps(true, true);
        // Newest-row-per-kind is the only read pattern (ORDER BY id DESC LIMIT 1).
        table.index(['kind', 'id']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('model_triage');
}
