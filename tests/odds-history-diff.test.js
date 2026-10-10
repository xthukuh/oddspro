// Odds history change-log diff (src/db/odds-diff.js#diffOddsChanges). Pure,
// offline. Spec: docs/dev/specs/2026-10-10-1600-odds-history-targets.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffOddsChanges, priceCents } from '../src/db/odds-diff.js';

const ex = (type_name, name, handicap, price, is_stale = false) => ({ id: Math.random(), type_name, name, handicap, price, is_stale });
const snap = (type_name, name, handicap, price) => ({ type_name, name, handicap, price });

test('priceCents normalizes DECIMAL strings and numbers, NaN for junk', () => {
    assert.equal(priceCents('1.85'), 185);
    assert.equal(priceCents(1.85), 185);
    assert.equal(priceCents('2.10'), priceCents(2.1));
    assert.equal(priceCents(1.005 + 0.000001), 101); // float noise rounds
    assert.ok(Number.isNaN(priceCents(null)));
    assert.ok(Number.isNaN(priceCents('')));
    assert.ok(Number.isNaN(priceCents('abc')));
});

test('unchanged prices write nothing, even across DECIMAL string vs number', () => {
    const existing = [ex('1X2', '1', null, '1.85'), ex('TOTAL', 'OVER 2.5', '2.5', '1.90')];
    const rows = [snap('1X2', '1', null, 1.85), snap('TOTAL', 'OVER 2.5', 2.5, 1.9)];
    assert.deepEqual(diffOddsChanges(existing, rows), []);
});

test('first_seen, changed, revived and stale each get the documented odds/prev_odds', () => {
    const existing = [
        ex('1X2', '1', null, '1.85'),          // will change
        ex('1X2', 'X', null, '3.40', true),    // stale, comes back
        ex('1X2', '2', null, '4.20'),          // vanishes -> stale
        ex('GG', 'Yes', null, '1.70', true),   // stale and still missing -> nothing
    ];
    const rows = [
        snap('1X2', '1', null, 1.80),
        snap('1X2', 'X', null, 3.5),
        snap('TOTAL', 'OVER 2.5', 2.5, 1.95),  // brand new
    ];
    const out = diffOddsChanges(existing, rows);
    const by = Object.fromEntries(out.map(r => [`${r.type_name}/${r.name}`, r]));
    assert.equal(out.length, 4);
    assert.deepEqual(by['1X2/1'], { type_name: '1X2', name: '1', handicap: null, odds: 1.8, prev_odds: 1.85, event: 'changed' });
    assert.deepEqual(by['1X2/X'], { type_name: '1X2', name: 'X', handicap: null, odds: 3.5, prev_odds: 3.4, event: 'revived' });
    assert.deepEqual(by['TOTAL/OVER 2.5'], { type_name: 'TOTAL', name: 'OVER 2.5', handicap: 2.5, odds: 1.95, prev_odds: null, event: 'first_seen' });
    assert.deepEqual(by['1X2/2'], { type_name: '1X2', name: '2', handicap: null, odds: 4.2, prev_odds: null, event: 'stale' });
    assert.equal(by['GG/Yes'], undefined);
});

test('a revived market logs even when its price did not move (offered again IS a change)', () => {
    const out = diffOddsChanges([ex('1X2', 'X', null, '3.40', true)], [snap('1X2', 'X', null, 3.4)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].event, 'revived');
});

test('identity matches handicap numerically and never by type_id', () => {
    const existing = [{ id: 1, type_id: 19, type_name: 'TOTAL', name: 'OVER', handicap: '2.5', price: '1.90', is_stale: false }];
    const rows = [{ type_id: 99, type_name: 'TOTAL', name: 'OVER', handicap: 2.5, price: 1.9 }];
    assert.deepEqual(diffOddsChanges(existing, rows), []);
    const moved = diffOddsChanges(existing, [{ type_name: 'TOTAL', name: 'OVER', handicap: 3.5, price: 1.9 }]);
    assert.deepEqual(moved.map(r => r.event).sort(), ['first_seen', 'stale']);
});

test('first sighting (nothing on file) logs every market as first_seen', () => {
    const out = diffOddsChanges([], [snap('1X2', '1', null, 2), snap('1X2', '2', null, 3)]);
    assert.deepEqual(out.map(r => r.event), ['first_seen', 'first_seen']);
});

test('baseline emits every snapshot identity plus a stale for every absent on-file one', () => {
    const existing = [
        ex('1X2', '1', null, '1.85'),
        ex('1X2', '2', null, '4.20'),
        ex('GG', 'Yes', null, '1.70', true), // already stale: still re-stated on a baseline
    ];
    const rows = [snap('1X2', '1', null, 1.85), snap('1X2', 'X', null, 3.3)];
    const out = diffOddsChanges(existing, rows, { baseline: true });
    const events = out.map(r => `${r.name}:${r.event}`).sort();
    assert.deepEqual(events, ['1:baseline', '2:stale', 'X:baseline', 'Yes:stale']);
    assert.equal(out.find(r => r.name === '1').prev_odds, 1.85);
    assert.equal(out.find(r => r.name === 'X').prev_odds, null);
});

test('duplicate identity in a snapshot keeps the first occurrence; junk prices are skipped', () => {
    const out = diffOddsChanges([], [snap('1X2', '1', null, 2), snap('1X2', '1', null, 9), snap('1X2', 'X', null, NaN)]);
    assert.equal(out.length, 1);
    assert.equal(out[0].odds, 2);
});

test('on-file duplicates prefer the fresh row', () => {
    const existing = [ex('1X2', '1', null, '5.00', true), ex('1X2', '1', null, '2.00', false)];
    assert.deepEqual(diffOddsChanges(existing, [snap('1X2', '1', null, 2)]), []);
});

test('total over junk input', () => {
    assert.deepEqual(diffOddsChanges(null, null), []);
    assert.deepEqual(diffOddsChanges(undefined, undefined, { baseline: true }), []);
});
