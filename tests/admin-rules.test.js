// Admin user-management rules (src/db/admin-rules.js) - M8, offline. Patch
// schema, self/last-admin guards, users-table update builder, session-revoke
// predicate, temp-PIN generation, changed-only audit rows, and the admin user
// projection (which must never leak pin_hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    userPatchSchema, patchGuards, lastAdminViolation, buildUserUpdate,
    patchRevokesSessions, newTempPin, buildUserAuditRows, adminUserView,
    AUDIT_USER_PATCH, AUDIT_USER_UNLOCK, AUDIT_USER_FORCE_PIN, AUDIT_USER_RESET_PIN,
} from '../src/db/admin-rules.js';

const admin = (over = {}) => ({
    id: 1, name: 'Administrator', role: 'admin', phone: '+254700000001',
    phone_verified: 1, is_active: 1, must_change_pin: 0, pin_attempts: 0,
    locked_until: null, pin_hash: 'scrypt$16384$8$1$c2FsdA==$ZGs=', ...over,
});
const normal = (over = {}) => admin({ id: 7, name: 'Person', role: 'normal', phone: '+254700000007', ...over });

// --- userPatchSchema ---------------------------------------------------------

test('userPatchSchema accepts each field alone and combined', () => {
    assert.deepEqual(userPatchSchema.parse({ is_active: false }), { is_active: false });
    assert.deepEqual(userPatchSchema.parse({ role: 'admin' }), { role: 'admin' });
    assert.deepEqual(userPatchSchema.parse({ phone_verified: true }), { phone_verified: true });
    assert.deepEqual(userPatchSchema.parse({ unlock: true }), { unlock: true });
    assert.deepEqual(userPatchSchema.parse({ force_pin_change: true }), { force_pin_change: true });
    assert.deepEqual(userPatchSchema.parse({ reset_pin: true }), { reset_pin: true });
    assert.deepEqual(userPatchSchema.parse({ is_active: true, role: 'normal' }), { is_active: true, role: 'normal' });
});

test('userPatchSchema rejects empty, unknown keys, bad role, and one-way false', () => {
    assert.throws(() => userPatchSchema.parse({}));
    assert.throws(() => userPatchSchema.parse({ nope: 1 }));
    assert.throws(() => userPatchSchema.parse({ role: 'superuser' }));
    // unlock/force_pin_change/reset_pin are one-way actions - false is invalid,
    // omission is the only "no".
    assert.throws(() => userPatchSchema.parse({ unlock: false }));
    assert.throws(() => userPatchSchema.parse({ force_pin_change: false }));
    assert.throws(() => userPatchSchema.parse({ reset_pin: false }));
    // pin_hash can never ride a patch (strict schema).
    assert.throws(() => userPatchSchema.parse({ is_active: true, pin_hash: 'x' }));
});

// --- guards ------------------------------------------------------------------

test('patchGuards rejects self-disable and self-demote', () => {
    const target = admin();
    assert.equal(patchGuards({ actorId: 1, target, patch: { is_active: false }, activeAdminIds: [1, 2] }).ok, false);
    assert.equal(patchGuards({ actorId: 1, target, patch: { role: 'normal' }, activeAdminIds: [1, 2] }).ok, false);
    // Re-asserting your own admin role is a no-op, not a demotion.
    assert.equal(patchGuards({ actorId: 1, target, patch: { role: 'admin' }, activeAdminIds: [1, 2] }).ok, true);
});

test('patchGuards sends self PIN actions to the profile flow', () => {
    const target = admin();
    assert.equal(patchGuards({ actorId: 1, target, patch: { reset_pin: true }, activeAdminIds: [1, 2] }).ok, false);
    assert.equal(patchGuards({ actorId: 1, target, patch: { force_pin_change: true }, activeAdminIds: [1, 2] }).ok, false);
    // Self unlock / verify stay allowed (harmless).
    assert.equal(patchGuards({ actorId: 1, target, patch: { unlock: true }, activeAdminIds: [1] }).ok, true);
});

test('patchGuards blocks removing the last active admin', () => {
    const other = admin({ id: 2, phone: '+254700000002' });
    const r1 = patchGuards({ actorId: 1, target: other, patch: { is_active: false }, activeAdminIds: [2] });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /last active admin/i);
    const r2 = patchGuards({ actorId: 1, target: other, patch: { role: 'normal' }, activeAdminIds: [2] });
    assert.equal(r2.ok, false);
});

test('patchGuards allows disabling an admin when another active admin remains', () => {
    const other = admin({ id: 2, phone: '+254700000002' });
    assert.equal(patchGuards({ actorId: 1, target: other, patch: { is_active: false }, activeAdminIds: [1, 2] }).ok, true);
    // Normal users never trip the last-admin guard.
    assert.equal(patchGuards({ actorId: 1, target: normal(), patch: { is_active: false }, activeAdminIds: [1] }).ok, true);
});

test('lastAdminViolation ignores inactive admins and non-removing patches', () => {
    // Demoting an already-disabled admin removes nothing from the ACTIVE set.
    assert.equal(lastAdminViolation(admin({ id: 2, is_active: 0 }), { role: 'normal' }, [1]), false);
    // Verifying / unlocking is not a removal even on the last admin.
    assert.equal(lastAdminViolation(admin(), { phone_verified: true }, [1]), false);
    assert.equal(lastAdminViolation(admin(), { unlock: true }, [1]), false);
    // String/number id mismatches (mysql2 BIGINT) still compare correctly.
    assert.equal(lastAdminViolation(admin(), { is_active: false }, ['1']), true);
    assert.equal(lastAdminViolation(admin(), { is_active: false }, ['1', '2']), false);
});

// --- update builder + revoke predicate ---------------------------------------

test('buildUserUpdate maps fields to users columns', () => {
    assert.deepEqual(buildUserUpdate({ is_active: false }), { is_active: 0 });
    assert.deepEqual(buildUserUpdate({ is_active: true, role: 'admin' }), { is_active: 1, role: 'admin' });
    assert.deepEqual(buildUserUpdate({ phone_verified: true }), { phone_verified: 1 });
    assert.deepEqual(buildUserUpdate({ unlock: true }), { pin_attempts: 0, locked_until: null });
    assert.deepEqual(buildUserUpdate({ force_pin_change: true }), { must_change_pin: 1 });
});

test('buildUserUpdate reset_pin installs the temp hash, forces a change AND clears the lockout', () => {
    // A locked-out user being rescued with a temp PIN must be able to USE it.
    assert.deepEqual(buildUserUpdate({ reset_pin: true }, { tempPinHash: 'scrypt$x' }), {
        pin_hash: 'scrypt$x', must_change_pin: 1, pin_attempts: 0, locked_until: null,
    });
});

test('patchRevokesSessions: disable and reset_pin revoke, the rest do not', () => {
    assert.equal(patchRevokesSessions({ is_active: false }), true);
    assert.equal(patchRevokesSessions({ reset_pin: true }), true);
    assert.equal(patchRevokesSessions({ is_active: true }), false);
    assert.equal(patchRevokesSessions({ role: 'normal' }), false);
    assert.equal(patchRevokesSessions({ phone_verified: true, unlock: true, force_pin_change: true }), false);
});

// --- temp PIN ----------------------------------------------------------------

test('newTempPin is 4 digits with leading zeros preserved', () => {
    assert.equal(newTempPin(() => 5), '0005');
    assert.equal(newTempPin(() => 9999), '9999');
    assert.match(newTempPin(max => max - 1), /^\d{4}$/);
});

// --- audit rows --------------------------------------------------------------

test('buildUserAuditRows is changed-only per field', () => {
    const rows = buildUserAuditRows({ actorId: 1, user: normal(), patch: { is_active: true, role: 'normal' } });
    assert.deepEqual(rows, []); // both already true/normal - no policy event
    const changed = buildUserAuditRows({ actorId: 1, user: normal(), patch: { is_active: false, role: 'admin' } });
    assert.equal(changed.length, 2);
    assert.deepEqual(changed[0], {
        actor_id: 1, action: AUDIT_USER_PATCH, target: 'user:7:is_active', old_value: '1', new_value: '0',
    });
    assert.deepEqual(changed[1], {
        actor_id: 1, action: AUDIT_USER_PATCH, target: 'user:7:role', old_value: 'normal', new_value: 'admin',
    });
});

test('buildUserAuditRows unlock lands only when something was locked', () => {
    assert.deepEqual(buildUserAuditRows({ actorId: 1, user: normal(), patch: { unlock: true } }), []);
    const locked = normal({ pin_attempts: 3, locked_until: '2026-07-19 10:00:00' });
    const rows = buildUserAuditRows({ actorId: 1, user: locked, patch: { unlock: true } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, AUDIT_USER_UNLOCK);
    assert.equal(rows[0].target, 'user:7');
    assert.equal(rows[0].old_value, 'locked');
    assert.equal(rows[0].new_value, 'unlocked');
});

test('buildUserAuditRows force_pin_change lands only when not already forced', () => {
    assert.deepEqual(buildUserAuditRows({ actorId: 1, user: normal({ must_change_pin: 1 }), patch: { force_pin_change: true } }), []);
    const rows = buildUserAuditRows({ actorId: 1, user: normal(), patch: { force_pin_change: true } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, AUDIT_USER_FORCE_PIN);
});

test('buildUserAuditRows reset_pin always lands and NEVER carries PIN material', () => {
    const rows = buildUserAuditRows({ actorId: 1, user: normal(), patch: { reset_pin: true } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, AUDIT_USER_RESET_PIN);
    assert.equal(rows[0].old_value, null);
    assert.equal(rows[0].new_value, 'temp PIN issued');
    assert.ok(!JSON.stringify(rows).match(/\d{4}/), 'no 4-digit sequence in the trail');
});

// --- admin projection --------------------------------------------------------

test('adminUserView exposes ops fields and never the pin hash', () => {
    const u = normal({ pin_attempts: 2, locked_until: '2026-07-19 10:00:00', created_at: '2026-07-14', last_login_at: '2026-07-18' });
    const v = adminUserView(u, { activeSessions: 3 });
    assert.equal(v.id, 7);
    assert.equal(v.role, 'normal');
    assert.equal(v.phone, '+254700000007');
    assert.equal(v.phone_verified, true);
    assert.equal(v.is_active, true);
    assert.equal(v.must_change_pin, false);
    assert.equal(v.pin_attempts, 2);
    assert.equal(v.locked_until, '2026-07-19 10:00:00');
    assert.equal(v.active_sessions, 3);
    assert.equal(v.created_at, '2026-07-14');
    assert.equal(v.last_login_at, '2026-07-18');
    const json = JSON.stringify(v);
    assert.ok(!json.includes('pin_hash') && !json.includes('scrypt'), 'pin hash must never leave the server');
});

test('adminUserView defaults session count to 0 and tolerates missing optionals', () => {
    const v = adminUserView({ id: 2, name: 'X', role: 'normal', phone: '+254711', phone_verified: 0, is_active: 1, must_change_pin: 0 });
    assert.equal(v.active_sessions, 0);
    assert.equal(v.pin_attempts, 0);
    assert.equal(v.locked_until, null);
    assert.equal(v.terms_version, null);
});
