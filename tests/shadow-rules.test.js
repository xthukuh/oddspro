import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sotVolume, shadowLegs, SHADOW_RULES, SHADOW_DEFAULTS } from '../src/db/shadow-rules.js';

const games = (...totals) => totals.map(total => ({ total }));

test('sotVolume averages each team over its last 8 games, then the two teams', () => {
    const v = sotVolume(games(12, 10, 8), games(9, 11, 10, 14));
    assert.equal(v.V, 10.5);   // (10 + 11) / 2
    assert.equal(v.nh, 3);
    assert.equal(v.na, 4);
    // only the newest 8 count
    const nine = games(10, 10, 10, 10, 10, 10, 10, 10, 100);
    assert.equal(sotVolume(nine, nine).V, 10);
});

test('sotVolume gives no signal unless BOTH teams have >= 3 stat games (no league-average stand-in)', () => {
    assert.equal(sotVolume(games(20, 20), games(20, 20, 20)), null);
    assert.equal(sotVolume([], games(20, 20, 20)), null);
    assert.equal(sotVolume(null, null), null);
    assert.equal(sotVolume(games(10, NaN, 12), games(10, 10, 10)), null);   // NaN dropped -> 2 games
});

test('shadowLegs fires GG at V >= 10.25 and O 2.5 at V >= 10.13, only at 1.50+', () => {
    const menu = [{ market: 'GG', price: 1.62, prob: 0.58 }, { market: 'O 2.5', price: 1.55, prob: 0.6 }];
    const vol = v => ({ V: v, nh: 5, na: 6 });
    assert.deepEqual(shadowLegs(vol(10.2), menu).map(l => l.rule), ['sot-o25']);
    assert.deepEqual(shadowLegs(vol(10.25), menu).map(l => l.rule), ['sot-gg', 'sot-o25']);
    assert.deepEqual(shadowLegs(vol(10.0), menu), []);
    assert.deepEqual(shadowLegs(vol(12), [{ market: 'GG', price: 1.45 }]), []);   // below 1.50
    assert.deepEqual(shadowLegs(null, menu), []);
    const l = shadowLegs(vol(11), menu)[0];
    assert.deepEqual(l, { rule: 'sot-gg', market: 'GG', price: 1.62, prob: 0.58, V: 11, nh: 5, na: 6 });
});

test('shadow rule constants are frozen at the measured values', () => {
    assert.deepEqual(SHADOW_RULES.map(r => [r.market, r.minV]), [['GG', 10.25], ['O 2.5', 10.13]]);
    assert.equal(SHADOW_DEFAULTS.lastN, 8);
    assert.equal(SHADOW_DEFAULTS.minGames, 3);
    assert.throws(() => { SHADOW_RULES[0].minV = 1; });
});
