// Locks marketIdentity() (src/markets.js, M2 Task 2) — the generic replacement
// for whereMarket() that builds an odds_markets WHERE for ANY canonicalMarket()
// key (canonical, named simple family, or best-effort grouped/raw). Disconnected
// knex builder (no live DB), same idiom as tests/markets.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { marketIdentity, canonicalMarket } from '../src/markets.js';

test('marketIdentity builds type_name WHEREs for canonical, family and raw keys', () => {
    const kx = knex({ client: 'mysql2' }); // disconnected builder — no queries run
    // canonical period-null keys delegate to the existing proven builder
    const x12 = marketIdentity(kx('odds_markets'), '1').toString();
    assert.match(x12, /`type_name` in \('1X2 \| Full Time', '1X2'\)/);
    assert.match(x12, /`name` = '1'/);

    const ou = marketIdentity(kx('odds_markets'), 'O 2.5').toString();
    assert.match(ou, /`handicap` = 2\.5/);
    assert.match(ou, /LOWER\(name\) LIKE 'over%'/);

    // BTTS named simple family (period-null, exact)
    const gg = marketIdentity(kx('odds_markets'), 'GG').toString();
    assert.match(gg, /`type_name` in/);
    assert.match(gg, /LOWER\(name\) LIKE 'yes%'/i);

    // DNB named simple family (exact outcome name)
    const dnb1 = marketIdentity(kx('odds_markets'), 'DNB1').toString();
    assert.match(dnb1, /`type_name` in \('Draw No Bet \| Full Time'\)/);
    assert.match(dnb1, /`name` = '1'/);

    // ODD/EVEN named simple family
    const odd = marketIdentity(kx('odds_markets'), 'ODD').toString();
    assert.match(odd, /`type_name` in \('Odd\/Even \| Full Time'\)/);
    assert.match(odd, /LOWER\(name\) LIKE 'odd%'/i);

    // raw passthrough decodes back to type_name + name (best-effort LIKE)
    const raw = marketIdentity(kx('odds_markets'), 'raw:winning-margin:home-by-1').toString();
    assert.match(raw, /type_name/);
    assert.match(raw, /winning-margin/);

    // never type_id, across every key shape
    for (const k of ['1', 'O 2.5', 'GG', 'NG', 'DNB1', 'DNB2', 'ODD', 'EVEN',
        'raw:winning-margin:home-by-1', 'TT:O 2.5', 'TT:O 2.5:1H',
        'combo:1x2-both-teams-to-score:1-yes', 'HTFT:1-1', 'CS:2-1',
        '1:1H', 'O 2.5:2H', 'GG:1H'])
        assert.doesNotMatch(marketIdentity(kx('odds_markets'), k).toString(), /type_id/);
});

test('marketIdentity best-effort decode for TT:/combo:/HTFT:/CS: grouped keys never crashes', () => {
    const kx = knex({ client: 'mysql2' });
    const tt = marketIdentity(kx('odds_markets'), 'TT:O 2.5').toString();
    assert.match(tt, /`handicap` = 2\.5/);
    assert.match(tt, /LOWER\(name\) LIKE 'over%'/);

    const ttPeriod = marketIdentity(kx('odds_markets'), 'TT:U 1.5:1H').toString();
    assert.match(ttPeriod, /`handicap` = 1\.5/);
    assert.match(ttPeriod, /LOWER\(name\) LIKE 'under%'/);

    const htft = marketIdentity(kx('odds_markets'), 'HTFT:home-home').toString();
    assert.match(htft, /`type_name` in \('Half Time\/Full Time', 'HALFTIME\/FULLTIME'\)/);
    assert.match(htft, /home-home/);

    const cs = marketIdentity(kx('odds_markets'), 'CS:2-1').toString();
    assert.match(cs, /`type_name` in \('Correct Score', 'CORRECT SCORE'\)/);
    assert.match(cs, /2-1/);

    const combo = marketIdentity(kx('odds_markets'), 'combo:1x2-both-teams-to-score:1-yes').toString();
    assert.match(combo, /1x2-both-teams-to-score/);
    assert.match(combo, /1-yes/);

    // period-tagged canonical/family keys are best-effort (loosened type_name LIKE)
    // but must still constrain something sensible and never throw.
    const halfResult = marketIdentity(kx('odds_markets'), '1:1H').toString();
    assert.match(halfResult, /LOWER\(type_name\) LIKE '%1x2%'/i);
    assert.match(halfResult, /`name` = '1'/);

    const halfOu = marketIdentity(kx('odds_markets'), 'O 2.5:2H').toString();
    assert.match(halfOu, /`handicap` = 2\.5/);

    const halfGg = marketIdentity(kx('odds_markets'), 'GG:1H').toString();
    assert.match(halfGg, /LOWER\(type_name\) LIKE/i);
    assert.match(halfGg, /LOWER\(name\) LIKE 'yes%'/i);

    // wholly unrecognized key shape must never crash
    assert.doesNotThrow(() => marketIdentity(kx('odds_markets'), 'totally:unknown:shape').toString());
});

// --- Consistency guard: canonicalMarket (row -> key) and marketIdentity
// (key -> WHERE) must never drift apart. For each representative FULL-TIME row,
// derive the key via canonicalMarket, then assert the WHERE marketIdentity
// builds for that key still matches the SAME row's type_name + outcome name.
test('marketIdentity WHERE agrees with canonicalMarket for the exact named-family/canonical keys', () => {
    const kx = knex({ client: 'mysql2' });

    const ggRow = { type_name: 'Both Teams To Score | Full Time', name: 'Yes' };
    const ggKey = canonicalMarket(ggRow).key;
    assert.equal(ggKey, 'GG');
    const ggSql = marketIdentity(kx('odds_markets'), ggKey).toString();
    assert.match(ggSql, new RegExp(`'${ggRow.type_name}'`));
    assert.match(ggSql, /LOWER\(name\) LIKE 'yes%'/i);

    const dnbRow = { type_name: 'Draw No Bet | Full Time', name: '1' };
    const dnbKey = canonicalMarket(dnbRow).key;
    assert.equal(dnbKey, 'DNB1');
    const dnbSql = marketIdentity(kx('odds_markets'), dnbKey).toString();
    assert.match(dnbSql, new RegExp(`'${dnbRow.type_name}'`));
    assert.match(dnbSql, /`name` = '1'/);

    const oddRow = { type_name: 'Odd/Even | Full Time', name: 'Odd' };
    const oddKey = canonicalMarket(oddRow).key;
    assert.equal(oddKey, 'ODD');
    const oddSql = marketIdentity(kx('odds_markets'), oddKey).toString();
    assert.match(oddSql, new RegExp(`'${oddRow.type_name}'`));
    assert.match(oddSql, /LOWER\(name\) LIKE 'odd%'/i);

    const ouRow = { type_name: 'Over/Under | Full Time', name: 'Over', handicap: 2.5 };
    const ouKey = canonicalMarket(ouRow).key;
    assert.equal(ouKey, 'O 2.5');
    const ouSql = marketIdentity(kx('odds_markets'), ouKey).toString();
    assert.match(ouSql, new RegExp(`'${ouRow.type_name}'`));
    assert.match(ouSql, /`handicap` = 2\.5/);
    assert.match(ouSql, /LOWER\(name\) LIKE 'over%'/i);
});
