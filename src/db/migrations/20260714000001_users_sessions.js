import { hashPin } from '../../auth-rules.js';

const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

// Common table setup: charset + created_at/updated_at maintained by MySQL.
function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

// v1.1.0 user accounts + sessions.
//   users    - one row per person. Phone (E.164) is the username. `role` is a
//              two-value system (normal | admin); guests are unauthenticated and
//              never stored. `pin_hash` is the self-describing scrypt string
//              (src/auth-rules.js); lockout is tracked on the row.
//   sessions - opaque bearer tokens stored HASHED (sha256 hex), so a DB leak
//              never yields a usable token. Revocable (revoked_at) and
//              multi-device (one row per login). Expired/revoked rows are just
//              filtered out at resolve time.
// A default admin (id=1, +254799944004) is seeded if-not-exist, with a PIN from
// ADMIN_SEED_PIN (default 0000) hashed with PIN_PEPPER and must_change_pin set,
// so first login is a one-time bootstrap that forces a real PIN.

export async function up(knex) {
    await knex.schema.createTable('users', t => {
        t.bigIncrements('id').unsigned().primary();
        t.string('name', 120).notNullable();
        t.string('role', 16).notNullable().defaultTo('normal');   // normal | admin
        t.string('phone', 24).notNullable().unique();             // E.164 (+2547...)
        t.string('phone_region', 2).notNullable();                // ISO 3166-1 alpha-2
        t.string('phone_code', 8).notNullable();                  // calling code (254)
        t.string('phone_carrier', 48).nullable();                 // best-effort enrich
        t.boolean('phone_verified').notNullable().defaultTo(false);
        t.string('pin_hash', 255).notNullable();                  // scrypt$N$r$p$salt$dk
        t.smallint('pin_attempts').unsigned().notNullable().defaultTo(0);
        t.datetime('locked_until').nullable();                    // lockout expiry
        t.boolean('must_change_pin').notNullable().defaultTo(false);
        t.boolean('is_active').notNullable().defaultTo(true);
        t.datetime('last_login_at').nullable();
        _base(knex, t);
        t.index('role');
    });

    await knex.schema.createTable('sessions', t => {
        t.bigIncrements('id').unsigned().primary();
        t.bigInteger('user_id').unsigned().notNullable()
            .references('id').inTable('users').onDelete('CASCADE');
        t.string('token_hash', 64).notNullable().unique();        // sha256(token) hex
        t.datetime('expires_at').notNullable().index();
        t.datetime('last_seen_at').nullable();
        t.datetime('revoked_at').nullable();
        t.string('user_agent', 512).nullable();                   // device label
        t.string('ip', 45).nullable();
        _base(knex, t);
        t.index('user_id');
    });

    // Idempotent seed - a re-run (or migrating a DB that already has the admin)
    // never duplicates or overwrites. process.env is populated by dotenv (config
    // is imported via knexfile), so ADMIN_SEED_PIN / PIN_PEPPER apply here.
    const exists = await knex('users').where('id', 1).first();
    if (!exists) {
        await knex('users').insert({
            id: 1,
            name: 'Administrator',
            role: 'admin',
            phone: '+254799944004',
            phone_region: 'KE',
            phone_code: '254',
            phone_carrier: 'Safaricom',
            phone_verified: 1,
            is_active: 1,
            must_change_pin: 1,
            pin_hash: hashPin(process.env.ADMIN_SEED_PIN || '0000', { pepper: process.env.PIN_PEPPER || '' }),
        });
    }
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('sessions');
    await knex.schema.dropTableIfExists('users');
}
