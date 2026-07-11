import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    serverKeys, splitFilters, applyClientFilters, applyOutcomeToggles,
    distinctValues, toFilterCsv, applyOneOfEach, conditionCount,
    stampSelection, applySelectionHide, applySelectionKeep, displayedSummary,
} from '../web/src/filterValues.js';
import { parseFilterList } from '../src/db/filter-csv.js';

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

test('splitFilters: a prefixed tip condition (R26b) is forced client-side', () => {
    const filters = [
        { key: 'tip', op: 'like', value: 'O 2.5' },   // plain → server (fp.tip_market)
        { key: 'tip', op: 'like', value: '2:O 2.5' }, // runner-up prefix → client
        { key: 'tip', op: 'like', value: 'H:O 2.5' }, // outcome prefix → client
    ];
    const { server, client } = splitFilters(filters, CATALOG);
    assert.deepEqual(server.map(f => f.value), ['O 2.5']);
    assert.deepEqual(client.map(f => f.value), ['2:O 2.5', 'H:O 2.5']);
});

test('splitFilters: tip_confidence (client-only derived field) routes client-side', () => {
    const { server, client } = splitFilters([{ key: 'tip_confidence', op: 'gte', value: '70' }], CATALOG);
    assert.equal(server.length, 0);
    assert.deepEqual(client.map(f => f.key), ['tip_confidence']);
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

test('splitFilters routes regex ops and expr conditions client-side', () => {
    const filters = [
        { key: 'goals', op: 'gte', value: '2' },          // SQL-able -> server
        { key: 'goals', op: 'match', value: '^2' },       // regex -> client
        { key: 'provider', op: 'not-match', value: 'x' }, // regex -> client
        { type: 'expr', expr: "$row['goals'] > 2" },      // expression -> client
    ];
    const { server, client } = splitFilters(filters, CATALOG);
    assert.deepEqual(server.map(f => f.op), ['gte']);
    assert.equal(client.length, 3);
});

test('splitFilters sends an advanced group model entirely client-side', () => {
    const model = {
        type: 'group', join: 'or', items: [
            { key: 'goals', op: 'gte', value: '2' },
            { key: 'provider', op: 'eq', value: 'betika' },
        ],
    };
    const { server, client } = splitFilters(model, CATALOG);
    assert.deepEqual(server, []);
    assert.equal(client, model); // the whole model runs locally
});

test('conditionCount counts leaf conditions in flat arrays and nested groups', () => {
    assert.equal(conditionCount([]), 0);
    assert.equal(conditionCount([{ key: 'goals', op: 'gte', value: '2' }]), 1);
    const model = {
        type: 'group', join: 'and', items: [
            { key: 'goals', op: 'gte', value: '2' },
            {
                type: 'group', join: 'or', items: [
                    { key: 'provider', op: 'eq', value: 'x' },
                    { type: 'expr', expr: '1' },
                ],
            },
        ],
    };
    assert.equal(conditionCount(model), 3);
});

test('splitFilters forces league (CLIENT_ONLY_KEYS) client even when a server key', () => {
    // league renders "Country - Name" but its SQL column is l.name alone, so it
    // must filter on the display, client-side.
    const cat = { base: [{ key: 'league', filterable: true }], markets: [], stats: [] };
    const { server, client } = splitFilters([{ key: 'league', op: 'in', value: 'a,b' }], cat);
    assert.equal(server.length, 0);
    assert.deepEqual(client.map(f => f.key), ['league']);
});

// --- value pickers: distinct values + CSV round-trip --------------------
test('distinctValues returns sorted distinct displayed values (strings + numbers)', () => {
    const rows = [
        { league: 'B', status: 'FT', season: 2024 },
        { league: 'A', status: 'NS', season: 2024 },
        { league: 'A', status: 'FT', season: 2023 },
        { league: null, status: '', season: undefined },
    ];
    assert.deepEqual(distinctValues(rows, { key: 'league', group: 'base' }), ['A', 'B']);
    assert.deepEqual(distinctValues(rows, { key: 'status', group: 'base' }), ['FT', 'NS']);
    // numbers sort numerically, not lexically
    assert.deepEqual(distinctValues(rows, { key: 'season', group: 'base' }), [2023, 2024]);
});

test('distinctValues bails to [] once the distinct count exceeds the cap', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ league: `L${i}` }));
    assert.deepEqual(distinctValues(rows, { key: 'league', group: 'base' }, 5), []);
});

test('toFilterCsv quotes commas/spaces/quotes and round-trips through parseFilterList', () => {
    const items = ['A', 'B, C', 'D E', 'quote"d', 'F'];
    assert.deepEqual(parseFilterList(toFilterCsv(items)), items);
    // plain items stay unquoted
    assert.equal(toFilterCsv(['x', 'y']), 'x,y');
    assert.equal(toFilterCsv([]), '');
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

// One-of-each collapses to one row per fixture, choosing the highest-priority
// provider present; games only a lower-priority provider has still survive.
const provRow = (api_id, provider, extra = {}) => ({ api_id, provider, ...extra });

test('applyOneOfEach keeps the top-priority provider per fixture', () => {
    const rows = [
        provRow(1, 'betpawa'), provRow(1, 'betika'), // fixture 1 in both
        provRow(2, 'betika'),                         // fixture 2 only in betika
        provRow(3, 'betpawa'), provRow(3, 'betika'), // fixture 3 in both
    ];
    const out = applyOneOfEach(rows, ['betpawa', 'betika']);
    assert.deepEqual(out.map(r => [r.api_id, r.provider]),
        [[1, 'betpawa'], [2, 'betika'], [3, 'betpawa']]);
});

test('applyOneOfEach honours a reversed priority order', () => {
    const rows = [provRow(1, 'betpawa'), provRow(1, 'betika')];
    assert.deepEqual(applyOneOfEach(rows, ['betika', 'betpawa']).map(r => r.provider), ['betika']);
});

test('applyOneOfEach preserves incoming (sorted) order of survivors', () => {
    const rows = [provRow(2, 'betika'), provRow(1, 'betpawa'), provRow(1, 'betika'), provRow(3, 'betpawa')];
    assert.deepEqual(applyOneOfEach(rows, ['betpawa', 'betika']).map(r => r.api_id), [2, 1, 3]);
});

test('applyOneOfEach ranks unknown providers last and never merges id-less rows', () => {
    const rows = [provRow(1, 'mystery'), provRow(1, 'betpawa'), provRow(null, 'betika'), provRow(null, 'betpawa')];
    const out = applyOneOfEach(rows, ['betpawa', 'betika']);
    // fixture 1 -> betpawa (known beats unknown); both id-less rows survive
    assert.equal(out.filter(r => r.api_id === 1).length, 1);
    assert.equal(out.find(r => r.api_id === 1).provider, 'betpawa');
    assert.equal(out.filter(r => r.api_id == null).length, 2);
});

// --- row selection: stamp by identity + hide cut --------------------------
test('stampSelection sets select by match_id and never mutates the source', () => {
    const rows = [{ match_id: 1 }, { match_id: 2 }, { match_id: 3 }];
    const out = stampSelection(rows, new Set([1, 3]));
    assert.deepEqual(out.map(r => r.select), [true, false, true]);
    assert.equal('select' in rows[0], false); // source untouched
    // accepts a plain array of ids too
    assert.deepEqual(stampSelection(rows, [2]).map(r => r.select), [false, true, false]);
});

test('applySelectionHide drops checked rows only when hide is on', () => {
    const rows = stampSelection([{ match_id: 1 }, { match_id: 2 }], new Set([1]));
    assert.deepEqual(applySelectionHide(rows, true).map(r => r.match_id), [2]);
    assert.equal(applySelectionHide(rows, false), rows); // no-op passthrough
});

test('applySelectionKeep keeps only checked rows (inverse of hide)', () => {
    const rows = stampSelection([{ match_id: 1 }, { match_id: 2 }, { match_id: 3 }], new Set([1, 3]));
    assert.deepEqual(applySelectionKeep(rows, true).map(r => r.match_id), [1, 3]);
    assert.equal(applySelectionKeep(rows, false), rows); // no-op passthrough
});

// --- footer betting ledger over the displayed rows ------------------------
test('displayedSummary: flat-stake ledger over displayed picks (deduped by fixture)', () => {
    const rows = [
        row({ api_id: 1, tip_market: 'O 2.5', tip_price: 2.0, tip_outcome: 'hit' }),
        row({ api_id: 1, tip_market: 'O 2.5', tip_price: 2.0, tip_outcome: 'hit' }), // same fixture → deduped
        row({ api_id: 2, tip_market: '1X', tip_price: 1.5, tip_outcome: 'miss' }),
        row({ api_id: 3, tip_market: 'O 1.5', tip_price: 1.5, tip_outcome: null }),  // upcoming
        row({ api_id: 4, tip_market: null, tip_price: null }),                        // no tip → skipped
        row({ api_id: 5, tip_market: 'X', tip_price: 0 }),                            // void price → skipped
    ];
    const s = displayedSummary(rows, 100);
    assert.equal(s.picks, 3);          // fixtures 1, 2, 3
    assert.equal(s.totalOdds, 5.0);    // 2.0 + 1.5 + 1.5
    assert.equal(s.value, 500);        // 100 × 5.0 (potential if all won)
    assert.equal(s.won, 1);
    assert.equal(s.lost, 1);
    assert.equal(s.settled, 2);
    assert.equal(s.staked, 200);       // 2 settled × 100
    assert.equal(s.returned, 200);     // the hit: 100 × 2.0
    assert.equal(s.profit, 0);         // returned − staked
});

test('displayedSummary: default stake 1; empty input is all zeros', () => {
    assert.deepEqual(displayedSummary([], 1),
        { picks: 0, totalOdds: 0, value: 0, won: 0, lost: 0, settled: 0, staked: 0, returned: 0, profit: 0 });
    const s = displayedSummary([row({ api_id: 1, tip_market: 'O 2.5', tip_price: 3.0, tip_outcome: 'hit' })]);
    assert.equal(s.profit, 2); // stake 1: returned 3 − staked 1
});

// --- synthetic "No" row-number field is filterable on its load-order anchor ---
test('the No field filters on the stamped _no anchor and routes client-side', () => {
    const rows = [row({ _no: 1 }), row({ _no: 2 }), row({ _no: 3 }), row({ _no: null })];
    const cols = [...COLUMNS, { key: 'no', group: 'base' }];
    // `no lte 2` keeps the two earliest-loaded rows; unstamped (_no null) never matches
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'no', op: 'lte', value: '2' }], cols).map(r => r._no),
        [1, 2]);
    // it's a synthetic column (not in the catalog), so it must run client-side
    const { server, client } = splitFilters([{ key: 'no', op: 'lte', value: '2' }], CATALOG);
    assert.equal(server.length, 0);
    assert.deepEqual(client.map(f => f.key), ['no']);
});

test('applyOneOfEach is a no-op for 0/1 rows', () => {
    const one = [provRow(1, 'betpawa')];
    assert.equal(applyOneOfEach(one, ['betpawa']), one);
    assert.equal(applyOneOfEach([], ['betpawa']).length, 0);
});
