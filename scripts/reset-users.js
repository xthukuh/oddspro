// Reset user accounts: wipe ALL users (sessions / otp_codes / user_prefs
// cascade; settings.updated_by goes SET NULL) and re-seed the default admin
// exactly like the users migration - phone +254799944004, PIN from
// ADMIN_SEED_PIN hashed with the CURRENT PIN_PEPPER, must_change_pin set.
//
// This is the recovery tool for the documented pepper trap: a changed
// PIN_PEPPER invalidates every stored PIN hash (deliberate global reset),
// after which no account - including the seeded admin - can sign in.
//
//   node scripts/reset-users.js        # dry-run: shows what would be deleted
//   node scripts/reset-users.js --yes  # actually wipe + re-seed
import { db, closeDb } from '../src/db/connection.js';
import { config } from '../src/config.js';
import { hashPin } from '../src/auth-rules.js';

const confirmed = process.argv.includes('--yes');

try {
    const [{ n }] = await db('users').count({ n: '*' });
    const [{ s }] = await db('sessions').count({ s: '*' });
    console.log(`users: ${n}, sessions: ${s} (sessions/otp/prefs cascade with the wipe)`);
    if (!config.PIN_PEPPER) {
        console.warn('[warn] PIN_PEPPER is unset - the re-seeded admin PIN will be salt-only (dev only).');
    }
    if (!confirmed) {
        console.log('Dry-run. Re-run with --yes to wipe all users and re-seed the admin.');
    } else {
        await db('users').del();
        await db('users').insert({
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
            pin_hash: hashPin(config.ADMIN_SEED_PIN, { pepper: config.PIN_PEPPER || '' }),
        });
        console.log(`Wiped ${n} user(s); re-seeded admin +254799944004 with the current ADMIN_SEED_PIN/PIN_PEPPER (must_change_pin=1).`);
    }
} finally {
    await closeDb();
}
