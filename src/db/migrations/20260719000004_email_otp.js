// M13 email OTP fallback (admin program 2026-07-19): a deliverability escape
// hatch when SMS can't reach a user. `users.email` is nullable and deliberately
// NOT unique - phone stays the sole login identity, an email may be shared
// across accounts (a family inbox); it's captured the first time an email OTP
// is requested on an authenticated flow. `otp_codes.channel` records where a
// code went ('sms'|'email') and `otp_codes.email` the address (mirroring
// otp_codes.phone), so verify-time guards and audit stay per-send accurate.
export async function up(knex) {
    await knex.schema.alterTable('users', t => {
        t.string('email', 254).nullable();
    });
    await knex.schema.alterTable('otp_codes', t => {
        t.string('channel', 8).notNullable().defaultTo('sms');
        t.string('email', 254).nullable();
    });
}

export async function down(knex) {
    await knex.schema.alterTable('otp_codes', t => {
        t.dropColumn('email');
        t.dropColumn('channel');
    });
    await knex.schema.alterTable('users', t => {
        t.dropColumn('email');
    });
}
