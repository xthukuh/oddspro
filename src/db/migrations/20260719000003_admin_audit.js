const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

// M6 (admin program 2026-07-19): dated old->new trail of every admin action.
// Settings writes land here IN THE SAME TRANSACTION as the override upsert
// (src/settings.js), which is what lets policy-regime knobs (TIP_*, HOTPICK_*,
// DARK switches) be admin-editable at all - the audit dates every ledger-
// splitting change for mine-patterns, replacing the manual memory-bank
// dated-note discipline (spec decision 3). Later milestones append their own
// actions (M8 user.patch, ...) - `action` is namespaced 'area.verb'.
// actor_id is a NULLABLE audit pointer (SET NULL, the settings.updated_by
// prior art): deleting a user must not delete the trail they left.

export async function up(knex) {
    await knex.schema.createTable('admin_audit', t => {
        t.charset(CHARSET);
        t.collate(COLLATE);
        t.bigIncrements('id').unsigned();
        t.bigInteger('actor_id').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.string('action', 48).notNullable();      // e.g. 'settings.set' / 'settings.reset'
        t.string('target', 128).notNullable();     // e.g. the settings key
        t.text('old_value').nullable();            // stored override string; null = was at config default
        t.text('new_value').nullable();            // null = reset to config default
        t.json('meta').nullable();                 // action-specific context (unused by M6)
        t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at').notNullable()
            .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.index(['created_at'], 'idx_admin_audit_created');
        t.index(['target', 'created_at'], 'idx_admin_audit_target');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('admin_audit');
}
