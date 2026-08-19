// Stale-retention diff scenarios (src/db/odds-diff.js). Existing rows carry
// DB shapes on purpose: DECIMAL handicap as string, is_stale as tinyint 0/1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOddsRows, oddsIdentity, emptySnapshotIsSuspect } from '../src/db/odds-diff.js';

const row = (id, type_name, name, handicap = null, is_stale = 0) =>
    ({ id, type_name, name, handicap, is_stale });
const snap = (type_name, name, handicap = null) => ({ type_name, name, handicap, price: 2.0 });

test('oddsIdentity normalizes DB-string and snapshot-number handicaps', () => {
    assert.equal(
        oddsIdentity({ type_name: 'TOTAL', name: 'OVER 2.5', handicap: '2.5' }),
        oddsIdentity({ type_name: 'TOTAL', name: 'OVER 2.5', handicap: 2.5 }),
    );
    // null handicap (betika 1X2/DC rows) stays distinct from a numeric one
    assert.notEqual(
        oddsIdentity({ type_name: 'TOTAL', name: 'OVER', handicap: null }),
        oddsIdentity({ type_name: 'TOTAL', name: 'OVER', handicap: 0 }),
    );
    // NUL delimiter: no collisions from '|' or spaces inside provider text
    assert.notEqual(
        oddsIdentity({ type_name: 'A', name: 'B C', handicap: null }),
        oddsIdentity({ type_name: 'A B', name: 'C', handicap: null }),
    );
});

test('new match: nothing existing, nothing stale or deleted', () => {
    assert.deepEqual(diffOddsRows([], [snap('1X2', '1')]), { staleIds: [], deleteIds: [] });
});

test('unchanged snapshot: full delete+reinsert, none stale', () => {
    const existing = [row(1, '1X2', '1'), row(2, '1X2', 'X'), row(3, 'TOTAL', 'OVER 2.5', '2.5')];
    const latest = [snap('1X2', '1'), snap('1X2', 'X'), snap('TOTAL', 'OVER 2.5', 2.5)];
    assert.deepEqual(diffOddsRows(existing, latest), { staleIds: [], deleteIds: [1, 2, 3] });
});

test('vanished market goes stale, the rest replaced', () => {
    const existing = [row(1, '1X2', '1'), row(2, 'TOTAL', 'OVER 2.5', '2.5')];
    const latest = [snap('1X2', '1')];
    assert.deepEqual(diffOddsRows(existing, latest), { staleIds: [2], deleteIds: [1] });
});

test('already-stale and still missing: untouched (updated_at marks staling time)', () => {
    const existing = [row(1, '1X2', '1'), row(2, 'TOTAL', 'OVER 2.5', '2.5', 1)];
    const latest = [snap('1X2', '1')];
    assert.deepEqual(diffOddsRows(existing, latest), { staleIds: [], deleteIds: [1] });
});

test('re-listed stale market revives: deleted then reinserted fresh by caller', () => {
    const existing = [row(1, 'TOTAL', 'OVER 2.5', '2.5', 1)];
    const latest = [snap('TOTAL', 'OVER 2.5', 2.5)];
    assert.deepEqual(diffOddsRows(existing, latest), { staleIds: [], deleteIds: [1] });
});

test('empty snapshot: every fresh row goes stale, nothing deleted', () => {
    const existing = [row(1, '1X2', '1'), row(2, '1X2', 'X'), row(3, '1X2', '2', null, 1)];
    assert.deepEqual(diffOddsRows(existing, []), { staleIds: [1, 2], deleteIds: [] });
});

test('duplicate identities in existing rows are all replaced together', () => {
    const existing = [row(1, '1X2', '1'), row(2, '1X2', '1')];
    const latest = [snap('1X2', '1')];
    assert.deepEqual(diffOddsRows(existing, latest), { staleIds: [], deleteIds: [1, 2] });
});

// emptySnapshotIsSuspect: a 200-with-empty-body detail response must not be
// treated as "the market genuinely closed" when fresh rows are already on
// file - see src/db/store.js's saveMatches for the wiring.
test('emptySnapshotIsSuspect: empty snapshot with fresh existing rows is suspect', () => {
    const existing = [row(1, '1X2', '1'), row(2, '1X2', 'X')];
    assert.equal(emptySnapshotIsSuspect(existing, []), true);
});

test('emptySnapshotIsSuspect: a first sighting with nothing existing is never suspect', () => {
    assert.equal(emptySnapshotIsSuspect([], []), false);
    assert.equal(emptySnapshotIsSuspect(null, []), false);
    assert.equal(emptySnapshotIsSuspect(undefined, []), false);
});

test('emptySnapshotIsSuspect: existing rows already all stale is never suspect', () => {
    const existing = [row(1, '1X2', '1', null, 1), row(2, '1X2', 'X', null, 1)];
    assert.equal(emptySnapshotIsSuspect(existing, []), false);
});

test('emptySnapshotIsSuspect: a mix of fresh and stale existing rows is still suspect', () => {
    const existing = [row(1, '1X2', '1', null, 1), row(2, '1X2', 'X')];
    assert.equal(emptySnapshotIsSuspect(existing, []), true);
});

test('emptySnapshotIsSuspect: a non-empty snapshot is never suspect regardless of existing rows', () => {
    const existing = [row(1, '1X2', '1')];
    assert.equal(emptySnapshotIsSuspect(existing, [snap('1X2', '1')]), false);
    assert.equal(emptySnapshotIsSuspect([], [snap('1X2', '1')]), false);
});
