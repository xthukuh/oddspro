import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_PICK, isPickMarket, isPick, fixturePick, selectTopPicks, picksDayScore,
    selectSlip, DEFAULT_SLIP,
} from '../src/db/pick-rules.js';
import { makeCalibrator } from '../src/db/leg-calibration.js';

const MENU = [
    { market: 'O 0.5', price: 1.03, prob: 0.95 },
    { market: '1X', price: 1.2, prob: 0.8 },
    { market: '1', price: 1.55, prob: 0.62 },
    { market: 'U 2.5', price: 1.65, prob: 0.58 },
    { market: 'DNB1', price: 1.5, prob: 0.64 },
    { market: 'X', price: 3.6, prob: 0.26 },
];

test('isPick: 1.50-2.20 band, never Draw No Bet', () => {
    assert.equal(isPickMarket('DNB1'), false);
    assert.equal(isPickMarket('1'), true);
    assert.equal(isPick('O 0.5', 1.03), false);
    assert.equal(isPick('1', 1.5), true);
    assert.equal(isPick('1', 2.2), true);
    assert.equal(isPick('1', 2.21), false);
    assert.equal(isPick('DNB2', 1.8), false);
    assert.equal(isPick(null, 1.8), false);
});

test('fixturePick without a calibrator: highest devig chance in band', () => {
    const p = fixturePick(MENU);
    assert.deepEqual(p, { market: '1', price: 1.55, prob: 0.62, calProb: 0.62 });
});

test('fixturePick never returns O 0.5 or another sub-1.50 filler', () => {
    assert.equal(fixturePick([{ market: 'O 0.5', price: 1.02, prob: 0.97 }]), null);
    assert.equal(fixturePick([]), null);
    assert.equal(fixturePick(null), null);
});

test('fixturePick follows OUR calibrated chance over the devig', () => {
    // Settled history where home wins at 1.35-1.60 kept failing and unders at
    // 1.60-2.20 kept landing: the calibrated choice flips to the under.
    const cal = makeCalibrator({ shrinkK: 10 });
    for (let i = 0; i < 40; i++) {
        cal.observe({ market: '1', price: 1.55, prob: 0.62, outcome: i < 16 ? 'hit' : 'miss' });
        cal.observe({ market: 'U 2.5', price: 1.65, prob: 0.58, outcome: i < 32 ? 'hit' : 'miss' });
    }
    const p = fixturePick(MENU, cal);
    assert.equal(p.market, 'U 2.5');
    assert.ok(p.calProb > 0.7, `calProb ${p.calProb}`);
    assert.equal(p.prob, 0.58);   // the devig rides along unchanged
});

test('fixturePick ties go to the shorter price', () => {
    const p = fixturePick([
        { market: 'U 3.5', price: 1.7, prob: 0.6 },
        { market: '2', price: 1.6, prob: 0.6 },
    ]);
    assert.equal(p.market, '2');
});

test('fixturePick skips legs without a usable probability', () => {
    const p = fixturePick([
        { market: '1', price: 1.6, prob: null },
        { market: '2', price: 1.9, prob: 0.5 },
    ]);
    assert.equal(p.market, '2');
});

test('selectTopPicks: top N by chance, shown in kickoff order, one per game', () => {
    const g = (id, kickoff, calProb) => ({ id, kickoff, pick: { market: '1', price: 1.6, prob: 0.6, calProb } });
    const games = [
        g(1, '2026-10-16T18:00:00Z', 0.61),
        g(2, '2026-10-16T12:00:00Z', 0.66),
        g(3, '2026-10-16T15:00:00Z', 0.64),
        g(4, '2026-10-16T09:00:00Z', 0.65),
        { id: 5, kickoff: '2026-10-16T08:00:00Z', pick: null },
        g(2, '2026-10-16T12:00:00Z', 0.66),
    ];
    const top = selectTopPicks(games);
    assert.deepEqual(top.map(x => x.id), [4, 2, 3]);
    assert.equal(selectTopPicks(games, { cardSize: 1 })[0].id, 2);
    assert.deepEqual(selectTopPicks([]), []);
});

test('picksDayScore: score first, verdict only once every pick settled', () => {
    assert.deepEqual(picksDayScore([
        { price: 1.5, outcome: 'hit' }, { price: 1.6, outcome: 'hit' }, { price: 1.7, outcome: 'miss' },
    ]), { won: 2, lost: 1, void: 0, pending: 0, units: 0.1, outcome: 'won' });
    assert.equal(picksDayScore([
        { price: 1.5, outcome: 'hit' }, { price: 1.6, outcome: 'miss' }, { price: 1.7, outcome: 'miss' },
    ]).outcome, 'lost');
    const pend = picksDayScore([{ price: 1.5, outcome: 'hit' }, { price: 1.6, outcome: null }]);
    assert.equal(pend.outcome, null);
    assert.equal(pend.pending, 1);
    assert.equal(picksDayScore([{ price: 1.5, outcome: 'void' }]).outcome, 'void');
    // 1 of 2 at 1.50: -0.5u, a losing day
    assert.equal(picksDayScore([{ price: 1.5, outcome: 'hit' }, { price: 1.5, outcome: 'miss' }]).outcome, 'lost');
});

test('DEFAULT_PICK is frozen at the owner directive values', () => {
    assert.equal(DEFAULT_PICK.minPrice, 1.5);
    assert.equal(DEFAULT_PICK.cardSize, 3);
    assert.throws(() => { DEFAULT_PICK.minPrice = 1.01; });
});

const leg = (fixture, market, price, calProb) => ({ fixture, market, price, calProb });

test('selectSlip: 2 legs, one per game, combined >= 2.5x, best product of chances', () => {
    const s = selectSlip([
        leg(1, '1', 1.5, 0.66), leg(1, 'U 3.5', 1.55, 0.65),   // same game: at most one leg
        leg(2, '2', 1.6, 0.63), leg(3, 'X2', 1.7, 0.61), leg(4, 'O 2.5', 2.1, 0.5),
    ]);
    assert.equal(s.legs.length, 2);
    assert.equal(new Set(s.legs.map(l => l.fixture)).size, 2);
    assert.ok(s.odds >= 2.5, `odds ${s.odds}`);
    // 1.5 x 1.6 = 2.40 and 1.55 x 1.6 = 2.48 miss the floor; the best
    // qualifying pair is 1 (0.66) x X2 (0.61) = 2.55x at 0.4026
    assert.deepEqual(s.legs.map(l => l.market).sort(), ['1', 'X2']);
    assert.equal(s.odds, 2.55);
    assert.equal(s.chance, 0.4026);
});

test('selectSlip never takes a sub-1.50, DNB or over-2.20 leg, and is null when 2.5x is unreachable', () => {
    assert.equal(selectSlip([leg(1, 'O 0.5', 1.03, 0.95), leg(2, 'O 0.5', 1.04, 0.94)]), null);
    assert.equal(selectSlip([leg(1, 'DNB1', 1.8, 0.6), leg(2, 'DNB2', 1.9, 0.6)]), null);
    assert.equal(selectSlip([leg(1, '1', 1.5, 0.66), leg(2, '1', 1.5, 0.66)]), null);   // 2.25x < 2.5x
    assert.equal(selectSlip([leg(1, 'X', 3.4, 0.3), leg(2, 'X', 3.2, 0.3)]), null);
    assert.equal(selectSlip([]), null);
    assert.equal(DEFAULT_SLIP.minOdds, 2.5);
    assert.equal(DEFAULT_SLIP.legs, 2);
});
