import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFor, availableColumnKeys, filterType, filterHint, requestedMarkets } from '../web/src/columns.js';

// Catalog shaped like GET /api/columns (stats slice only - labelFor reads it).
const CATALOG = {
    stats: [
        { key: 'league', label: 'League' },
        { key: 'season', label: 'Season' },
        { key: 'home_form', label: 'Home Form' },
        { key: 'fs:Total Shots', label: 'Total Shots (H/A)' },
    ],
};

test('labelFor matches the table title for base / extra / stat / market keys', () => {
    assert.equal(labelFor('banker', CATALOG), 'Tip');         // BASE_COLUMNS: the Pick leads (2026-10-16)
    assert.equal(labelFor('tip', CATALOG), 'Stats tip');      // BASE_COLUMNS
    assert.equal(labelFor('status', CATALOG), 'Status');      // BASE_COLUMNS
    assert.equal(labelFor('hot', CATALOG), 'Over 2.5 pick');  // extra base
    assert.equal(labelFor('home_form', CATALOG), 'Home Form'); // stat label
    assert.equal(labelFor('O 2.5', CATALOG), 'O 2.5');        // market -> itself
    assert.equal(labelFor('nope', CATALOG), 'nope');          // unknown -> itself
});

test('availableColumnKeys reflects only markets/stats present in the loaded rows', () => {
    const rows = [
        {
            markets: { 1: 2.1, 'O 2.5': 1.5 },
            markets_stale: { 'U 2.5': 2.4 }, // last-seen prices still count
            stats: { 'fs:Total Shots': '10 / 5' },
            season: 2024, home_form: 'WWW', league: 'X',
        },
        { markets: { 1: 1.9 }, markets_stale: {}, stats: {}, season: null, home_form: null, league: 'Y' },
    ];
    const { markets, stats } = availableColumnKeys(rows, CATALOG);
    assert.equal(markets.has('1'), true);
    assert.equal(markets.has('O 2.5'), true);
    assert.equal(markets.has('U 2.5'), true);   // stale counts
    assert.equal(markets.has('2'), false);      // never present
    assert.equal(stats.has('fs:Total Shots'), true);
    assert.equal(stats.has('season'), true);    // top-level field present in row 1
    assert.equal(stats.has('home_form'), true);
    assert.equal(stats.has('league'), true);
});

test('availableColumnKeys is empty for no rows', () => {
    const { markets, stats } = availableColumnKeys([], CATALOG);
    assert.equal(markets.size, 0);
    assert.equal(stats.size, 0);
});

test('filterType classifies markets/stats/numeric/date/text fields', () => {
    assert.equal(filterType({ key: 'O 2.5', group: 'market' }), 'number');   // odds
    assert.equal(filterType({ key: 'fs:Total Shots', group: 'stat' }), 'number'); // post-match stat
    assert.equal(filterType({ key: 'h2h_count', group: 'base' }), 'number');  // numeric-sort key
    assert.equal(filterType({ key: 'home_form', group: 'base' }), 'number');  // derived-numeric
    assert.equal(filterType({ key: 'start_time', group: 'base' }), 'date');
    assert.equal(filterType({ key: 'fixture', group: 'base' }), 'text');
    assert.equal(filterType({ key: 'league', group: 'stat' }), 'text');
});

test('filterHint returns key, type and a working example expression', () => {
    assert.deepEqual(filterHint({ key: 'h2h_count', group: 'base' }),
        { key: 'h2h_count', type: 'number', example: "$row['h2h_count'] >= 2" });
    assert.deepEqual(filterHint({ key: 'O 2.5', group: 'market' }),
        { key: 'O 2.5', type: 'number', example: "$row['O 2.5'] >= 1.8" });
    assert.deepEqual(filterHint({ key: 'tip', group: 'base' }),
        { key: 'tip', type: 'number', example: "$row['tip'] >= 0.7" });
    assert.deepEqual(filterHint({ key: 'fixture', group: 'base' }),
        { key: 'fixture', type: 'text', example: "contains(raw('fixture'), '...')" });
    assert.deepEqual(filterHint({ key: 'start_time', group: 'base' }),
        { key: 'start_time', type: 'date', example: "$row['start_time'] >= <timestamp>" });
    assert.equal(filterHint({}), null);
});

test('availableColumnKeys merges the lean body market_keys', () => {
    const rows = [{ markets: { '1X': 1.4 }, markets_stale: {} }];
    const { markets } = availableColumnKeys(rows, { stats: [] }, ['O 2.5', 'BTTS:yes']);
    assert.deepEqual([...markets].sort(), ['1X', 'BTTS:yes', 'O 2.5']);
});

test('requestedMarkets: an untouched selection with no extras is default', () => {
    assert.equal(requestedMarkets(null, [{ type: 'magic', id: 'banker' }], []), 'default');
    assert.equal(requestedMarkets(null, [], null), 'default');
});

test('requestedMarkets adds sort-chain and filter keys, sorted and unique', () => {
    const filters = { type: 'group', items: [
        { type: 'expr', expr: `$row["O 1.5"] > 1.2 && $row['U 3.5'] < 2` },
        { key: 'X', op: 'gt', value: 1, enabled: false },
        { key: 'BTTS:no', op: 'gt', value: 1, col: 'O 2.5' },
    ] };
    assert.equal(
        requestedMarkets(['O 2.5', '1X'], [{ type: 'column', key: 'BTTS:yes', dir: 'desc' }], filters),
        '1X,BTTS:no,BTTS:yes,O 1.5,O 2.5,U 3.5',
    );
    assert.equal(requestedMarkets(null, [{ type: 'column', key: 'goals', dir: 'asc' }], []), 'default,goals');
});
