import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSharpCalibrator, selectSharpCard, sharpLegsFromRows, SHARP_DEFAULTS } from '../src/db/sharp-rules.js';

const leg = (market, price, q) => ({ market, price, q });

test('calibrator: no evidence returns BetPawa q; a cell that out-hits q lifts it, shrunk by k', () => {
    const cal = makeSharpCalibrator({ shrinkK: 100 });
    assert.equal(cal.prob(leg('1', 1.6, 0.6)), 0.6);
    for (let i = 0; i < 100; i++) cal.observe({ ...leg('1', 1.6, 0.6), outcome: 'hit' });
    // 100 hits at q 0.6: residual sum 40, lift 40 / (100 + 100) = 0.2
    assert.ok(Math.abs(cal.prob(leg('2', 1.55, 0.6)) - 0.8) < 1e-9);   // same group 1x2, same band 1.60
    assert.equal(cal.prob(leg('1', 2.1, 0.45)), 0.45);                 // other band untouched
});

test('calibrator ignores voids, missing q and DNB', () => {
    const cal = makeSharpCalibrator();
    cal.observe({ ...leg('DNB1', 1.6, 0.4), outcome: 'hit' });
    cal.observe({ ...leg('1', 1.6, null), outcome: 'hit' });
    cal.observe({ ...leg('1', 1.6, 0.6), outcome: 'void' });
    assert.equal(cal.cell(leg('1', 1.6, 0.6)), null);
});

test('selector: exactly 3 legs from 3 fixtures, slip odds >= 4, no DNB, prices in band', () => {
    const cal = makeSharpCalibrator();
    const fixtures = [1, 2, 3, 4, 5].map(id => ({
        id,
        legs: [leg('1', 1.6, 0.6), leg('DNB1', 1.7, 0.5), leg('O 0.5', 1.05, 0.93), leg('X', 3.4, 0.27), leg('1X', 1.3, 0.74)],
    }));
    const card = selectSharpCard(fixtures, cal);
    assert.equal(card.legs.length, SHARP_DEFAULTS.legs);
    assert.equal(new Set(card.legs.map(l => l.fixture)).size, 3);
    assert.ok(card.slipOdds >= 4);
    for (const l of card.legs) {
        assert.ok(!/^DNB/.test(l.market));
        assert.ok(l.price >= SHARP_DEFAULTS.minPrice && l.price <= SHARP_DEFAULTS.maxPrice);
    }
    assert.ok(card.totalOdds >= card.slipOdds);   // Win Bonus never shrinks a payout
});

test('selector: a pool flooded with short legs still publishes (zero-publish trap)', () => {
    const cal = makeSharpCalibrator();
    const fixtures = [];
    for (let id = 1; id <= 200; id++) fixtures.push({ id, legs: [leg('1X', 1.3, 0.75)] });
    for (let id = 201; id <= 204; id++) fixtures.push({ id, legs: [leg('1', 1.62, 0.6)] });
    const card = selectSharpCard(fixtures, cal);
    assert.ok(card, 'card published');
    assert.ok(card.slipOdds >= 4);
});

test('selector returns null when 4x is unreachable with 3 legs', () => {
    const cal = makeSharpCalibrator();
    const fixtures = [1, 2, 3].map(id => ({ id, legs: [leg('1X', 1.3, 0.75)] }));
    assert.equal(selectSharpCard(fixtures, cal), null);
});

test('sharpLegsFromRows: betpawa rows with probability, lowest price per key, DNB dropped', () => {
    const rows = [
        { provider: 'betpawa', type_name: '1X2 | Full Time', name: '1', handicap: null, price: '1.65', probability: '0.580' },
        { provider: 'betpawa', type_name: '1X2 | Full Time', name: '1', handicap: null, price: '1.60', probability: '0.590' },
        { provider: 'betika', type_name: '1X2', name: '1', handicap: null, price: '1.70', probability: null },
        { provider: 'betpawa', type_name: 'Draw No Bet | Full Time', name: '1', handicap: null, price: '1.30', probability: '0.5' },
        { provider: 'betpawa', type_name: '1X2 | Full Time', name: 'X', handicap: null, price: '3.80', probability: null },
    ];
    const legs = sharpLegsFromRows(rows, 'Home FC', 'Away FC');
    assert.deepEqual(legs, [{ market: '1', price: 1.6, q: 0.59 }]);
});
