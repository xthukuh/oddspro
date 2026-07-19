import { z } from 'zod';
import { generateOtp } from './sms-rules.js'; // pure, offline - one random-digits generator (C1)

// Pure admin user-management rules (M8): the PATCH /api/admin/users/:id
// envelope, the self/last-admin guards, the users-table update builder, the
// session-revoke predicate, temp-PIN generation and the changed-only audit
// rows. Zod-only (the src/db convention for schema-bearing pure modules);
// src/admin-users.js is the thin knex orchestration over these.

// What an admin may change on a user row. STRICT: pin_hash/phone/etc can never
// ride a patch. unlock / force_pin_change / reset_pin are ONE-WAY actions -
// `true` performs them, omission is the only "no" (false is invalid, so a
// client bug that sends every key with booleans fails loudly instead of
// silently unlocking accounts).
export const userPatchSchema = z.object({
    is_active: z.boolean().optional(),
    role: z.enum(['normal', 'admin']).optional(),
    phone_verified: z.boolean().optional(),      // manual verify (SMS-less fallback)
    unlock: z.literal(true).optional(),          // clear PIN lockout + attempts
    force_pin_change: z.literal(true).optional(),
    reset_pin: z.literal(true).optional(),       // temp PIN + forced change + revoke
}).strict().refine(d => Object.keys(d).length > 0, { message: 'Nothing to change' });

// Would this patch remove the target from the ACTIVE-admin set and leave it
// empty? `activeAdminIds` = ids of ALL currently active admins (one SELECT).
// String-compare ids - mysql2 BIGINTs may arrive as strings. Session-only
// routes make this near-unreachable today (the actor IS an active admin and
// the self-guards catch self-removal), but the pure rule can't know what a
// future caller guarantees - defense in depth, not dead code.
export function lastAdminViolation(target, patch, activeAdminIds = []) {
    const removes = patch.is_active === false || (patch.role != null && patch.role !== 'admin');
    if (!removes) return false;
    if (!(target.role === 'admin' && target.is_active)) return false;
    return !activeAdminIds.some(id => String(id) !== String(target.id));
}

// First violated guard, or ok. Self rules: you cannot disable or demote the
// account you are signed in with, and your own PIN belongs to the profile
// flow (a self reset would revoke the very session making the request).
export function patchGuards({ actorId, target, patch, activeAdminIds = [] }) {
    const self = String(actorId) === String(target.id);
    if (self && patch.is_active === false) return { ok: false, error: 'You cannot disable your own account' };
    if (self && patch.role === 'normal' && target.role === 'admin') {
        return { ok: false, error: 'You cannot demote your own account' };
    }
    if (self && (patch.reset_pin || patch.force_pin_change)) {
        return { ok: false, error: 'Use your profile to change your own PIN' };
    }
    if (lastAdminViolation(target, patch, activeAdminIds)) {
        return { ok: false, error: 'Cannot remove the last active admin' };
    }
    return { ok: true };
}

// Patch -> users UPDATE object. reset_pin also clears the lockout: a locked
// user being rescued with a temp PIN must be able to USE it immediately.
export function buildUserUpdate(patch, { tempPinHash = null } = {}) {
    const update = {};
    if (patch.is_active != null) update.is_active = patch.is_active ? 1 : 0;
    if (patch.role) update.role = patch.role;
    if (patch.phone_verified != null) update.phone_verified = patch.phone_verified ? 1 : 0;
    if (patch.unlock) { update.pin_attempts = 0; update.locked_until = null; }
    if (patch.force_pin_change) update.must_change_pin = 1;
    if (patch.reset_pin) {
        update.pin_hash = tempPinHash;
        update.must_change_pin = 1;
        update.pin_attempts = 0;
        update.locked_until = null;
    }
    return update;
}

// Disable and reset_pin kill every live session (resolveSession would reject a
// disabled user anyway - the revoke is the belt; for a possibly-compromised
// account getting a PIN reset it is the point). A demotion does NOT revoke:
// the per-request role check strips admin access on its own.
export function patchRevokesSessions(patch) {
    return patch.is_active === false || patch.reset_pin === true;
}

// 4-digit temp PIN (the users PIN format), leading zeros preserved.
// `randomInt` injected - crypto.randomInt in production, a stub in tests.
export function newTempPin(randomInt) {
    return generateOtp(4, randomInt);
}

// --- admin_audit rows (same table/contract as the M6 settings trail) ---------
// Namespaced 'area.verb' actions; changed-only vs the CURRENT row, so a no-op
// patch (re-saving the shown state) leaves no trail. reset_pin ALWAYS lands -
// and never carries PIN material (the trail proves when/who, never what).
export const AUDIT_USER_PATCH = 'user.patch';
export const AUDIT_USER_UNLOCK = 'user.unlock';
export const AUDIT_USER_FORCE_PIN = 'user.force_pin_change';
export const AUDIT_USER_RESET_PIN = 'user.reset_pin';

export function buildUserAuditRows({ actorId = null, user, patch }) {
    const rows = [];
    const push = (action, field, oldV, newV) => rows.push({
        actor_id: actorId, action,
        target: field ? `user:${user.id}:${field}` : `user:${user.id}`,
        old_value: oldV == null ? null : String(oldV),
        new_value: newV == null ? null : String(newV),
    });
    if (patch.is_active != null && Boolean(patch.is_active) !== Boolean(user.is_active)) {
        push(AUDIT_USER_PATCH, 'is_active', user.is_active ? '1' : '0', patch.is_active ? '1' : '0');
    }
    if (patch.role && patch.role !== user.role) push(AUDIT_USER_PATCH, 'role', user.role, patch.role);
    if (patch.phone_verified != null && Boolean(patch.phone_verified) !== Boolean(user.phone_verified)) {
        push(AUDIT_USER_PATCH, 'phone_verified', user.phone_verified ? '1' : '0', patch.phone_verified ? '1' : '0');
    }
    if (patch.unlock && (user.locked_until != null || (user.pin_attempts ?? 0) > 0)) {
        push(AUDIT_USER_UNLOCK, null, 'locked', 'unlocked');
    }
    if (patch.force_pin_change && !user.must_change_pin) push(AUDIT_USER_FORCE_PIN, null, null, '1');
    if (patch.reset_pin) push(AUDIT_USER_RESET_PIN, null, null, 'temp PIN issued');
    return rows;
}

// --- admin projection --------------------------------------------------------
// The Users-section row: MORE than auth.js#publicUser (ops fields: lockout,
// forced-change flag, session count, consent, timestamps) but still never the
// pin hash. `activeSessions` comes from the list query's per-user count.
export function adminUserView(u, { activeSessions = 0 } = {}) {
    return {
        id: u.id,
        name: u.name,
        role: u.role,
        phone: u.phone,
        phone_region: u.phone_region ?? null,
        phone_carrier: u.phone_carrier ?? null,
        phone_verified: Boolean(u.phone_verified),
        is_active: Boolean(u.is_active),
        must_change_pin: Boolean(u.must_change_pin),
        pin_attempts: u.pin_attempts ?? 0,
        locked_until: u.locked_until ?? null,
        last_login_at: u.last_login_at ?? null,
        terms_version: u.terms_version ?? null,
        terms_accepted_at: u.terms_accepted_at ?? null,
        created_at: u.created_at ?? null,
        active_sessions: activeSessions,
    };
}
