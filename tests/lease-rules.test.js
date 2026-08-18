// Pure single-writer lease rules (src/db/lease-rules.js): GET_LOCK row
// classification + the gained/lost transition state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WRITER_LOCK, lockOutcome, leaseTransition } from '../src/db/lease-rules.js';

test('WRITER_LOCK is the pinned lock name', () => {
    assert.equal(WRITER_LOCK, 'oddspro:writer');
});

test('lockOutcome reads GET_LOCK(?,0) rows', () => {
    assert.equal(lockOutcome([{ got: 1 }]), 'acquired');
    assert.equal(lockOutcome([{ got: 0 }]), 'held-elsewhere');
});

test('lockOutcome treats missing/null rows as error', () => {
    assert.equal(lockOutcome([]), 'error');
    assert.equal(lockOutcome(undefined), 'error');
    assert.equal(lockOutcome([{ got: null }]), 'error');
    assert.equal(lockOutcome([{ got: undefined }]), 'error');
});

test('leaseTransition reports gained when acquiring from not-writer', () => {
    const t = leaseTransition(false, 'acquired');
    assert.deepEqual(t, { was: false, now: true, changed: true, event: 'gained' });
});

test('leaseTransition reports lost when held-elsewhere while previously writer', () => {
    const t = leaseTransition(true, 'held-elsewhere');
    assert.deepEqual(t, { was: true, now: false, changed: true, event: 'lost' });
});

test('leaseTransition reports lost on error while previously writer', () => {
    const t = leaseTransition(true, 'error');
    assert.deepEqual(t, { was: true, now: false, changed: true, event: 'lost' });
});

test('leaseTransition reports unchanged when staying non-writer', () => {
    const t = leaseTransition(false, 'held-elsewhere');
    assert.deepEqual(t, { was: false, now: false, changed: false, event: null });
    const t2 = leaseTransition(false, 'error');
    assert.deepEqual(t2, { was: false, now: false, changed: false, event: null });
});

test('leaseTransition reports unchanged when staying writer', () => {
    const t = leaseTransition(true, 'acquired');
    assert.deepEqual(t, { was: true, now: true, changed: false, event: null });
});
