import test from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, groupOf, cellKey, makeCalibrator } from '../src/db/leg-calibration.js';

test('bands and groups match the replay taxonomy', () => {
    assert.equal(bandOf(1.01), '1.02');
    assert.equal(bandOf(1.35), '1.35');
    assert.equal(bandOf(9.0), 'long');
    assert.equal(groupOf('O 0.5'), 'O0.5');       // the known trap cell stays isolated
    assert.equal(groupOf('U 4.5'), 'under');   // deliberately UNSPLIT - see groupOf's comment
    assert.equal(groupOf('TT:H:O 1.5'), 'tt-over');
    assert.equal(groupOf('TT:A:U 2.5'), 'tt-under');
    assert.equal(groupOf('GG'), 'btts');
    assert.equal(groupOf('DNB1'), 'dnb');
    assert.equal(groupOf('X2'), 'dc');
    assert.equal(groupOf('EVEN'), 'oe');
    assert.equal(groupOf('1'), '1x2');
    assert.equal(cellKey({ market: 'O 0.5', price: 1.01 }), 'O0.5|1.02');
});

test('calibrator with no evidence returns the devig prob', () => {
    const cal = makeCalibrator();
    assert.equal(cal.prob({ market: 'U 5.5', price: 1.05, prob: 0.97 }), 0.97);
    assert.equal(cal.cell({ market: 'U 5.5', price: 1.05 }), null);
});

test('calibrator shrinks from devig toward realized rate', () => {
    const cal = makeCalibrator({ shrinkK: 10 });
    const leg = { market: 'O 0.5', price: 1.01, prob: 0.99 };
    for (let i = 0; i < 10; i++) cal.observe({ ...leg, outcome: 'miss' });
    // (0 hits + 10 * 0.99) / (10 + 10) = 0.495
    assert.ok(Math.abs(cal.prob(leg) - 0.495) < 1e-9);
    cal.observe({ ...leg, outcome: 'void' });                // ignored
    cal.observe({ ...leg, outcome: null });                  // ignored
    assert.equal(cal.cell(leg).n, 10);
    assert.equal(cal.cell(leg).hit, 0);
});

test('healing: recency decay discounts stale evidence, recent misses bite harder', () => {
    const stale = makeCalibrator({ shrinkK: 10, halfLifeDays: 7 });
    const leg = { market: 'U 5.5', price: 1.05, prob: 0.95 };
    // 10 hits three weeks ago, then 3 recent misses...
    for (let i = 0; i < 10; i++) stale.observe({ ...leg, outcome: 'hit', day: '2026-07-01' });
    for (let i = 0; i < 3; i++) stale.observe({ ...leg, outcome: 'miss', day: '2026-07-22' });
    // ...vs the same history with no decay: the decayed estimate must sit LOWER
    // (the old hits have faded to 1/8 weight, the misses are fresh).
    const flat = makeCalibrator({ shrinkK: 10 });
    for (let i = 0; i < 10; i++) flat.observe({ ...leg, outcome: 'hit' });
    for (let i = 0; i < 3; i++) flat.observe({ ...leg, outcome: 'miss' });
    assert.ok(stale.prob(leg) < flat.prob(leg));
    // Round-trip keeps the decay state.
    const twin = makeCalibrator(stale.export());
    assert.ok(Math.abs(twin.prob(leg) - stale.prob(leg)) < 1e-9);
});

test('stereotype: the league layer discounts a league that keeps missing', () => {
    const cal = makeCalibrator({ shrinkK: 5, leagueK: 5 });
    const good = { market: 'U 5.5', price: 1.05, prob: 0.95, league: 'EPL' };
    const bad = { market: 'U 5.5', price: 1.05, prob: 0.95, league: 'Friendlies' };
    for (let i = 0; i < 20; i++) cal.observe({ ...good, outcome: 'hit' });
    for (let i = 0; i < 10; i++) cal.observe({ ...bad, outcome: i < 4 ? 'hit' : 'miss' });
    assert.ok(cal.prob(bad) < cal.prob(good) - 0.1);        // the bad league wears its record
    // A league with NO history inherits the global cell estimate untouched.
    const fresh = { ...good, league: 'Bundesliga' };
    const noLeague = { market: 'U 5.5', price: 1.05, prob: 0.95 };
    assert.equal(cal.prob(fresh), cal.prob(noLeague));
});

test('calibrator export/rehydrate round-trips', () => {
    const cal = makeCalibrator({ shrinkK: 10 });
    const leg = { market: 'U 4.5', price: 1.18, prob: 0.84 };
    for (let i = 0; i < 7; i++) cal.observe({ ...leg, outcome: i < 6 ? 'hit' : 'miss' });
    const twin = makeCalibrator(cal.export());
    assert.equal(twin.prob(leg), cal.prob(leg));
    assert.deepEqual(twin.cell(leg), { n: 7, hit: 6 });
});
