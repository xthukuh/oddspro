import crypto from 'node:crypto';
import { db } from './db/connection.js';
import { config } from './config.js';
import { AuthError } from './auth.js';
import { hashPinAsync } from './auth-rules.js';
import {
    patchGuards, buildUserUpdate, patchRevokesSessions, newTempPin,
    buildUserAuditRows, adminUserView,
} from './db/admin-rules.js';

// Admin user management (M8): thin knex orchestration over the pure rules in
// src/db/admin-rules.js - the same service idiom as settings.js/auth.js. Every
// mutation lands its changed-only admin_audit rows IN THE SAME TRANSACTION as
// the users update (the M6 discipline: a change without its trail can never be
// observed). The temp PIN from reset_pin exists only in the PATCH response -
// never stored in plaintext, never logged, never audited.

// The PIN pepper comes from config, not effective() - secrets are excluded
// from the settings catalog by construction, same as auth.js.
const PEPPER = () => config.PIN_PEPPER || '';

const ACTIVE_SESSIONS_SQL = `(
    select count(*) from sessions s
    where s.user_id = users.id and s.revoked_at is null and s.expires_at > NOW()
)`;

function _uid(id) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw new AuthError(404, 'User not found');
    return n;
}

async function _activeSessionCount(userId) {
    const row = await db('sessions').where('user_id', userId)
        .whereNull('revoked_at').where('expires_at', '>', db.fn.now())
        .count('* as c').first();
    return Number(row?.c) || 0;
}

// List every user with their live-session count, newest last (id asc keeps the
// seeded admin at the top). `q` narrows on phone or name; the web section also
// filters client-side, so q mainly serves future scale.
export async function listUsers({ q = '', limit = 500 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 500, 1), 1000);
    const query = db('users')
        .select('users.*', db.raw(`${ACTIVE_SESSIONS_SQL} as active_sessions`))
        .orderBy('users.id', 'asc')
        .limit(cap);
    const term = String(q ?? '').trim();
    if (term) {
        query.where(w => w.where('users.phone', 'like', `%${term}%`).orWhere('users.name', 'like', `%${term}%`));
    }
    const rows = await query;
    const total = await db('users').count('* as c').first();
    return {
        users: rows.map(u => adminUserView(u, { activeSessions: Number(u.active_sessions) || 0 })),
        total: Number(total?.c) || 0,
    };
}

export async function getAdminUser(id) {
    const uid = _uid(id);
    const u = await db('users').where('id', uid).first();
    if (!u) throw new AuthError(404, 'User not found');
    return adminUserView(u, { activeSessions: await _activeSessionCount(uid) });
}

// Apply a validated patch (userPatchSchema - the route parses) to a user.
// Guards run against the CURRENT row + the current active-admin set; a
// violation is a 400 before anything is touched. reset_pin mints a 4-digit
// temp PIN, installs its hash with must_change_pin set (first sign-in forces
// a real PIN) and revokes every session; disable revokes sessions too
// (resolveSession would reject a disabled user anyway - the revoke is the
// belt). Returns { user } plus { temp_pin } only when one was issued.
export async function patchUser(id, patch, actor) {
    const uid = _uid(id);
    const target = await db('users').where('id', uid).first();
    if (!target) throw new AuthError(404, 'User not found');

    const activeAdminIds = (await db('users').where({ role: 'admin', is_active: 1 }).select('id')).map(r => r.id);
    const guard = patchGuards({ actorId: actor.id, target, patch, activeAdminIds });
    if (!guard.ok) throw new AuthError(400, guard.error);

    let tempPin = null;
    let tempPinHash = null;
    if (patch.reset_pin) {
        tempPin = newTempPin(crypto.randomInt);
        tempPinHash = await hashPinAsync(tempPin, { pepper: PEPPER() });
    }

    const update = buildUserUpdate(patch, { tempPinHash });
    const audit = buildUserAuditRows({ actorId: actor.id, user: target, patch });
    await db.transaction(async trx => {
        if (Object.keys(update).length) await trx('users').where('id', uid).update(update);
        if (patchRevokesSessions(patch)) {
            // auth.js#revokeAllForUser, but on THIS transaction: the revoke
            // must land or roll back together with the row change.
            await trx('sessions').where('user_id', uid).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
        }
        if (audit.length) await trx('admin_audit').insert(audit);
    });

    const fresh = await db('users').where('id', uid).first();
    const user = adminUserView(fresh, { activeSessions: await _activeSessionCount(uid) });
    return tempPin ? { user, temp_pin: tempPin } : { user };
}
