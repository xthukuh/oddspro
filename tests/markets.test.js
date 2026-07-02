// Locks the canonical market registry invariants (src/markets.js):
// - both providers' live spellings map to the same canonical column keys
// - matching is by type_name, never type_id (betika reuses type_ids)
// - DB-shaped rows (DECIMAL handicap as string) resolve identically
import { test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { MARKET_COLUMNS, isMarketKey, marketKey, whereMarket } from '../src/markets.js';

test('marketKey maps provider spellings to canonical column keys', () => {
    const cases = [
        // betpawa 1X2
        [{ type_name: '1X2 | Full Time', name: '1' }, '1'],
        [{ type_name: '1X2 | Full Time', name: 'X' }, 'X'],
        [{ type_name: '1X2 | Full Time', name: '2' }, '2'],
        // betika 1X2
        [{ type_name: '1X2', name: '2' }, '2'],
        [{ type_name: '1X2', name: 'W1' }, null],
        // double chance, both spellings
        [{ type_name: 'Double Chance | Full Time', name: '1X' }, '1X'],
        [{ type_name: 'Double Chance | Full Time', name: 'X2' }, 'X2'],
        [{ type_name: 'DOUBLE CHANCE', name: '1/X' }, '1X'],
        [{ type_name: 'DOUBLE CHANCE', name: 'X/2' }, 'X2'],
        [{ type_name: 'DOUBLE CHANCE', name: '1/2' }, '12'],
        // over/under, numeric handicap (scraper shape)
        [{ type_name: 'Over/Under | Full Time', name: 'Over', handicap: 2.5 }, 'O 2.5'],
        [{ type_name: 'Over/Under | Full Time', name: 'Under', handicap: 2.5 }, 'U 2.5'],
        // over/under, string handicap (DB DECIMAL shape via mysql2)
        [{ type_name: 'TOTAL', name: 'OVER 3.5', handicap: '3.5' }, 'O 3.5'],
        [{ type_name: 'TOTAL', name: 'UNDER 0.5', handicap: '0.5' }, 'U 0.5'],
        // non-canonical line
        [{ type_name: 'TOTAL', name: 'OVER 10.5', handicap: 10.5 }, null],
        // unknown market type
        [{ type_name: 'BOTH TEAMS TO SCORE (GG/NG)', name: 'YES' }, null],
    ];
    for (const [row, expected] of cases) {
        assert.equal(marketKey(row), expected, JSON.stringify(row));
    }
});

test('marketKey matches on type_name, never type_id (betika reuses ids)', () => {
    // betika reuses type_id 19 across different team-total markets
    assert.equal(marketKey({ type_id: 19, type_name: 'Z.PSV TOTAL', name: 'OVER 2.5', handicap: 2.5 }), null);
    assert.equal(marketKey({ type_id: 999999, type_name: 'TOTAL', name: 'OVER 2.5', handicap: 2.5 }), 'O 2.5');
});

test('isMarketKey covers the registry and nothing else', () => {
    for (const c of MARKET_COLUMNS) assert.equal(isMarketKey(c.key), true, c.key);
    assert.equal(isMarketKey('O 10.5'), false);
    assert.equal(isMarketKey('GG'), false);
});

test('whereMarket builds type_name conditions, never type_id', async t => {
    const kx = knex({ client: 'mysql2' }); // disconnected builder - no queries run
    t.after(() => kx.destroy());

    const x12 = whereMarket(kx('odds_markets'), '1').toString();
    assert.match(x12, /`type_name` in \('1X2 \| Full Time', '1X2'\)/);
    assert.match(x12, /`name` = '1'/);

    const ou = whereMarket(kx('odds_markets'), 'O 2.5').toString();
    assert.match(ou, /`handicap` = 2\.5/);
    assert.match(ou, /LOWER\(name\) LIKE 'over%'/);

    const dc = whereMarket(kx('odds_markets'), '1X').toString();
    assert.match(dc, /`name` in \('1X', '1\/X'\)/);

    for (const sql of [x12, ou, dc]) assert.doesNotMatch(sql, /type_id/);
    assert.throws(() => whereMarket(kx('odds_markets'), 'ZZ'), TypeError);
});
