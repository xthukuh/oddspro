import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseTipFilter, tipCandidateMarket, tipCandidateOutcome, evalCondition,
} from '../web/src/filterExpr.js';

// R26b — tip-column filter value prefix. Grammar `[H|M]?\d?:value`:
//   \d  = candidate index (1 = chosen/default, 2/3 = runners-up from
//         tip_breakdown.runners_up); bare value = 1st.
//   H|M = settled-outcome filter (H = hit, M = miss; none = all outcomes),
//         graded from the final score via tipHit on the Nth candidate market.

// score 2-1 (home 2, away 1, total 3):
//   chosen  'O 2.5' → total 3 > 2.5   → HIT
//   up[0]   '2'     → away win (1 < 2) → MISS
//   up[1]   'U 2.5' → total 3 < 2.5    → MISS
const tipRow = (over = {}) => ({
    api_id: 1,
    score: '2-1',
    tip_market: 'O 2.5',
    tip_confidence: 0.8,
    tip_outcome: 'hit',
    tip_breakdown: {
        runners_up: [
            { market: '2', confidence: 0.7 },
            { market: 'U 2.5', confidence: 0.6 },
        ],
    },
    ...over,
});

const COLS = [{ key: 'tip', group: 'base' }];

// --- parseTipFilter -----------------------------------------------------
test('parseTipFilter: a bare value is the 1st candidate with no outcome gate', () => {
    assert.deepEqual(parseTipFilter('O 2.5'), { index: 1, outcome: null, value: 'O 2.5' });
    assert.deepEqual(parseTipFilter('1X'), { index: 1, outcome: null, value: '1X' });
    assert.deepEqual(parseTipFilter(''), { index: 1, outcome: null, value: '' });
});

test('parseTipFilter: a numeric index prefix selects the Nth candidate', () => {
    assert.deepEqual(parseTipFilter('1:O 2.5'), { index: 1, outcome: null, value: 'O 2.5' });
    assert.deepEqual(parseTipFilter('2:1X'), { index: 2, outcome: null, value: '1X' });
    assert.deepEqual(parseTipFilter('3:U 3.5'), { index: 3, outcome: null, value: 'U 3.5' });
});

test('parseTipFilter: an H/M prefix is a settled-outcome filter (case-insensitive)', () => {
    assert.deepEqual(parseTipFilter('H:O 2.5'), { index: 1, outcome: 'hit', value: 'O 2.5' });
    assert.deepEqual(parseTipFilter('M2:1'), { index: 2, outcome: 'miss', value: '1' });
    assert.deepEqual(parseTipFilter('h1:O 2.5'), { index: 1, outcome: 'hit', value: 'O 2.5' });
    assert.deepEqual(parseTipFilter('m:X'), { index: 1, outcome: 'miss', value: 'X' });
});

test('parseTipFilter: values without a leading prefix are never mis-parsed', () => {
    // CSV list value (leading quote), plain markets, no colon → untouched
    assert.deepEqual(parseTipFilter('"O 2.5","U 3.5"'), { index: 1, outcome: null, value: '"O 2.5","U 3.5"' });
    assert.deepEqual(parseTipFilter('X2'), { index: 1, outcome: null, value: 'X2' });
    // an out-of-order prefix (digit before H/M) is not a prefix
    assert.deepEqual(parseTipFilter('2H:x'), { index: 1, outcome: null, value: '2H:x' });
});

test('parseTipFilter: an empty value after a prefix (has-candidate / outcome-only)', () => {
    assert.deepEqual(parseTipFilter('2:'), { index: 2, outcome: null, value: '' });
    assert.deepEqual(parseTipFilter('H:'), { index: 1, outcome: 'hit', value: '' });
    assert.deepEqual(parseTipFilter('M2:'), { index: 2, outcome: 'miss', value: '' });
});

// --- tipCandidateMarket -------------------------------------------------
test('tipCandidateMarket: index 1 is the chosen tip, 2/3 are the runners-up', () => {
    const r = tipRow();
    assert.equal(tipCandidateMarket(r, 1), 'O 2.5');
    assert.equal(tipCandidateMarket(r, 2), '2');
    assert.equal(tipCandidateMarket(r, 3), 'U 2.5');
    assert.equal(tipCandidateMarket(r, 4), null);                       // out of range
    assert.equal(tipCandidateMarket({}, 1), null);                       // no tip at all
    assert.equal(tipCandidateMarket({ tip_market: 'O 2.5' }, 2), null);  // no runners_up
});

// --- tipCandidateOutcome ------------------------------------------------
test('tipCandidateOutcome: grades each candidate from the final score via tipHit', () => {
    const r = tipRow(); // 2-1
    assert.equal(tipCandidateOutcome(r, 1), 'hit');
    assert.equal(tipCandidateOutcome(r, 2), 'miss');
    assert.equal(tipCandidateOutcome(r, 3), 'miss');
});

test('tipCandidateOutcome: pending (no final score) or absent candidate → null', () => {
    assert.equal(tipCandidateOutcome(tipRow({ score: null }), 1), null);
    assert.equal(tipCandidateOutcome(tipRow({ score: 'bad' }), 1), null);
    assert.equal(tipCandidateOutcome(tipRow(), 4), null);
});

// --- evalCondition integration -----------------------------------------
test('evalCondition tip: an index prefix resolves the Nth candidate for text ops', () => {
    const r = tipRow();
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: '2:2' }, COLS), true);
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: '2:O 2.5' }, COLS), false);
    // bare value still matches the chosen tip (backward compatible)
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'O 2.5' }, COLS), true);
});

test('evalCondition tip: H/M outcome gate combines (AND) with the market predicate', () => {
    const r = tipRow(); // 1:hit · 2:miss · 3:miss
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'H1:O 2.5' }, COLS), true);
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'M1:O 2.5' }, COLS), false);
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'M2:2' }, COLS), true);
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'H2:2' }, COLS), false);
});

test('evalCondition tip: an outcome-only prefix (empty value) filters by settled result', () => {
    const r = tipRow();
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'H:' }, COLS), true);
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'M:' }, COLS), false);
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'M2:' }, COLS), true);
});

test('evalCondition tip: in / not-in / match honor the candidate prefix', () => {
    const r = tipRow();
    assert.equal(evalCondition(r, { key: 'tip', op: 'in', value: '2:2,X' }, COLS), true);
    assert.equal(evalCondition(r, { key: 'tip', op: 'not-in', value: '2:O 2.5,X' }, COLS), true);
    assert.equal(evalCondition(r, { key: 'tip', op: 'match', value: '3:^u' }, COLS), true);
});

test('evalCondition tip: a pending fixture never satisfies an H/M outcome filter', () => {
    const r = tipRow({ score: null });
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: 'H1:O 2.5' }, COLS), false);
    // …but without the outcome gate the market still matches on a pending row
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: '1:O 2.5' }, COLS), true);
});

test('evalCondition tip: an absent Nth candidate is a non-match', () => {
    const r = tipRow();
    assert.equal(evalCondition(r, { key: 'tip', op: 'like', value: '4:anything' }, COLS), false);
    assert.equal(evalCondition({ tip_market: 'O 2.5' }, { key: 'tip', op: 'like', value: '2:x' }, COLS), false);
});

// --- tip_confidence field: the chosen tip's win % on a 0-100 integer scale ---
const CONF_COLS = [{ key: 'tip_confidence', group: 'base' }];

test('evalCondition tip_confidence: compares the chosen win % on a 0-100 scale', () => {
    const r = { tip_confidence: 0.72 }; // 72%
    assert.equal(evalCondition(r, { key: 'tip_confidence', op: 'gte', value: '70' }, CONF_COLS), true);
    assert.equal(evalCondition(r, { key: 'tip_confidence', op: 'gte', value: '72' }, CONF_COLS), true);
    assert.equal(evalCondition(r, { key: 'tip_confidence', op: 'gt', value: '72' }, CONF_COLS), false);
    assert.equal(evalCondition({ tip_confidence: 0.6 }, { key: 'tip_confidence', op: 'gte', value: '70' }, CONF_COLS), false);
});

test('evalCondition tip_confidence: rounds to the displayed integer %; null never matches', () => {
    // 0.666 -> 66.6 -> 67 (matches the rounded % the tip cell shows)
    assert.equal(evalCondition({ tip_confidence: 0.666 }, { key: 'tip_confidence', op: 'gte', value: '67' }, CONF_COLS), true);
    assert.equal(evalCondition({ tip_confidence: 0.666 }, { key: 'tip_confidence', op: 'gt', value: '67' }, CONF_COLS), false);
    assert.equal(evalCondition({ tip_confidence: null }, { key: 'tip_confidence', op: 'gte', value: '0' }, CONF_COLS), false);
});
