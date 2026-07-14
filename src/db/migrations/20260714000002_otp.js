const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

// One-time SMS verification codes (v1.1.0). A separate table (not columns on
// users) because a code has its own lifecycle - reuse-within-TTL for SMS
// economy, per-code verify attempts, resend backoff (60·n), and audit across a
// change-phone. `code_hash` is sha256(code+pepper) - the plaintext code is only
// ever in the SMS. `phone` records the MSISDN the code was sent to, so it stays
// tied to the right number when the user changes phone before verifying.
//   consumed_at    - set once when the code verifies (single-use)
//   attempts       - failed verify tries against THIS code (lockout)
//   resend_count   - drives the 60·n resend cooldown
//   last_sent_at   - cooldown base
//   provider_msg_id- Bonga unique_id for a later delivery-report lookup

export async function up(knex) {
    await knex.schema.createTable('otp_codes', t => {
        t.bigIncrements('id').unsigned().primary();
        t.bigInteger('user_id').unsigned().notNullable()
            .references('id').inTable('users').onDelete('CASCADE');
        t.string('purpose', 24).notNullable().defaultTo('phone_verify'); // future: login/reset
        t.string('phone', 24).notNullable();                    // MSISDN the code went to
        t.string('code_hash', 64).notNullable();                // sha256(code+pepper) hex
        t.datetime('expires_at').notNullable().index();
        t.datetime('consumed_at').nullable();                   // set once on success
        t.smallint('attempts').unsigned().notNullable().defaultTo(0);
        t.smallint('resend_count').unsigned().notNullable().defaultTo(0);
        t.datetime('last_sent_at').notNullable().defaultTo(knex.fn.now());
        t.string('provider_msg_id', 64).nullable();
        _base(knex, t);
        t.index(['user_id', 'purpose']);
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('otp_codes');
}
