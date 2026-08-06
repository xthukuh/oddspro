import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCalibrator } from '../src/db/leg-calibration.js';
import {
    DEFAULT_DAILY_SLIP, DEFAULT_VALUE_CARDS, selectDailyLegs, constructSlip,
    valueCards, dayMood, slipOutcomeRollup, slipStreaks,
} from '../src/db/daily-slip-rules.js';

const fx = (id, league, legs) => ({ id, league, menuLegs: legs });
const leg = (market, price, prob) => ({ market, price, prob });

test('gates: floor, price window, one leg per fixture, league cap', () => {
    const cal = makeCalibrator({ shrinkK: 1 });
    const opts = { ...DEFAULT_DAILY_SLIP, probFloor: 0.9, maxPerLeague: 2 };
    const fixtures = [
        fx(1, 'EPL', [leg('U 5.5', 1.05, 0.95), leg('1X', 1.30, 0.85)]),   // best leg passes
        fx(2, 'EPL', [leg('U 5.5', 1.06, 0.94)]),
        fx(3, 'EPL', [leg('U 5.5', 1.07, 0.93)]),                          // league cap drops this
        fx(4, 'Liga', [leg('O 2.5', 1.50, 0.92)]),                         // price window drops this
        fx(5, 'Liga', [leg('X2', 1.20, 0.80)]),                            // floor drops this
    ];
    const picked = selectDailyLegs(fixtures, cal, opts);
    assert.deepEqual(picked.map(l => l.id), [1, 2]);
    assert.ok(picked[0].calProb >= picked[1].calProb);                     // ranked desc
});

test('gate: minCellN excludes markets without settled evidence', () => {
    const cal = makeCalibrator({ shrinkK: 1 });
    const seen = { market: 'U 5.5', price: 1.05, prob: 0.95 };
    for (let i = 0; i < 5; i++) cal.observe({ ...seen, outcome: 'hit' });
    const fixtures = [
        fx(1, 'EPL', [seen]),                                  // cell has n=5
        fx(2, 'EPL', [leg('GG', 1.30, 0.94)]),                 // cell unseen, n=0
    ];
    const opts = { ...DEFAULT_DAILY_SLIP, probFloor: 0.9, minCellN: 5 };
    assert.deepEqual(selectDailyLegs(fixtures, cal, opts).map(l => l.id), [1]);
});

test('selection uses the CALIBRATED prob, not the devig prob', () => {
    const cal = makeCalibrator({ shrinkK: 1 });
    const trap = { market: 'O 0.5', price: 1.01, prob: 0.99 };
    for (let i = 0; i < 20; i++) cal.observe({ ...trap, outcome: i < 10 ? 'hit' : 'miss' });
    const fixtures = [fx(1, 'EPL', [trap, leg('U 5.5', 1.10, 0.92)])];
    const picked = selectDailyLegs(fixtures, cal, { ...DEFAULT_DAILY_SLIP, probFloor: 0.9 });
    // The trap's calibrated prob collapsed to ~0.52: the honest U 5.5 leg wins the fixture.
    assert.equal(picked[0].market, 'U 5.5');
});

test('streak ranking prefers unbroken-record cells over higher calProb', () => {
    const cal = makeCalibrator({ shrinkK: 10 });
    const unbroken = { market: 'U 5.5', price: 1.10, prob: 0.90 };   // 5/5, thin but perfect
    for (let i = 0; i < 5; i++) cal.observe({ ...unbroken, outcome: 'hit' });
    const broken = { market: '1X', price: 1.05, prob: 0.96 };        // 59/60, deep but broken
    for (let i = 0; i < 60; i++) cal.observe({ ...broken, outcome: i === 0 ? 'miss' : 'hit' });
    const fixtures = [fx(1, 'A', [unbroken]), fx(2, 'B', [broken])];
    const streak = selectDailyLegs(fixtures, cal, { ...DEFAULT_DAILY_SLIP, probFloor: 0.5, rankBy: 'streak' });
    assert.deepEqual(streak.map(l => l.id), [1, 2]);                 // unbroken first
    const byProb = selectDailyLegs(fixtures, cal, { ...DEFAULT_DAILY_SLIP, probFloor: 0.5, rankBy: 'prob' });
    assert.deepEqual(byProb.map(l => l.id), [2, 1]);                 // prob mode: the deep cell wins
});

test('construction: uncapped combined odds, min-legs floor, no-slip day', () => {
    const legs = [
        { id: 1, market: 'U 5.5', price: 1.30, calProb: 0.95 },
        { id: 2, market: 'U 5.5', price: 1.30, calProb: 0.95 },
        { id: 3, market: 'U 5.5', price: 1.30, calProb: 0.95 },
    ];
    const slip = constructSlip(legs, DEFAULT_DAILY_SLIP);
    assert.ok(Math.abs(slip.combinedOdds - 1.3 ** 3) < 1e-9);              // odds are never capped
    assert.equal(slip.legs.length, 3);
    assert.ok(['green', 'amber', 'red'].includes(slip.mood));
    assert.equal(constructSlip(legs.slice(0, 1), DEFAULT_DAILY_SLIP), null); // < minLegs
});

test('construction: maxLegs caps depth at the top of the ranking, pool drives mood', () => {
    const mk = n => Array.from({ length: n }, (_, i) => ({ id: i, market: 'U 5.5', price: 1.05, calProb: 0.98 - i * 0.0005 }));
    const legs = mk(20);
    const slip = constructSlip(legs, { ...DEFAULT_DAILY_SLIP, maxLegs: 5 });
    assert.equal(slip.legs.length, 5);
    assert.deepEqual(slip.legs.map(l => l.id), [0, 1, 2, 3, 4]);           // top of the ranking
    assert.equal(slip.pool, 20);
    assert.equal(slip.mood, 'green');                                      // deep quality pool
    const uncapped = constructSlip(legs, { ...DEFAULT_DAILY_SLIP, maxLegs: 0 });
    assert.equal(uncapped.legs.length, 20);                                // 0 = uncapped (sim harness)
});

test('mood thresholds (baked 2026-08-06 terciles)', () => {
    const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ id: i, calProb: p }));
    assert.equal(dayMood(mk(22, 0.975), DEFAULT_DAILY_SLIP), 'green');
    assert.equal(dayMood(mk(12, 0.966), DEFAULT_DAILY_SLIP), 'amber');
    assert.equal(dayMood(mk(5, 0.98), DEFAULT_DAILY_SLIP), 'red');         // quality without depth
    assert.equal(dayMood(mk(25, 0.91), DEFAULT_DAILY_SLIP), 'amber');      // depth without quality
});

test('valueCards: greedy target-close = fewest legs, remainder discarded, tagged', () => {
    const leg = (id, price) => ({ id, league: `L${id}`, market: 'X2', price, calProb: 0.85 });
    // 1.25 x 1.22 = 1.525 closes card 1 at TWO legs; 1.15 x 1.1 x 1.05 = 1.33
    // never reaches 1.5 inside 3 legs -> that remainder is DISCARDED, never bet.
    const pool = [leg(1, 1.25), leg(2, 1.22), leg(3, 1.15), leg(4, 1.1), leg(5, 1.05)];
    const cards = valueCards(pool, { ...DEFAULT_VALUE_CARDS, maxLegsPerCard: 3 }, 2);
    assert.equal(cards.length, 1);
    assert.deepEqual(cards[0].map(l => l.id), [1, 2]);
    assert.ok(cards[0].every(l => l.kind === 'value' && l.card === 2));   // indices continue after safe cards
    // A deeper pool closes the second card too.
    const pool2 = [...pool, leg(6, 1.3), leg(7, 1.3)];
    const cards2 = valueCards(pool2, { ...DEFAULT_VALUE_CARDS, maxLegsPerCard: 3 }, 0);
    assert.equal(cards2.length, 2);
});

test('rollup: miss settles early, voids survive without hitting', () => {
    assert.deepEqual(slipOutcomeRollup(['hit', 'miss', null]), { outcome: 'lost', legsHit: 1 });
    assert.deepEqual(slipOutcomeRollup(['hit', null]), { outcome: null, legsHit: 1 });
    assert.deepEqual(slipOutcomeRollup(['hit', 'void']), { outcome: 'won', legsHit: 1 });
    assert.deepEqual(slipOutcomeRollup(['void', 'void']), { outcome: 'void', legsHit: 0 });
    assert.deepEqual(slipOutcomeRollup(['hit', 'hit']), { outcome: 'won', legsHit: 2 });
});

test('streaks skip no-slip days and count green runs', () => {
    const s = (status, outcome) => ({ status, outcome });
    const r = slipStreaks([s('published', 'won'), s('no_slip', null), s('published', 'won'),
        s('published', 'lost'), s('published', 'won')]);
    assert.deepEqual(r, { current: 1, best: 2, greenRate: 3 / 4, played: 4 });
});

test('streaks: pending days do not break a run, void days are not green', () => {
    const s = (status, outcome) => ({ status, outcome });
    const r = slipStreaks([s('published', 'won'), s('published', null), s('published', 'void')]);
    // one settled winnable day played and won; void day played but neither green nor broken
    assert.equal(r.best, 1);
    assert.equal(r.played, 2);         // pending day not yet counted as played
});
