// /odds parsing + row-shaping (src/apisports-odds.js): the Pinnacle
// reference line capture. Pure module - no .env / DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReferenceRows, marketKeyOf, isoToEat, PINNACLE_BOOKMAKER_ID } from '../src/apisports-odds.js';

// Trimmed from a live 2026-10-11 page (fixture 1490525).
const item = (over = {}) => ({
    league: { id: 253, name: 'Major League Soccer', season: 2026 },
    fixture: { id: 1490525, timezone: 'UTC', date: '2026-10-11T23:00:00+00:00', timestamp: 1791759600 },
    update: '2026-10-11T20:01:17+00:00',
    bookmakers: [{
        id: 4, name: 'Pinnacle', bets: [
            { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.50' }, { value: 'Draw', odd: '5.08' }, { value: 'Away', odd: '5.70' }] },
            { id: 4, name: 'Asian Handicap', values: [{ value: 'Home -1.25', odd: '2.04' }] },
            { id: 5, name: 'Goals Over/Under', values: [
                { value: 'Over 1.5', odd: '1.13' }, { value: 'Under 1.5', odd: '6.58' },
                { value: 'Over 2.5', odd: '1.41' }, { value: 'Under 2.5', odd: '3.01' },
                { value: 'Over 2.75', odd: '1.50' }, { value: 'Over 3.0', odd: '1.61' },
                { value: 'Over 3.5', odd: '2.06' }, { value: 'Under 3.5', odd: '1.84' },
                { value: 'Over 4.5', odd: '3.35' },
            ] },
            { id: 6, name: 'Goals Over/Under First Half', values: [{ value: 'Over 1.5', odd: '2.07' }] },
        ],
    }],
    ...over,
});

test('isoToEat: offset stamp to EAT wall clock', () => {
    assert.equal(isoToEat('2026-10-11T20:01:17+00:00'), '2026-10-11 23:01:17');
    assert.equal(isoToEat('2026-10-11T22:30:00+02:00'), '2026-10-11 23:30:00');
    assert.equal(isoToEat('garbage'), null);
});

test('marketKeyOf: Match Winner and the three .5 total lines only', () => {
    assert.equal(marketKeyOf(1, 'Home'), '1');
    assert.equal(marketKeyOf(1, 'Draw'), 'X');
    assert.equal(marketKeyOf(1, 'Away'), '2');
    assert.equal(marketKeyOf(5, 'Over 2.5'), 'O 2.5');
    assert.equal(marketKeyOf(5, 'Under 1.5'), 'U 1.5');
    assert.equal(marketKeyOf(5, 'Over 0.5'), null);   // owner rule: never O 0.5
    assert.equal(marketKeyOf(5, 'Over 4.5'), null);
    assert.equal(marketKeyOf(5, 'Over 2.75'), null);
    assert.equal(marketKeyOf(6, 'Over 1.5'), null);   // first half
    assert.equal(marketKeyOf(4, 'Home -1.25'), null);
});

test('buildReferenceRows: keeps the nine engine markets of the item', () => {
    const { rows, skipped } = buildReferenceRows([item()]);
    assert.equal(skipped.length, 0);
    const by = Object.fromEntries(rows.map(r => [r.market, r.price]));
    assert.deepEqual(by, { 1: 1.5, X: 5.08, 2: 5.7, 'O 1.5': 1.13, 'U 1.5': 6.58, 'O 2.5': 1.41, 'U 2.5': 3.01, 'O 3.5': 2.06, 'U 3.5': 1.84 });
    for (const r of rows) {
        assert.equal(r.fixture_id, 1490525);
        assert.equal(r.bookmaker_id, PINNACLE_BOOKMAKER_ID);
        assert.equal(r.source_updated_at, '2026-10-11 23:01:17');
    }
});

test('buildReferenceRows: one bad item is skipped, never thrown', () => {
    const bad = { fixture: { id: 'x' }, update: 'nope', bookmakers: [] };
    const noStamp = item({ fixture: { id: 7 }, update: 'not a date' });
    const { rows, skipped } = buildReferenceRows([bad, item(), noStamp, null]);
    assert.equal(skipped.length, 3);
    assert.equal(rows.length, 9);
});

test('buildReferenceRows: null bets / values and junk odds are tolerated', () => {
    const it = item({ bookmakers: [{ id: 4, bets: [{ id: 1, values: [{ value: 'Home', odd: null }, { value: 'Draw', odd: '1.00' }, { value: 'Away', odd: '2.10' }] }, { id: 5, values: null }] }] });
    const { rows, skipped } = buildReferenceRows([it, item({ fixture: { id: 9 }, bookmakers: [{ id: 4, bets: null }] })]);
    assert.equal(skipped.length, 0);
    assert.deepEqual(rows.map(r => r.market), ['2']);
});

test('buildReferenceRows: only the requested bookmaker is read', () => {
    const it = item({ bookmakers: [{ id: 8, bets: [{ id: 1, values: [{ value: 'Home', odd: '1.90' }] }] }] });
    assert.equal(buildReferenceRows([it]).rows.length, 0);
    assert.equal(buildReferenceRows([it], { bookmakerId: 8 }).rows.length, 1);
});
