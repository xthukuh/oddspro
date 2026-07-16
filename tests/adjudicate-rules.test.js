import test from 'node:test';
import assert from 'node:assert/strict';

import {
    priceWithinTolerance,
    hotVerdictContext,
    tipVerdictContext,
    canReuseHotVerdict,
    canReuseTipVerdict,
    hotReviewPending,
    tipReviewPending,
    selectTipReviews,
    latencyStats,
    marketLine,
} from '../src/db/adjudicate-rules.js';

// Pure module - no .env/DB/axios. These rules decide when a stored AI verdict
// is still fresh (worker-owned verdict columns carry their own verdict-time
// context inside the review JSON) and how the per-day billed budget is spent.

const TAG = 'gemini-2.5-flash+search#p3';

// --- priceWithinTolerance ---------------------------------------------------

test('priceWithinTolerance: tol 0 means exact numeric equality (mysql2 DECIMAL strings coerce)', () => {
    assert.equal(priceWithinTolerance(1.85, 1.85, 0), true);
    assert.equal(priceWithinTolerance('1.85', 1.85, 0), true);
    assert.equal(priceWithinTolerance(1.85, '1.85', 0), true);
    assert.equal(priceWithinTolerance(1.85, 1.86, 0), false);
});

test('priceWithinTolerance: relative tolerance admits drift up to tol of the stored price', () => {
    // |1.57 - 1.50| / 1.50 = 0.0467 <= 0.05
    assert.equal(priceWithinTolerance(1.5, 1.57, 0.05), true);
    // |1.58 - 1.50| / 1.50 = 0.0533 > 0.05
    assert.equal(priceWithinTolerance(1.5, 1.58, 0.05), false);
    // downward drift counts the same way
    assert.equal(priceWithinTolerance(1.5, 1.43, 0.05), true);
    assert.equal(priceWithinTolerance(1.5, 1.42, 0.05), false);
});

test('priceWithinTolerance: null/absent and junk inputs', () => {
    assert.equal(priceWithinTolerance(null, null, 0.05), true, 'both absent = unchanged');
    assert.equal(priceWithinTolerance(null, 1.5, 0.05), false);
    assert.equal(priceWithinTolerance(1.5, null, 0.05), false);
    assert.equal(priceWithinTolerance('junk', 1.5, 0.05), false);
    assert.equal(priceWithinTolerance(0, 0, 0), true, 'equal zeros are equal');
    assert.equal(priceWithinTolerance(0, 0.1, 0.05), false, 'zero base cannot admit drift');
    assert.equal(priceWithinTolerance(1.5, 1.43, -1), false, 'negative tol clamps to exact match');
});

// --- verdict-time context readers -------------------------------------------

test('hotVerdictContext: reads judged.score from object or JSON string, else null', () => {
    assert.deepEqual(hotVerdictContext({ probability: 0.7, judged: { score: 0.73 } }), { score: 0.73 });
    assert.deepEqual(hotVerdictContext('{"judged":{"score":"0.73"}}'), { score: 0.73 });
    assert.equal(hotVerdictContext({ probability: 0.7 }), null, 'legacy review without judged');
    assert.equal(hotVerdictContext('{"probability":0.7}'), null);
    assert.equal(hotVerdictContext('not json'), null);
    assert.equal(hotVerdictContext(null), null);
    assert.equal(hotVerdictContext({ judged: { score: 'junk' } }), null, 'non-numeric score');
});

test('tipVerdictContext: reads judged tip identity from object or JSON string, else null', () => {
    assert.deepEqual(
        tipVerdictContext({ judged: { tip_market: 'O 2.5', tip_price: 1.44 } }),
        { tip_market: 'O 2.5', tip_price: 1.44 });
    assert.deepEqual(
        tipVerdictContext('{"judged":{"tip_market":"X2","tip_price":"1.36"}}'),
        { tip_market: 'X2', tip_price: '1.36' });
    assert.equal(tipVerdictContext({ probability: 0.8 }), null, 'legacy review without judged');
    assert.equal(tipVerdictContext({ judged: { tip_price: 1.44 } }), null, 'market missing');
    assert.equal(tipVerdictContext(null), null);
    assert.equal(tipVerdictContext('broken{'), null);
});

// --- canReuseHotVerdict ------------------------------------------------------

const hotPrev = (over = {}) => ({
    ai_verdict: 'confirm',
    ai_model: TAG,
    ai_review: { probability: 0.7, judged: { score: 0.73 } },
    ...over,
});

test('canReuseHotVerdict: reusable when verdict decided, model matches and judged score is unchanged', () => {
    assert.equal(canReuseHotVerdict(hotPrev(), 0.73, TAG), true);
    assert.equal(canReuseHotVerdict(hotPrev({ ai_verdict: 'veto' }), 0.73, TAG), true);
    // numeric comparison across string/number representations
    assert.equal(canReuseHotVerdict(hotPrev({ ai_review: '{"judged":{"score":"0.73"}}' }), 0.73, TAG), true);
});

test('canReuseHotVerdict: error verdicts, model switches, score drift and legacy rows all re-fire', () => {
    assert.equal(canReuseHotVerdict(hotPrev({ ai_verdict: 'error' }), 0.73, TAG), false);
    assert.equal(canReuseHotVerdict(hotPrev({ ai_verdict: null }), 0.73, TAG), false);
    assert.equal(canReuseHotVerdict(hotPrev({ ai_model: 'other#p2' }), 0.73, TAG), false);
    assert.equal(canReuseHotVerdict(hotPrev(), 0.74, TAG), false);
    assert.equal(canReuseHotVerdict(hotPrev({ ai_review: { probability: 0.7 } }), 0.73, TAG), false,
        'legacy review without verdict-time context re-bills once');
    assert.equal(canReuseHotVerdict(null, 0.73, TAG), false);
});

// --- canReuseTipVerdict ------------------------------------------------------

const tipPrev = (over = {}) => ({
    tip_ai_verdict: 'confirm',
    tip_ai_model: TAG,
    tip_ai_review: { probability: 0.8, judged: { tip_market: 'O 2.5', tip_price: 1.5 } },
    ...over,
});

test('canReuseTipVerdict: reusable on same market with price inside the tolerance', () => {
    assert.equal(canReuseTipVerdict(tipPrev(), { tip_market: 'O 2.5', tip_price: 1.5 }, TAG, 0), true);
    assert.equal(canReuseTipVerdict(tipPrev(), { tip_market: 'O 2.5', tip_price: 1.57 }, TAG, 0.05), true);
    assert.equal(canReuseTipVerdict(tipPrev({ tip_ai_verdict: 'veto' }),
        { tip_market: 'O 2.5', tip_price: 1.5 }, TAG, 0), true);
});

test('canReuseTipVerdict: market re-pick always re-fires, even inside the price tolerance', () => {
    assert.equal(canReuseTipVerdict(tipPrev(), { tip_market: 'X2', tip_price: 1.5 }, TAG, 0.5), false);
});

test('canReuseTipVerdict: drift beyond tol, model switch, error verdict and legacy rows re-fire', () => {
    assert.equal(canReuseTipVerdict(tipPrev(), { tip_market: 'O 2.5', tip_price: 1.58 }, TAG, 0.05), false);
    assert.equal(canReuseTipVerdict(tipPrev(), { tip_market: 'O 2.5', tip_price: 1.51 }, TAG, 0), false);
    assert.equal(canReuseTipVerdict(tipPrev({ tip_ai_model: 'other#p2' }),
        { tip_market: 'O 2.5', tip_price: 1.5 }, TAG, 0), false);
    assert.equal(canReuseTipVerdict(tipPrev({ tip_ai_verdict: 'error' }),
        { tip_market: 'O 2.5', tip_price: 1.5 }, TAG, 0), false);
    assert.equal(canReuseTipVerdict(tipPrev({ tip_ai_review: { probability: 0.8 } }),
        { tip_market: 'O 2.5', tip_price: 1.5 }, TAG, 0), false, 'legacy review without context');
    assert.equal(canReuseTipVerdict(null, { tip_market: 'O 2.5', tip_price: 1.5 }, TAG, 0), false);
});

// --- pending predicates (shared by the worker and the summary count) ---------

test('hotReviewPending: hot rows without a reusable verdict are pending', () => {
    assert.equal(hotReviewPending({ hot: 1, ...hotPrev({ ai_verdict: null, ai_review: null }) }, TAG), true);
    assert.equal(hotReviewPending({ hot: true, ...hotPrev({ ai_verdict: 'error' }) }, TAG), true);
    assert.equal(hotReviewPending({ hot: 1, ...hotPrev(), score: '0.73' }, TAG), false, 'reusable verdict = not pending');
    assert.equal(hotReviewPending({ hot: 0, ...hotPrev({ ai_verdict: null }) }, TAG), false, 'not hot = never pending');
});

test('tipReviewPending: tipped rows above the confidence floor without a reusable verdict are pending', () => {
    const row = {
        tip_market: 'O 2.5', tip_price: '1.50', tip_confidence: '0.66',
        tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null,
    };
    assert.equal(tipReviewPending(row, TAG, { minConfidence: 0.6, priceTol: 0 }), true);
    assert.equal(tipReviewPending(row, TAG, { minConfidence: 0.7, priceTol: 0 }), false, 'below floor');
    assert.equal(tipReviewPending({ ...row, tip_market: null }, TAG, { minConfidence: 0 }), false, 'tipless');
    const reviewed = { ...row, ...tipPrev() };
    assert.equal(tipReviewPending(reviewed, TAG, { minConfidence: 0, priceTol: 0 }), false, 'reusable = not pending');
    assert.equal(tipReviewPending({ ...reviewed, tip_price: '1.58' }, TAG, { minConfidence: 0, priceTol: 0.05 }),
        true, 'drift beyond tol re-enters the queue');
});

// --- selectTipReviews (budget selector) --------------------------------------

test('selectTipReviews: reusable candidates never consume budget; billable capped in order', () => {
    const c = (id, reusable) => ({ id, reusable });
    const out = selectTipReviews([c(1, true), c(2, false), c(3, false), c(4, true), c(5, false)], 2);
    assert.deepEqual(out.reused.map(x => x.id), [1, 4]);
    assert.deepEqual(out.billable.map(x => x.id), [2, 3]);
    assert.deepEqual(out.skipped.map(x => x.id), [5]);
});

test('selectTipReviews: zero or negative budget bills nothing but still reuses', () => {
    const c = (id, reusable) => ({ id, reusable });
    const zero = selectTipReviews([c(1, true), c(2, false)], 0);
    assert.deepEqual(zero.reused.map(x => x.id), [1]);
    assert.deepEqual(zero.billable, []);
    assert.deepEqual(zero.skipped.map(x => x.id), [2]);
    const neg = selectTipReviews([c(1, false)], -3);
    assert.deepEqual(neg.billable, []);
    assert.deepEqual(neg.skipped.map(x => x.id), [1]);
});

test('selectTipReviews: empty and all-reusable inputs', () => {
    assert.deepEqual(selectTipReviews([], 5), { reused: [], billable: [], skipped: [] });
    const all = selectTipReviews([{ id: 1, reusable: true }], 5);
    assert.deepEqual(all.reused.map(x => x.id), [1]);
    assert.deepEqual(all.billable, []);
});

// --- latencyStats -------------------------------------------------------------

test('latencyStats: n/min/avg/max over finite samples only', () => {
    assert.deepEqual(latencyStats([]), { n: 0, min: null, avg: null, max: null });
    assert.deepEqual(latencyStats([100, 200, 300]), { n: 3, min: 100, avg: 200, max: 300 });
    assert.deepEqual(latencyStats([100, NaN, 300, null]), { n: 2, min: 100, avg: 200, max: 300 });
    assert.deepEqual(latencyStats(null), { n: 0, min: null, avg: null, max: null });
});

// --- marketLine ----------------------------------------------------------------

test('marketLine: bare O/U keys yield their line, everything else null', () => {
    assert.equal(marketLine('O 2.5'), 2.5);
    assert.equal(marketLine('U 3.5'), 3.5);
    assert.equal(marketLine('O 1.5'), 1.5);
    assert.equal(marketLine('1X'), null);
    assert.equal(marketLine('GG'), null);
    assert.equal(marketLine('TT:H:O 1.5'), null, 'team totals are not the fixture O/U');
    assert.equal(marketLine(null), null);
});
