// Personal access tokens (engine-v2 Phase 2): admin-minted, tied to a user
// account, consumed by integrations (n8n) and Claude's grounding reads.
// Only the sha256 lands here (session idiom); prefix is the display handle.
// created_by is the SET NULL audit pointer (settings.updated_by precedent).
export async function up(knex) {
    await knex.schema.createTable('personal_access_tokens', table => {
        table.increments('id');
        // users.id is bigIncrements: FK columns must be bigint unsigned
        // (errno 150 otherwise; settings.updated_by precedent).
        table.bigInteger('user_id').unsigned().notNullable()
            .references('id').inTable('users').onDelete('CASCADE');
        table.string('name', 64).notNullable();
        table.string('token_hash', 64).notNullable().unique();
        table.string('prefix', 12).notNullable();
        table.json('scopes').notNullable();
        table.datetime('last_used_at').nullable();
        table.datetime('expires_at').nullable();
        table.datetime('revoked_at').nullable();
        table.bigInteger('created_by').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        table.timestamps(true, true);
    });
}

export async function down(knex) {
    await knex.schema.dropTable('personal_access_tokens');
}
