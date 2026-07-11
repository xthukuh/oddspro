import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labelFor, availableColumnKeys } from '../web/src/columns.js';

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
    assert.equal(labelFor('tip', CATALOG), 'Tip');            // BASE_COLUMNS
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
