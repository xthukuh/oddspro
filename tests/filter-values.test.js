import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    serverKeys, splitFilters, applyClientFilters, applyOutcomeToggles,
} from '../web/src/filterValues.js';

// Catalog shaped like GET /api/columns: base/markets are server-filterable,
// stats never are (derived in JS during hydration).
const CATALOG = {
    base: [
        { key: 'goals', sortable: true, filterable: true },
        { key: 'provider', sortable: true, filterable: true },
        { key: 'tip', sortable: true, filterable: true },
    ],
    markets: [
        { key: '1', filterable: true },
        { key: '2', filterable: true },
        { key: 'O 2.5', filterable: true },
    ],
    stats: [
        { key: 'home_form', label: 'Home Form' },
        { key: 'h2h_count', label: 'Meetings' },
        { key: 'fs:Total Shots', label: 'Total Shots (H/A)' },
    ],
};

// Column descriptors the App builds for the client engine (full catalog)
const COLUMNS = [
    { key: 'goals', group: 'base' },
    { key: 'score', group: 'base' },
    { key: 'home_form', group: 'stat' },
    { key: 'h2h_count', group: 'stat' },
    { key: 'fs:Total Shots', group: 'stat' },
    { key: '1', group: 'market' },
    { key: 'O 2.5', group: 'market' },
];

const row = (over = {}) => ({
    api_id: 1,
    goals: 3,
    score: '2-1',
    home_form: 'LWWWD',
    h2h_count: 5,
    stats: { 'fs:Total Shots': '10 / 5' },
    markets: { 1: 2.1, 'O 2.5': 1.5 },
    ...over,
});

test('serverKeys covers filterable base + market columns only', () => {
    const keys = serverKeys(CATALOG);
    assert.equal(keys.has('goals'), true);
    assert.equal(keys.has('O 2.5'), true);
    assert.equal(keys.has('h2h_count'), false);
    assert.equal(keys.has('score'), false);
});

test('splitFilters routes stat/score conditions client-side', () => {
    const filters = [
        { key: 'goals', op: 'gte', value: '2' },
        { key: 'h2h_count', op: 'gte', value: '3' },
        { key: 'score', op: 'like', value: '2-1' },
    ];
    const { server, client } = splitFilters(filters, CATALOG);
    assert.deepEqual(server.map(f => f.key), ['goals']);
    assert.deepEqual(client.map(f => f.key), ['h2h_count', 'score']);
});

test('splitFilters: col-mode goes client when EITHER side is client-only', () => {
    const filters = [
        { key: '1', op: 'lt', col: '2' }, // both markets - server
        { key: '1', op: 'gt', col: 'h2h_count' }, // stat RHS - client
        { key: 'h2h_count', op: 'gt', col: 'O 2.5' }, // stat LHS - client
    ];
    const { server, client } = splitFilters(filters, CATALOG);
    assert.equal(server.length, 1);
    assert.deepEqual(server[0], { key: '1', op: 'lt', col: '2' });
    assert.equal(client.length, 2);
});

test('numeric ops on plain stat values (h2h_count gte)', () => {
    const rows = [row({ h2h_count: 5 }), row({ h2h_count: 2 }), row({ h2h_count: null })];
    const out = applyClientFilters(rows, [{ key: 'h2h_count', op: 'gte', value: '3' }], COLUMNS);
    assert.deepEqual(out.map(r => r.h2h_count), [5]);
});

test('comparison ops use the derived sort value (form -> points)', () => {
    // 'LWWWD' = 3+3+3+1 = 10 pts; 'LLLLD' = 1 pt
    const rows = [row({ home_form: 'LWWWD' }), row({ home_form: 'LLLLD' })];
    const out = applyClientFilters(rows, [{ key: 'home_form', op: 'gt', value: '5' }], COLUMNS);
    assert.deepEqual(out.map(r => r.home_form), ['LWWWD']);
});

test('like matches the raw displayed text, case-insensitively', () => {
    const rows = [row({ home_form: 'LWWWD' }), row({ home_form: 'DLLWL' })];
    const out = applyClientFilters(rows, [{ key: 'home_form', op: 'like', value: 'www' }], COLUMNS);
    assert.deepEqual(out.map(r => r.home_form), ['LWWWD']);
});

test('fs:* post-match stats filter on the H+A sum', () => {
    const rows = [
        row(), // '10 / 5' -> 15
        row({ stats: { 'fs:Total Shots': '4 / 3' } }), // 7
        row({ stats: {} }),
    ];
    const out = applyClientFilters(rows, [{ key: 'fs:Total Shots', op: 'gte', value: '10' }], COLUMNS);
    assert.equal(out.length, 1);
    assert.equal(out[0].stats['fs:Total Shots'], '10 / 5');
});

test('score filters on total goals; like matches the score text', () => {
    const rows = [row({ score: '2-1' }), row({ score: '0-1' }), row({ score: null })];
    assert.equal(applyClientFilters(rows, [{ key: 'score', op: 'gte', value: '3' }], COLUMNS).length, 1);
    assert.equal(applyClientFilters(rows, [{ key: 'score', op: 'like', value: '0-1' }], COLUMNS).length, 1);
});

test('missing values never satisfy any predicate (even ne)', () => {
    const rows = [row({ h2h_count: null, home_form: null, stats: {} })];
    for (const f of [
        { key: 'h2h_count', op: 'ne', value: '3' },
        { key: 'home_form', op: 'like', value: 'W' },
        { key: 'fs:Total Shots', op: 'lte', value: '99' },
    ]) {
        assert.equal(applyClientFilters(rows, [f], COLUMNS).length, 0, JSON.stringify(f));
    }
});

test('col-mode compares derived values across groups (stat vs market)', () => {
    const rows = [
        row({ h2h_count: 2, markets: { 'O 2.5': 1.5 } }), // 2 > 1.5
        row({ h2h_count: 1, markets: { 'O 2.5': 1.5 } }),
        row({ h2h_count: 4, markets: {} }), // missing RHS never matches
    ];
    const out = applyClientFilters(rows, [{ key: 'h2h_count', op: 'gt', col: 'O 2.5' }], COLUMNS);
    assert.deepEqual(out.map(r => r.h2h_count), [2]);
});

test('conditions AND-combine; unknown op rejects the row', () => {
    const rows = [row(), row({ goals: 1 })];
    const out = applyClientFilters(rows, [
        { key: 'goals', op: 'gte', value: '2' },
        { key: 'home_form', op: 'like', value: 'W' },
    ], COLUMNS);
    assert.equal(out.length, 1);
    assert.equal(applyClientFilters(rows, [{ key: 'goals', op: 'nope', value: '2' }], COLUMNS).length, 0);
});

test('tip: like matches the tip market text, comparisons use confidence', () => {
    const rows = [
        row({ tip_market: 'O 2.5', tip_confidence: 0.8 }),
        row({ tip_market: '1X', tip_confidence: 0.6 }),
        row({ tip_market: null, tip_confidence: null }),
    ];
    const cols = [...COLUMNS, { key: 'tip', group: 'base' }];
    // contains matches what the cell displays (server parity: fp.tip_market)
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'tip', op: 'like', value: 'o 2' }], cols).map(r => r.tip_market),
        ['O 2.5']);
    // numeric ops keep comparing the blended confidence
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'tip', op: 'gte', value: '0.7' }], cols).map(r => r.tip_market),
        ['O 2.5']);
    // tipless rows never match either form
    assert.equal(applyClientFilters(rows, [{ key: 'tip', op: 'like', value: '' }], cols).length, 2);
});

test('not-contains inverts the substring match; null raw is excluded', () => {
    const rows = [row({ home_form: 'LWWWD' }), row({ home_form: 'DLLDL' }), row({ home_form: null })];
    const out = applyClientFilters(rows, [{ key: 'home_form', op: 'not-contains', value: 'w' }], COLUMNS);
    assert.deepEqual(out.map(r => r.home_form), ['DLLDL']);
});

test('in / not-in match the tip market text via a CSV list', () => {
    const rows = [
        row({ tip_market: 'O 2.5' }),
        row({ tip_market: '1X' }),
        row({ tip_market: 'O 0.5' }),
        row({ tip_market: null }),
    ];
    const cols = [...COLUMNS, { key: 'tip', group: 'base' }];
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'tip', op: 'in', value: '"O 2.5","1X"' }], cols).map(r => r.tip_market),
        ['O 2.5', '1X']);
    // not-in excludes the listed markets; the null-tip row is excluded too
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'tip', op: 'not-in', value: '"O 2.5","1X"' }], cols).map(r => r.tip_market),
        ['O 0.5']);
});

test('in normalizes numbers, so a market price matches its CSV item', () => {
    const rows = [row({ markets: { 1: 2.1 } }), row({ markets: { 1: 3.0 } }), row({ markets: { 1: 1.8 } })];
    const out = applyClientFilters(rows, [{ key: '1', op: 'in', value: '2.1,3.0' }], COLUMNS);
    assert.deepEqual(out.map(r => r.markets[1]), [2.1, 3.0]);
});

// --- settled-outcome display toggles ------------------------------------
const tipRow = (over = {}) => row({ tip_market: 'O 2.5', tip_outcome: null, ...over });

test('hideHits/hideMiss drop that settled class; unsettled always passes', () => {
    const rows = [
        tipRow({ api_id: 1, tip_outcome: 'hit' }),
        tipRow({ api_id: 2, tip_outcome: 'miss' }),
        tipRow({ api_id: 3, tip_outcome: null }), // upcoming
    ];
    assert.deepEqual(
        applyOutcomeToggles(rows, { hideHits: true }).map(r => r.api_id), [2, 3]);
    assert.deepEqual(
        applyOutcomeToggles(rows, { hideMiss: true }).map(r => r.api_id), [1, 3]);
    // both -> only upcoming/ongoing remain
    assert.deepEqual(
        applyOutcomeToggles(rows, { hideHits: true, hideMiss: true }).map(r => r.api_id), [3]);
    // all-off is a no-op (same array reference)
    assert.equal(applyOutcomeToggles(rows, {}), rows);
});

test('noMiss keeps clean-market rows (+upcoming), drops failed markets and tipless', () => {
    const rows = [
        tipRow({ api_id: 1, tip_market: 'O 2.5', tip_outcome: 'hit' }),
        tipRow({ api_id: 2, tip_market: 'O 2.5', tip_outcome: 'miss' }), // fails the market
        tipRow({ api_id: 3, tip_market: '1X', tip_outcome: 'hit' }),
        tipRow({ api_id: 4, tip_market: 'O 1.5', tip_outcome: null }), // clean upcoming
        tipRow({ api_id: 5, tip_market: '1X', tip_outcome: null }), // clean upcoming
        tipRow({ api_id: 6, tip_market: null, tip_outcome: null }), // tipless
    ];
    assert.deepEqual(
        applyOutcomeToggles(rows, { noMiss: true }).map(r => r.api_id), [3, 4, 5]);
});
