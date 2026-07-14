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

// --- Generic market taxonomy (M2 Task 1) ------------------------------------
import { canonicalMarket, _normType } from '../src/markets.js';

test('canonicalMarket unifies provider spellings and passes through unknowns', () => {
    // canonical families keep their existing keys + carry a group + columnizable
    assert.deepEqual(canonicalMarket({ type_name: '1X2 | Full Time', name: '1' }),
        { key: '1', group: 'result', label: '1', columnizable: 'column' });
    assert.equal(canonicalMarket({ type_name: '1X2', name: '2' }).key, '2'); // betika unifies
    // BTTS + DNB become first-class columns
    assert.deepEqual(canonicalMarket({ type_name: 'Both Teams To Score | Full Time', name: 'Yes' }),
        { key: 'GG', group: 'btts', label: 'BTTS Yes', columnizable: 'column' });
    assert.equal(canonicalMarket({ type_name: 'Draw No Bet | Full Time', name: '1' }).key, 'DNB1');
    // huge-cardinality market -> filter-only, never a column, still a deterministic key
    const cs = canonicalMarket({ type_name: 'Correct Score | Full Time', name: '2:1' });
    assert.equal(cs.columnizable, 'filter-only');
    assert.equal(cs.group, 'correct_score');
    // wholly unknown market -> raw passthrough (never null, never dropped)
    const raw = canonicalMarket({ type_name: 'Some New Market X', name: 'Whatever' });
    assert.match(raw.key, /^raw:/);
    assert.equal(raw.columnizable, 'filter-only');
    // type_name, not type_id (betika reuses id 19) -- RECONCILED per the M2 design note:
    // a Betika "<TEAM> TOTAL" is a team_total, not a dropped/'other' market.
    assert.equal(canonicalMarket({ type_id: 19, type_name: 'Z.PSV TOTAL', name: 'OVER 2.5', handicap: 2.5 }).group, 'team_total');
});

test('canonicalMarket confirmed cross-provider BTTS/DNB spellings from the live inventory', () => {
    // betika: "BOTH TEAMS TO SCORE (GG/NG)" outcome names are literally NO/YES
    assert.deepEqual(canonicalMarket({ type_name: 'BOTH TEAMS TO SCORE (GG/NG)', name: 'YES' }),
        { key: 'GG', group: 'btts', label: 'BTTS Yes', columnizable: 'column' });
    assert.equal(canonicalMarket({ type_name: 'BOTH TEAMS TO SCORE (GG/NG)', name: 'NO' }).key, 'NG');
    // betpawa period-suffixed BTTS also unifies to the same family (period tag on the key)
    const btts1h = canonicalMarket({ type_name: 'Both Teams To Score | First Half', name: 'Yes' });
    assert.equal(btts1h.group, 'btts');
    assert.equal(btts1h.columnizable, 'column');
    assert.notEqual(btts1h.key, 'GG'); // must NOT collide with the full-time key
    // NOTE: the inventory (tmp/market-inventory.txt, 18,606 lines) has NO Betika
    // "DRAW NO BET" type_name at all -- do not assert a fake Betika DNB spelling.
    // Draw No Bet is BetPawa-only; a betika-shaped guess must NOT resolve as dnb.
    assert.notEqual(canonicalMarket({ type_name: 'DRAW NO BET', name: '1' }).group, 'dnb');
});

test('canonicalMarket: Betika period-prefixed markets normalize before family lookup', () => {
    // "1ST HALF - TOTAL" (confirmed live spelling) must resolve into the SAME
    // over_under family as full-time TOTAL, but with a period tag so it never
    // collides with the full-time canonical key.
    const row = { type_name: '1ST HALF - TOTAL', name: 'OVER 2.5', handicap: 2.5 };
    const m = canonicalMarket(row);
    assert.equal(m.group, 'over_under');
    assert.equal(m.columnizable, 'column');
    assert.notEqual(m.key, 'O 2.5'); // must not collide with the full-time canonical key
    assert.match(m.key, /^O 2\.5/);
    // 1ST HALF - 1X2 similarly unifies with the result family, period-tagged
    const halfResult = canonicalMarket({ type_name: '1ST HALF - 1X2', name: '1' });
    assert.equal(halfResult.group, 'result');
    assert.notEqual(halfResult.key, '1');
});

test('canonicalMarket: "A & B" / "A and B" combos are their own grouped family, not btts/team_total', () => {
    // betika literal spelling
    const betikaCombo = canonicalMarket({ type_name: '1X2 & BOTH TEAMS TO SCORE', name: '1 & YES' });
    assert.equal(betikaCombo.group, 'combo');
    assert.equal(betikaCombo.columnizable, 'grouped');
    // betpawa literal spelling ("and", not "&")
    const betpawaCombo = canonicalMarket({ type_name: '1X2 and Both Teams To Score | Full Time', name: '1 - Yes' });
    assert.equal(betpawaCombo.group, 'combo');
    // a landmine in the real data: team names containing "&" (e.g. "Walton & Hersham")
    // must NOT be misread as a combo -- they are team_total ("<TEAM> TOTAL" suffix).
    const teamNameWithAmpersand = canonicalMarket({ type_name: 'WALTON & HERSHAM TOTAL', name: 'OVER 1.5', handicap: 1.5 });
    assert.equal(teamNameWithAmpersand.group, 'team_total');
    assert.notEqual(teamNameWithAmpersand.group, 'combo');
    // "DOUBLE CHANCE & TOTAL" ends in " TOTAL" too (a second landmine) but the first
    // segment is a recognized market keyword, so it must resolve as combo, not team_total.
    const dcAndTotal = canonicalMarket({ type_name: 'DOUBLE CHANCE & TOTAL', name: '1/2 & OVER 1.5', handicap: 1.5 });
    assert.equal(dcAndTotal.group, 'combo');
});

test('canonicalMarket: BetPawa clean {home}/{away} team-total equivalents unify with Betika team_total', () => {
    const home = canonicalMarket({ type_name: 'Over/Under | {home} | Full Time', name: 'Over', handicap: 2.5 });
    assert.equal(home.group, 'team_total');
    assert.equal(home.columnizable, 'grouped');
    const away = canonicalMarket({ type_name: 'Over/Under | {away} | Full Time', name: 'Under', handicap: 1.5 });
    assert.equal(away.group, 'team_total');
});

test('_normType strips Betika period prefixes and BetPawa period suffixes, tagging period', () => {
    assert.deepEqual(_normType('1ST HALF - TOTAL'), { base: 'TOTAL', period: '1H' });
    assert.deepEqual(_normType('2ND HALF - 1X2'), { base: '1X2', period: '2H' });
    assert.deepEqual(_normType('Both Teams To Score | Full Time'), { base: 'Both Teams To Score', period: null });
    assert.deepEqual(_normType('Both Teams To Score | Second Half'), { base: 'Both Teams To Score', period: '2H' });
    assert.equal(_normType('1X2').base, '1X2');
    assert.equal(_normType('1X2').period, null);
});
