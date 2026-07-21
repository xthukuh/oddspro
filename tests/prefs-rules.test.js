// Cross-device prefs sync rules (src/db/prefs-rules.js). Pure, offline -
// device-key exclusion, content fingerprint, the LWW reconcile lattice, and
// PUT body validation/sanitization.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isDeviceKey, excludeDeviceKeys, fingerprint, reconcile, validatePrefsPut, MAX_PREF_KEYS,
} from '../src/db/prefs-rules.js';

test('isDeviceKey: per-device state, exact keys + prefixes only', () => {
    assert.equal(isDeviceKey('oddspro.session'), true);      // session token
    assert.equal(isDeviceKey('oddspro.human'), true);        // human-pow token
    assert.equal(isDeviceKey('oddspro.prefs.sync'), true);   // this device's sync cursor
    assert.equal(isDeviceKey('oddspro.select.d.2026-07-15'), true); // per-date row selections
    assert.equal(isDeviceKey('oddspro.maintenance'), true);   // M14 schedule cache (server state)
    // The anonymous analytics id. It lives in the oddspro.* namespace this
    // machinery treats as preferences by DEFAULT, so without an explicit
    // exclusion it synced: two devices of one account converge on one
    // visitors.anon_id, silently conflating the unique/repeat-visitor metrics
    // the tracking exists to produce.
    assert.equal(isDeviceKey('oddspro.visitor'), true);
    assert.equal(isDeviceKey('oddspro.theme'), false);
    assert.equal(isDeviceKey('oddspro.sort'), false);
    assert.equal(isDeviceKey('oddspro.session.other'), false); // exact keys stay exact
    assert.equal(isDeviceKey('oddspro.selection'), false);     // prefix must match fully
});

test('excludeDeviceKeys keeps only syncable oddspro.* prefs', () => {
    const out = excludeDeviceKeys({
        'oddspro.theme': 'dark',
        'oddspro.sort': '[]',
        'oddspro.session': 'tok',                 // device secret
        'oddspro.human': 'tok',                   // device secret
        'oddspro.prefs.sync': '{"version":3}',    // sync cursor
        'oddspro.select.d.2026-07-15': '[1,2]',   // transient selection
        'unrelated.key': 'x',                     // not ours
    });
    assert.deepEqual(out, { 'oddspro.theme': 'dark', 'oddspro.sort': '[]' });
});

test('fingerprint is key-order independent and value sensitive', () => {
    const a = fingerprint({ 'oddspro.a': '1', 'oddspro.b': '2' });
    const b = fingerprint({ 'oddspro.b': '2', 'oddspro.a': '1' });
    assert.equal(a, b);
    assert.notEqual(a, fingerprint({ 'oddspro.a': '1', 'oddspro.b': '3' }));
    assert.notEqual(a, fingerprint({ 'oddspro.a': '1' }));
    // key/value boundaries are unambiguous ("ab"+"c" vs "a"+"bc")
    assert.notEqual(fingerprint({ ab: 'c' }), fingerprint({ a: 'bc' }));
    assert.equal(typeof fingerprint({}), 'string');
    assert.equal(fingerprint({}), fingerprint({}));
});

// The LWW lattice: version is the primary clock, updated_at breaks ties.
test('reconcile: no server row -> push (first login pushes local)', () => {
    assert.deepEqual(reconcile(null, null), { action: 'push', version: 1 });
    assert.deepEqual(reconcile({ version: 4 }, null), { action: 'push', version: 5 });
    assert.deepEqual(reconcile(4, null), { action: 'push', version: 5 }); // bare number ok
});

test('reconcile: server ahead -> pull', () => {
    const server = { version: 3, updated_at: '2026-07-15T10:00:00Z' };
    assert.deepEqual(reconcile({ version: 1 }, server), { action: 'pull', server });
    assert.deepEqual(reconcile(null, server), { action: 'pull', server }); // fresh device
});

test('reconcile: server behind -> push local forward', () => {
    const server = { version: 2, updated_at: '2026-07-15T10:00:00Z' };
    assert.deepEqual(reconcile({ version: 5 }, server), { action: 'push', version: 6 });
});

test('reconcile: version tie -> updated_at breaks it, else in sync', () => {
    const server = { version: 3, updated_at: '2026-07-15T10:00:00Z' };
    // no local timestamp -> in sync (content drift is the caller's fingerprint check)
    assert.deepEqual(reconcile({ version: 3 }, server), { action: 'none' });
    // local write is newer -> local wins the tie (retry past the server version)
    assert.deepEqual(
        reconcile({ version: 3, updated_at: '2026-07-15T10:00:05Z' }, server),
        { action: 'push', version: 4 },
    );
    // server write is newer or equal -> nothing to do (a pull would be a no-op
    // or is handled by the version comparison next round)
    assert.deepEqual(reconcile({ version: 3, updated_at: '2026-07-15T09:59:00Z' }, server), { action: 'none' });
    assert.deepEqual(reconcile({ version: 3, updated_at: '2026-07-15T10:00:00Z' }, server), { action: 'none' });
});

test('validatePrefsPut rejects malformed bodies', () => {
    assert.equal(validatePrefsPut(null).ok, false);
    assert.equal(validatePrefsPut('x').ok, false);
    assert.equal(validatePrefsPut({}).ok, false);                              // no data
    assert.equal(validatePrefsPut({ data: [], version: 1 }).ok, false);        // array data
    assert.equal(validatePrefsPut({ data: {}, version: 0 }).ok, false);        // version < 1
    assert.equal(validatePrefsPut({ data: {}, version: 1.5 }).ok, false);      // non-integer
    assert.equal(validatePrefsPut({ data: {}, version: '2' }).ok, false);      // string version
    assert.equal(validatePrefsPut({ data: {}, version: 2 ** 31 }).ok, false);  // out of range
    assert.match(validatePrefsPut({}).error, /./); // every rejection carries a message
});

test('validatePrefsPut sanitizes: only syncable oddspro.* string values survive', () => {
    const r = validatePrefsPut({
        version: 2,
        data: {
            'oddspro.theme': 'dark',
            'oddspro.stake': 100,              // scalar -> stringified (localStorage semantics)
            'oddspro.flag': false,
            'oddspro.session': 'stolen-token', // device key: dropped server-side too
            'oddspro.prefs.sync': '{}',        // cursor: dropped
            'not.ours': 'x',                   // foreign key: dropped
            'oddspro.nested': { a: 1 },        // non-scalar: dropped
            'oddspro.null': null,              // null: dropped
        },
    });
    assert.equal(r.ok, true);
    assert.equal(r.version, 2);
    assert.deepEqual(r.data, { 'oddspro.theme': 'dark', 'oddspro.stake': '100', 'oddspro.flag': 'false' });
    assert.equal(r.dropped, 5);
});

test('validatePrefsPut: empty data is a legal push, oversized key sets are not', () => {
    assert.equal(validatePrefsPut({ data: {}, version: 1 }).ok, true);
    const big = {};
    for (let i = 0; i <= MAX_PREF_KEYS; i++) big[`oddspro.k${i}`] = 'v';
    assert.equal(validatePrefsPut({ data: big, version: 1 }).ok, false);
});
