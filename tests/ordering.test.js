import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orderRows } from '../web/src/ordering.js';

// Rows carry just the fields the extractors touch: `goals` (numeric column),
// `fixture` (string column), and tip_* (the 'confidence' magic strategy scores
// tip_confidence). r4 is tipless -> its magic score is null (sinks last).
const mkRows = () => [
    { api_id: 4, fixture: 'Delta', goals: 2, tip_market: null },
    { api_id: 1, fixture: 'Alpha', goals: 2, tip_market: 'O 2.5', tip_confidence: 0.7 },
    { api_id: 2, fixture: 'Bravo', goals: 5, tip_market: 'O 2.5', tip_confidence: 0.9 },
    { api_id: 3, fixture: 'Charlie', goals: null, tip_market: 'O 2.5', tip_confidence: 0.5 },
];
const COLS = [{ key: 'goals', group: 'base' }, { key: 'fixture', group: 'base' }];
const ids = rows => rows.map(r => r.api_id);

test('empty chain returns the input untouched (server order)', () => {
    const rows = mkRows();
    assert.equal(orderRows(rows, [], COLS, null), rows);
    assert.equal(orderRows(rows, null, COLS, null), rows);
});

test('single column descending, nulls last', () => {
    const rows = mkRows();
    const out = orderRows(rows, [{ type: 'column', key: 'goals', dir: 'desc' }], COLS, null);
    // 5, then the two 2s (stable input order 4 before 1), then null last
    assert.deepEqual(ids(out), [2, 4, 1, 3]);
});

test('single column ascending still sinks nulls last', () => {
    const rows = mkRows();
    const out = orderRows(rows, [{ type: 'column', key: 'goals', dir: 'asc' }], COLS, null);
    assert.deepEqual(ids(out), [4, 1, 2, 3]);
});

test('magic entry ranks by score descending, tipless last', () => {
    const rows = mkRows();
    const out = orderRows(rows, [{ type: 'magic', id: 'confidence' }], COLS, null);
    // conf 0.9, 0.7, 0.5, then tipless(null) r4
    assert.deepEqual(ids(out), [2, 1, 3, 4]);
});

test('combined chain applies priority: column first, magic breaks ties', () => {
    const rows = mkRows();
    const chain = [{ type: 'column', key: 'goals', dir: 'desc' }, { type: 'magic', id: 'confidence' }];
    const out = orderRows(rows, chain, COLS, null);
    // goals desc: r2(5) first; r4 & r1 tie on 2 -> magic breaks it (r1 0.7 > r4 null);
    // r3 goals null sinks last. Distinct from pure goals-desc which keeps r4 before r1.
    assert.deepEqual(ids(out), [2, 1, 4, 3]);
});

test('does not mutate the input array', () => {
    const rows = mkRows();
    const before = ids(rows);
    orderRows(rows, [{ type: 'column', key: 'goals', dir: 'desc' }], COLS, null);
    assert.deepEqual(ids(rows), before);
});

test('unknown column key is a no-op (all values null -> stable order)', () => {
    const rows = mkRows();
    const out = orderRows(rows, [{ type: 'column', key: 'nope', dir: 'desc' }], COLS, null);
    assert.deepEqual(ids(out), ids(rows));
});
