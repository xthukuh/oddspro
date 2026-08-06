import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_LADDER, satisfyingSet, marketRelation, contradicts, implies,
    MARKET_FAMILY, LADDER_RUNGS, familyOf, marketMenu, bankerPick, safestRung,
    rungGap, coherentAlternatives, candidateSetIncoherent,
    reachesUpTheLadder, ladderPick,
} from '../src/db/ladder-rules.js';
import { tipOutcome } from '../src/db/tip-rules.js';

// --- the lattice ------------------------------------------------------------

test('marketRelation: mutually exclusive markets are contradictory', () => {
    assert.equal(marketRelation('O 2.5', 'U 2.5'), 'contradictory');
    assert.equal(marketRelation('O 3.5', 'U 3.5'), 'contradictory');
    assert.equal(marketRelation('1', 'X2'), 'contradictory');
    assert.equal(marketRelation('2', '1X'), 'contradictory');
    assert.equal(marketRelation('X', '12'), 'contradictory');
    assert.equal(marketRelation('GG', 'NG'), 'contradictory');
    assert.equal(marketRelation('ODD', 'EVEN'), 'contradictory');
    assert.equal(marketRelation('1', '2'), 'contradictory');
});

test('marketRelation: rungs of one ladder are nested, not alternatives', () => {
    assert.equal(marketRelation('O 1.5', 'O 2.5'), 'nested');
    assert.equal(marketRelation('O 2.5', 'O 1.5'), 'nested');   // symmetric
    assert.equal(marketRelation('U 4.5', 'U 3.5'), 'nested');
    assert.equal(marketRelation('12', '1'), 'nested');
    assert.equal(marketRelation('DNB1', '1X'), 'nested');
    assert.equal(marketRelation('GG', 'O 1.5'), 'nested');
});

test('marketRelation: genuinely different bets overlap', () => {
    assert.equal(marketRelation('O 2.5', '1X'), 'overlapping');
    assert.equal(marketRelation('1X', 'X2'), 'overlapping');
    assert.equal(marketRelation('GG', '1'), 'overlapping');
});

test('marketRelation: identical and unknown are distinguished, never thrown', () => {
    assert.equal(marketRelation('O 2.5', 'O 2.5'), 'identical');
    assert.equal(marketRelation('bogus', 'O 1.5'), 'unknown');
    assert.equal(marketRelation('O 1.5', null), 'unknown');
    // Total by contract: persisted tip_market values come from older code
    // versions, i.e. external data.
    assert.doesNotThrow(() => marketRelation('TT:Z:O 9.5', '???'));
});

test('implies is directional: the harder rung implies the easier one', () => {
    assert.equal(implies('O 2.5', 'O 1.5'), true);
    assert.equal(implies('O 1.5', 'O 2.5'), false);
    assert.equal(implies('1', '1X'), true);
    assert.equal(implies('1X', '1'), false);
    assert.equal(implies('bogus', 'O 1.5'), false);
});

test('the lattice is derived from tipOutcome, so it cannot drift from settlement', () => {
    // Spot-check the satisfying sets against the settle function directly.
    for (const market of ['O 2.5', 'U 4.5', '1X', 'GG', 'TT:H:O 1.5', 'ODD']) {
        const set = satisfyingSet(market);
        for (const [h, a] of [[0, 0], [1, 0], [2, 1], [3, 3], [0, 4], [5, 2]]) {
            assert.equal(set.has(`${h}-${a}`), tipOutcome(market, h, a) === 'hit',
                `${market} @ ${h}-${a}`);
        }
    }
});

test('contradicts is the boolean face of the relation', () => {
    assert.equal(contradicts('O 2.5', 'U 2.5'), true);
    assert.equal(contradicts('O 2.5', 'O 1.5'), false);
    assert.equal(contradicts('bogus', 'O 1.5'), false);   // unknown is not a contradiction
});

// --- families ---------------------------------------------------------------

test('every laddered rung is registered in exactly its own family', () => {
    for (const [family, rungs] of Object.entries(LADDER_RUNGS)) {
        for (const rung of rungs) {
            assert.equal(MARKET_FAMILY[rung], family, `${rung} -> ${family}`);
        }
    }
});

test('rung orders run safest-first within a family', () => {
    // A safer rung must be IMPLIED BY the ones after it (easier to win).
    for (const rungs of Object.values(LADDER_RUNGS)) {
        for (let i = 0; i < rungs.length - 1; i++) {
            assert.equal(implies(rungs[i + 1], rungs[i]), true,
                `${rungs[i + 1]} should imply ${rungs[i]}`);
        }
    }
});

test('familyOf tolerates unknown keys', () => {
    assert.equal(familyOf('O 2.5'), 'over');
    assert.equal(familyOf('TT:A:U 2.5'), 'tt_a_under');
    assert.equal(familyOf('nonsense'), null);
    assert.equal(familyOf(undefined), null);
});

// --- the menu ---------------------------------------------------------------

const BOOKS = {
    x12: { 1: 2.0, X: 3.5, 2: 4.0 },
    dc: { '1X': 1.28, X2: 1.85, 12: 1.33 },
    ou: { 0.5: { over: 1.04, under: 9.0 }, 1.5: { over: 1.25, under: 3.8 }, 2.5: { over: 1.8, under: 2.0 } },
    btts: { GG: 1.7, NG: 2.1 },
    dnb: { DNB1: 1.5, DNB2: 2.5 },
    oddEven: { ODD: 1.9, EVEN: 1.9 },
    tt: { H: { 1.5: { over: 2.2, under: 1.6 } }, A: {} },
};

test('marketMenu flattens every offered market with a devigged probability', () => {
    const menu = marketMenu(BOOKS);
    assert.equal(menu['O 0.5'].price, 1.04);
    assert.equal(menu['1X'].price, 1.28);
    assert.ok(menu['TT:H:U 1.5']);
    // devigged, so the two sides of a pair sum to 1 - NOT the raw implied
    // probabilities, which would sum above 1 by the margin.
    assert.ok(Math.abs(menu['O 2.5'].prob + menu['U 2.5'].prob - 1) < 1e-6);
    assert.ok(Math.abs(menu.GG.prob + menu.NG.prob - 1) < 1e-6);
    // and the devigged number is strictly below the raw implied one
    assert.ok(menu['O 2.5'].prob < 1 / menu['O 2.5'].price);
});

test('marketMenu falls back to raw implied probability with no full group', () => {
    const menu = marketMenu({ ou: { 2.5: { over: 2.0, under: null } } });
    assert.equal(menu['O 2.5'].prob, 0.5);      // 1/2.0, no pair to devig against
    assert.equal(menu['U 2.5'], undefined);
});

test('marketMenu ignores degenerate prices and is total on empty input', () => {
    assert.deepEqual(marketMenu({}), {});
    assert.deepEqual(marketMenu(null), {});
    assert.deepEqual(marketMenu({ ou: { 2.5: { over: 1.0, under: 0 } } }), {});
});

// --- the banker -------------------------------------------------------------

test('bankerPick returns the safest market on the board', () => {
    const menu = marketMenu(BOOKS);
    const b = bankerPick(menu);
    assert.equal(b.market, 'O 0.5');
    assert.equal(b.price, 1.04);
    // devigged against its 9.0 partner, so ~0.896 - NOT the 0.962 raw implied
    assert.ok(b.prob > 0.85 && b.prob < 1 / b.price);
});

test('bankerPick honours its own floor, not the tip price floor', () => {
    const menu = marketMenu(BOOKS);
    assert.equal(DEFAULT_LADDER.bankerFloor, 1.01);
    assert.equal(bankerPick(menu).market, 'O 0.5');                       // 1.04
    assert.equal(bankerPick(menu, { bankerFloor: 1.2 }).market, 'O 1.5');  // 1.25
    assert.equal(bankerPick(menu, { bankerFloor: 1.3 }).market, 'DNB1');   // 1.50 (12@1.33 excluded)
    assert.equal(bankerPick(menu, { bankerFloor: 99 }), null);
});

test('bankerPick never returns a suppressed market', () => {
    const menu = marketMenu(BOOKS);
    assert.deepEqual(DEFAULT_LADDER.exclude, ['12', 'U 3.5']);
    // 12 @1.33 is the cheapest thing above a 1.3 floor, and is skipped
    assert.equal(bankerPick(menu, { bankerFloor: 1.3, exclude: [] }).market, '12');
    assert.equal(bankerPick(menu, { bankerFloor: 1.3 }).market, 'DNB1');
});

test('bankerPick is total on an empty menu', () => {
    assert.equal(bankerPick({}), null);
    assert.equal(bankerPick(null), null);
});

// --- the ladder -------------------------------------------------------------

test('safestRung keeps the directional call and takes less risk', () => {
    const menu = marketMenu(BOOKS);
    assert.equal(safestRung(menu, 'O 2.5').market, 'O 0.5');
    assert.equal(safestRung(menu, 'O 1.5').market, 'O 0.5');
    assert.equal(safestRung(menu, '1').market, '1X');
    assert.equal(safestRung(menu, 'DNB1').market, '1X');
});

test('safestRung never crosses into another family', () => {
    const menu = marketMenu(BOOKS);
    // U 2.5 is an under; the cheapest thing on the board is O 0.5 (an over)
    const rung = safestRung(menu, 'U 2.5');
    assert.equal(familyOf(rung.market), 'under');
    assert.notEqual(rung.market, 'O 0.5');
});

test('safestRung falls back to the market itself when nothing safer is offered', () => {
    const menu = marketMenu({ ou: { 2.5: { over: 1.8, under: 2.0 } } });
    assert.equal(safestRung(menu, 'O 2.5').market, 'O 2.5');
});

test('safestRung is null for an unfamilied market', () => {
    assert.equal(safestRung(marketMenu(BOOKS), 'nonsense'), null);
});

test('rungGap measures how much riskier the tip is than the safest bet', () => {
    const menu = marketMenu(BOOKS);
    assert.equal(rungGap(1.8, menu), 0.76);          // 1.80 tip vs 1.04 banker
    assert.equal(rungGap(1.8, {}), null);            // no banker to compare against
    // Number(null) === 0 and Number('') === 0, so these must be rejected
    // explicitly or a tipless row reports a confident negative gap.
    assert.equal(rungGap(null, menu), null);
    assert.equal(rungGap(undefined, menu), null);
    assert.equal(rungGap('', menu), null);
    assert.equal(rungGap('nope', menu), null);
});

// --- coherence --------------------------------------------------------------

test('coherentAlternatives drops candidates that contradict the tip', () => {
    const out = coherentAlternatives('O 2.5', [
        { market: 'U 2.5' },   // contradictory - cannot both win
        { market: '1X' },
        { market: 'GG' },
    ]);
    assert.deepEqual(out.map(c => c.market), ['1X', 'GG']);
});

test('coherentAlternatives drops nested rungs - that is the banker\'s job', () => {
    const out = coherentAlternatives('O 2.5', [
        { market: 'O 1.5' },   // nested: same call, easier rung
        { market: 'O 3.5' },   // nested: same call, harder rung
        { market: 'X2' },
    ]);
    assert.deepEqual(out.map(c => c.market), ['X2']);
});

test('coherentAlternatives keeps the surviving alternatives mutually coherent', () => {
    const out = coherentAlternatives('O 2.5', [
        { market: '1X' },
        { market: '2' },       // contradicts 1X, already kept
        { market: 'GG' },
    ]);
    assert.deepEqual(out.map(c => c.market), ['1X', 'GG']);
});

test('coherentAlternatives respects the limit and preserves rank order', () => {
    const out = coherentAlternatives('O 2.5', [{ market: '1X' }, { market: 'GG' }, { market: 'ODD' }], 2);
    assert.deepEqual(out.map(c => c.market), ['1X', 'GG']);
    assert.deepEqual(coherentAlternatives('O 2.5', [], 2), []);
    assert.deepEqual(coherentAlternatives('O 2.5', null, 2), []);
});

test('coherentAlternatives keeps unknown keys rather than silently eating them', () => {
    // 'unknown' is not a contradiction - a future/legacy market must still show
    const out = coherentAlternatives('O 2.5', [{ market: 'FUTURE:THING' }]);
    assert.deepEqual(out.map(c => c.market), ['FUTURE:THING']);
});

test('candidateSetIncoherent detects a self-contradicting candidate set', () => {
    assert.equal(candidateSetIncoherent(['O 2.5', '1X', 'U 2.5']), true);
    assert.equal(candidateSetIncoherent(['O 2.5', '1X', 'GG']), false);
    assert.equal(candidateSetIncoherent(['O 2.5']), false);
    assert.equal(candidateSetIncoherent([]), false);
    assert.equal(candidateSetIncoherent(null), false);
});

// --- the goal-rich ladder signal (2026-07-26) --------------------------------

test('reachesUpTheLadder reads the whole candidate set, not just the pick', () => {
    assert.equal(reachesUpTheLadder(['1X', 'O 2.5', 'X2']), true);
    assert.equal(reachesUpTheLadder(['U 4.5', 'O 3.5']), true);
    assert.equal(reachesUpTheLadder(['O 2.5']), true);
    // O 1.5 is the rung we BET, not a rung that fires the signal
    assert.equal(reachesUpTheLadder(['1X', 'O 1.5']), false);
    assert.equal(reachesUpTheLadder(['1X', 'X2', 'U 3.5']), false);
});

test('reachesUpTheLadder is total and its threshold is configurable', () => {
    assert.equal(reachesUpTheLadder([]), false);
    assert.equal(reachesUpTheLadder(null), false);
    assert.equal(reachesUpTheLadder([null, undefined, 'garbage']), false);
    assert.equal(reachesUpTheLadder(['O 1.5'], 1.5), true);   // lower the bar
    assert.equal(reachesUpTheLadder(['O 2.5'], 3.5), false);  // raise it
});

test('ladderPick returns the bottom rung the set implied but did not take', () => {
    const menu = marketMenu(BOOKS);   // carries O 0.5 / O 1.5 / O 2.5
    const pick = ladderPick(menu, ['1X', 'O 2.5', 'X2']);
    assert.equal(pick.market, 'O 1.5');
    assert.equal(pick.price, menu['O 1.5'].price);
    assert.equal(pick.prob, menu['O 1.5'].prob);
});

test('ladderPick stays silent when the signal does not fire', () => {
    const menu = marketMenu(BOOKS);
    assert.equal(ladderPick(menu, ['1X', 'X2', 'U 4.5']), null);
    assert.equal(ladderPick(menu, []), null);
    assert.equal(ladderPick(menu, null), null);
});

test('ladderPick needs the rung to be offered above the floor', () => {
    assert.equal(ladderPick({}, ['O 2.5']), null);
    assert.equal(ladderPick({ 'O 1.5': { price: 1.0, prob: 1 } }, ['O 2.5']), null);
    assert.equal(ladderPick({ 'O 1.5': { price: 1.02, prob: 0.97 } }, ['O 2.5']).price, 1.02);
});

test('the ladder rung and threshold are configurable', () => {
    const menu = marketMenu(BOOKS);
    assert.equal(DEFAULT_LADDER.ladderMinLine, 2.5);
    assert.equal(DEFAULT_LADDER.ladderRung, 'O 1.5');
    // bet the very bottom rung instead
    assert.equal(ladderPick(menu, ['O 2.5'], { ladderRung: 'O 0.5' }).market, 'O 0.5');
    // demand the set reach further up before firing
    assert.equal(ladderPick(menu, ['O 2.5'], { ladderMinLine: 3.5 }), null);
});
