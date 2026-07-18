// M4 legal consent (admin program 2026-07-19): record WHICH terms version a
// user accepted and WHEN, stamped at signup. Nullable - accounts predating the
// consent gate keep NULL (no retro-gate; ProfileView surfaces the legal docs
// to them instead).
export async function up(knex) {
    await knex.schema.alterTable('users', t => {
        t.datetime('terms_accepted_at').nullable();
        t.string('terms_version', 32).nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('users', t => {
        t.dropColumn('terms_version');
        t.dropColumn('terms_accepted_at');
    });
}
