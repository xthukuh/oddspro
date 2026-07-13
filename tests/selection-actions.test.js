import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    unionSelectionIds,
    invertSelectionIds,
    selectSimilarIds,
    keepOneProviderIds,
    prioritizeSelectedRows,
} from '../web/src/filterValues.js';

// Rows carry the fields the selection actions touch: `match_id` (selection
// identity), `api_id` (canonical fixture - shared across providers), `provider`.
// match 1 & 2 are the two provider rows of the SAME fixture (api_id 100);
// match 4 has no api_id (betika omits it) so it can never be a sibling.
const mkRows = () => [
    { match_id: 1, api_id: 100, provider: 'betpawa' },
    { match_id: 2, api_id: 100, provider: 'betika' },
    { match_id: 3, api_id: 200, provider: 'betpawa' },
    { match_id: 4, api_id: null, provider: 'betika' },
];
const PRIORITY = ['betpawa', 'betika']; // betpawa outranks betika
const arr = set => [...set].sort((a, b) => a - b);

// --- unionSelectionIds (Select All over the given/visible rows) ---
test('unionSelectionIds adds every row id, keeping prior selection', () => {
    const out = unionSelectionIds(mkRows(), new Set([3]));
    assert.deepEqual(arr(out), [1, 2, 3, 4]);
});

test('unionSelectionIds accepts an array selection and only unions the passed rows', () => {
    // Only two "visible" rows passed -> only those two get added.
    const out = unionSelectionIds([{ match_id: 1 }, { match_id: 2 }], [5]);
    assert.deepEqual(arr(out), [1, 2, 5]);
});

test('unionSelectionIds does not mutate the input set', () => {
    const sel = new Set([3]);
    unionSelectionIds(mkRows(), sel);
    assert.deepEqual(arr(sel), [3]);
});

// --- invertSelectionIds (Invert over the given/visible rows) ---
test('invertSelectionIds toggles each row membership', () => {
    const out = invertSelectionIds(mkRows(), new Set([1, 3]));
    assert.deepEqual(arr(out), [2, 4]);
});

test('invertSelectionIds on an empty selection selects everything', () => {
    const out = invertSelectionIds(mkRows(), new Set());
    assert.deepEqual(arr(out), [1, 2, 3, 4]);
});

test('invertSelectionIds on a full selection clears it', () => {
    const out = invertSelectionIds(mkRows(), new Set([1, 2, 3, 4]));
    assert.deepEqual(arr(out), []);
});

// --- selectSimilarIds (add api_id siblings from the full loaded set) ---
test('selectSimilarIds pulls in the other-provider row of a selected fixture', () => {
    const out = selectSimilarIds(mkRows(), new Set([1]));
    assert.deepEqual(arr(out), [1, 2]); // match 2 shares api_id 100
});

test('selectSimilarIds finds siblings even when they are not in the visible set', () => {
    // The selection was made on a visible row; its sibling lives in the full
    // loaded set (e.g. hidden by a filter) and still gets selected.
    const loaded = mkRows();
    const out = selectSimilarIds(loaded, new Set([2]));
    assert.deepEqual(arr(out), [1, 2]);
});

test('selectSimilarIds never pulls null-api_id rows and leaves them alone', () => {
    const out = selectSimilarIds(mkRows(), new Set([4]));
    assert.deepEqual(arr(out), [4]); // api_id null -> no siblings
});

// --- keepOneProviderIds (reduce selection to one row per fixture by priority) ---
test('keepOneProviderIds keeps the highest-priority provider per fixture', () => {
    const out = keepOneProviderIds(mkRows(), new Set([1, 2, 3]), PRIORITY);
    assert.deepEqual(arr(out), [1, 3]); // fixture 100 -> betpawa(match 1) wins; 200 kept
});

test('keepOneProviderIds honors a reversed provider priority', () => {
    const out = keepOneProviderIds(mkRows(), new Set([1, 2, 3]), ['betika', 'betpawa']);
    assert.deepEqual(arr(out), [2, 3]); // now betika(match 2) wins fixture 100
});

test('keepOneProviderIds keeps all null-api_id rows', () => {
    const out = keepOneProviderIds(mkRows(), new Set([1, 2, 4]), PRIORITY);
    assert.deepEqual(arr(out), [1, 4]); // fixture 100 -> match 1; match 4 (null) kept
});

// --- prioritizeSelectedRows (stable partition, selected first) ---
test('prioritizeSelectedRows floats selected rows to the top, preserving order', () => {
    const rows = [
        { match_id: 1, select: true },
        { match_id: 2, select: false },
        { match_id: 3, select: true },
        { match_id: 4, select: false },
    ];
    const out = prioritizeSelectedRows(rows);
    assert.deepEqual(out.map(r => r.match_id), [1, 3, 2, 4]);
});

test('prioritizeSelectedRows returns the input untouched when nothing is selected', () => {
    const rows = [{ match_id: 1, select: false }, { match_id: 2, select: false }];
    assert.equal(prioritizeSelectedRows(rows), rows); // same reference, no work
});

test('prioritizeSelectedRows does not mutate the input array', () => {
    const rows = [{ match_id: 1, select: false }, { match_id: 2, select: true }];
    const before = rows.map(r => r.match_id);
    prioritizeSelectedRows(rows);
    assert.deepEqual(rows.map(r => r.match_id), before);
});
