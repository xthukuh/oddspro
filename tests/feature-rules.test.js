import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FEATURES, GUEST_FEATURES, TIERS, featureAllowed, featureMap, userTier,
    effectiveMinTier, parseFeatureList,
} from '../src/db/feature-rules.js';

const GUEST = null;
const USER = { id: 1, role: 'user' };
const ADMIN = { id: 2, role: 'admin' };

test('userTier maps session -> tier', () => {
    assert.equal(userTier(GUEST), 'guest');
    assert.equal(userTier(undefined), 'guest');
    assert.equal(userTier(USER), 'user');
    assert.equal(userTier({ id: 3 }), 'user');       // role absent = normal user
    assert.equal(userTier(ADMIN), 'admin');
});

test('GUEST_PREMIUM off keeps the legacy signed-in-only semantics', () => {
    for (const f of Object.keys(FEATURES)) {
        assert.equal(featureAllowed(GUEST, f, {}), false, `${f} must be closed to guests`);
        assert.equal(featureAllowed(USER, f, {}), true, `${f} must be open to users`);
        assert.equal(featureAllowed(ADMIN, f, {}), true, `${f} must be open to admins`);
    }
});

test('GUEST_PREMIUM on opens every guest-openable feature, never the account-bound ones', () => {
    const map = featureMap(GUEST, { guestPremium: true });
    for (const f of GUEST_FEATURES) assert.equal(map[f], true, `${f} should open`);
    for (const [k, spec] of Object.entries(FEATURES)) {
        if (spec.accountBound) assert.equal(map[k], false, `${k} is account-bound and must stay closed`);
    }
});

test('an account-bound feature can never be opened to a guest by settings', () => {
    const bound = Object.keys(FEATURES).filter(k => FEATURES[k].accountBound);
    assert.ok(bound.length > 0);
    for (const f of bound) {
        assert.equal(featureAllowed(GUEST, f, { guestPremium: true }), false);
        assert.equal(featureAllowed(GUEST, f, { guestPremium: true, guestExcept: '' }), false);
        assert.equal(effectiveMinTier(f, { guestPremium: true }), 'user');
    }
});

test('GUEST_PREMIUM_EXCEPT claws back individual features without touching the rest', () => {
    const opts = { guestPremium: true, guestExcept: 'methodology, tip_reasoning' };
    assert.equal(featureAllowed(GUEST, 'methodology', opts), false);
    assert.equal(featureAllowed(GUEST, 'tip_reasoning', opts), false);
    assert.equal(featureAllowed(GUEST, 'sure_bets', opts), true);
    // a clawed-back feature is still open to real sessions
    assert.equal(featureAllowed(USER, 'methodology', opts), true);
});

test('parseFeatureList is total over admin-typed junk', () => {
    assert.deepEqual(parseFeatureList(null), []);
    assert.deepEqual(parseFeatureList(''), []);
    assert.deepEqual(parseFeatureList('  '), []);
    assert.deepEqual(parseFeatureList('a, ,b '), ['a', 'b']);
    assert.deepEqual(parseFeatureList(['a', ' b']), ['a', 'b']);
    assert.deepEqual(parseFeatureList(42), ['42']);
    // an unknown key in the list is simply never matched, not an error
    assert.equal(featureAllowed(GUEST, 'sure_bets', { guestPremium: true, guestExcept: 'nope' }), true);
});

test('unknown feature keys throw - a typo\'d gate must never fail open', () => {
    assert.throws(() => featureAllowed(USER, 'nope'), /unknown feature/);
    assert.throws(() => effectiveMinTier('nope', {}), /unknown feature/);
});

test('registry invariants: known tiers, every feature declares a valid minTier', () => {
    assert.deepEqual(TIERS, ['guest', 'user', 'admin']);
    for (const [k, spec] of Object.entries(FEATURES)) {
        assert.ok(TIERS.includes(spec.minTier), `${k} has an unknown minTier`);
        assert.equal(typeof spec.label, 'string', `${k} needs an admin-facing label`);
        assert.ok(spec.label.length > 0, `${k} label must not be empty`);
    }
    // the two original seam features survive the generalization
    assert.ok('daily_multibet' in FEATURES);
    assert.ok('slip_sharing' in FEATURES);
});
