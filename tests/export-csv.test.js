import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsvString, buildRecordCsv } from '../web/src/exportCsv.js';

test('toCsvString joins headers + rows with CRLF line endings', () => {
    assert.equal(toCsvString(['a', 'b'], [['1', '2'], ['3', '4']]), 'a,b\r\n1,2\r\n3,4');
});

test('toCsvString quotes fields with comma/quote/newline and doubles inner quotes', () => {
    assert.equal(
        toCsvString(['x'], [['a,b'], ['c"d'], ['e\nf']]),
        'x\r\n"a,b"\r\n"c""d"\r\n"e\nf"',
    );
});

test('toCsvString renders null/undefined/number cells safely', () => {
    assert.equal(toCsvString(['x', 'y', 'z'], [[null, undefined, 2.5]]), 'x,y,z\r\n,,2.5');
});

test('toCsvString with no rows is just the header line', () => {
    assert.equal(toCsvString(['a', 'b'], []), 'a,b');
});

// --- buildRecordCsv: the full-record export schema ----------------------
const CATALOG = {
    markets: [{ key: '1' }, { key: 'O 2.5' }],
    stats: [
        { key: 'season', label: 'Season' },              // static stat (ignored here)
        { key: 'fs:Total Shots', label: 'Total Shots (H/A)' },
    ],
};
const REC = {
    api_id: 5, start_time: '2026-07-11 07:30:00', league: 'AUS - NPL',
    home_team: 'A', away_team: 'B', fixture: 'A, B - C', provider: 'betpawa',
    status: 'NS', score: null, goals: null, updated_at: '2026-07-11 06:00:00',
    home_rank: 3, home_form: 'WWDLW', h2h: '2W-1D-0L',
    hot: true, hot_score: 4, tip_market: 'O 2.5', tip_price: 1.5, tip_confidence: 0.72,
    tip_outcome: null, markets: { 1: 2.1 }, markets_stale: { 'O 2.5': 1.5 },
    stats: { 'fs:Total Shots': '10 / 5' },
};

test('buildRecordCsv exports full details incl. hidden fields, markets and stats', () => {
    const csv = buildRecordCsv([REC], CATALOG);
    const [header, row] = csv.split('\r\n');
    // hidden/folded columns present
    for (const h of ['ID', 'Updated', 'Home Team', 'Away Team', 'H2H', 'Hot']) {
        assert.ok(header.includes(h), `header missing ${h}`);
    }
    // every catalog market becomes a column; fs stat uses its label
    assert.ok(header.includes('O 2.5'));
    assert.ok(header.includes('Total Shots (H/A)'));
    // values: escaped comma, tip % as integer, market price, stale fallback, stat
    assert.ok(row.includes('"A, B - C"'));
    assert.ok(row.split(',').includes('72'));   // 0.72 -> 72
    assert.ok(row.includes('2.1'));              // market 1
    assert.ok(row.includes('1.5'));              // O 2.5 stale fallback
    assert.ok(row.endsWith('10 / 5'));           // stat is the last column
});

test('buildRecordCsv is header-only for no records', () => {
    const csv = buildRecordCsv([], CATALOG);
    assert.equal(csv.includes('\r\n'), false);
    assert.ok(csv.startsWith('ID,'));
});
