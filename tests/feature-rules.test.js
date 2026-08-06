import test from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, featureAllowed } from '../src/db/feature-rules.js';

test('premium seam v1: signed-in allowed, guest denied, unknown feature throws', () => {
    assert.equal(featureAllowed({ id: 1, role: 'user' }, 'daily_multibet'), true);
    assert.equal(featureAllowed({ id: 2, role: 'admin' }, 'slip_sharing'), true);
    assert.equal(featureAllowed(null, 'daily_multibet'), false);
    assert.equal(featureAllowed(undefined, 'slip_sharing'), false);
    assert.throws(() => featureAllowed({ id: 1 }, 'nope'), /unknown feature/);
});

test('registry lists exactly the two seamed features', () => {
    assert.deepEqual(Object.keys(FEATURES).sort(), ['daily_multibet', 'slip_sharing']);
});
