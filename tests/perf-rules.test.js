// Betting-performance calculations (src/db/perf-rules.js): flat-stake ROI,
// hit-rate windows, confidence/market/edge buckets and AI-veto impact over
// the fixture_predictions ledger. Pure module - no .env/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marketGroup, confidenceBand, edgeOf, summarizePerformance } from '../src/db/perf-rules.js';

const NOW = new Date('2026-07-04 12:00:00').getTime();
const daysAgo = d => new Date(NOW - d * 86_400_000).toISOString();

// Ledger row factory: tip-only by default; hot fields opt-in
const tip = (over = {}) => ({
    kickoff: daysAgo(3), hot: 0, score: null, outcome: null, over_price: null, ai_verdict: null,
    tip_market: '1X', tip_price: 2.0, tip_confidence: 0.75, tip_outcome: null, tip_ai_verdict: null,
    ...over,
});

// --- labeling helpers ---

test('marketGroup buckets canonical tip markets', () => {
    assert.equal(marketGroup('1'), '1X2');
    assert.equal(marketGroup('X'), '1X2');
    assert.equal(marketGroup('1X'), 'double_chance');
    assert.equal(marketGroup('12'), 'double_chance');
    assert.equal(marketGroup('O 2.5'), 'over_under');
    assert.equal(marketGroup('U 0.5'), 'over_under');
    assert.equal(marketGroup('BTTS'), 'other');
});

test('confidenceBand slices at the documented boundaries', () => {
    assert.equal(confidenceBand(0.5), '0.50-0.59');
    assert.equal(confidenceBand(0.6), '0.60-0.69');
    assert.equal(confidenceBand(0.7999), '0.70-0.79');
    assert.equal(confidenceBand(0.8), '0.80+');
    assert.equal(confidenceBand(0.49), '<0.50');
    assert.equal(confidenceBand(null), 'unknown');
});

test('edgeOf is the expected-value proxy', () => {
    assert.equal(edgeOf(0.8, 1.5), Math.round((0.8 * 1.5 - 1) * 10000) / 10000); // +0.2
    assert.equal(edgeOf(0.6, 1.5), Math.round((0.6 * 1.5 - 1) * 10000) / 10000); // -0.1
    assert.equal(edgeOf(null, 1.5), null);
    assert.equal(edgeOf(0.8, null), null);
});

// --- flat-stake ROI and windows ---

test('summarizePerformance computes flat-stake ROI and hit-rate over settled tips', () => {
    const rows = [
        tip({ tip_outcome: 'hit', tip_price: 2.0 }),   // +1.0
        tip({ tip_outcome: 'hit', tip_price: '1.50' }), // +0.5 (DECIMAL arrives as string)
        tip({ tip_outcome: 'miss', tip_price: 3.0 }),  // -1.0
        tip({}),                                        // pending - no stake
    ];
    const all = summarizePerformance(rows, NOW).tips.windows.all;
    assert.equal(all.picks, 4);
    assert.equal(all.hits, 2);
    assert.equal(all.misses, 1);
    assert.equal(all.pending, 1);
    assert.equal(all.rate, Math.round(2 / 3 * 10000) / 10000);
    assert.equal(all.staked, 3);
    assert.equal(all.profit, 0.5);
    assert.equal(all.roi, Math.round(0.5 / 3 * 10000) / 10000);
    assert.equal(all.avg_price, Math.round((2 + 1.5 + 3) / 3 * 10000) / 10000);
    assert.equal(all.break_even, Math.round(1 / all.avg_price * 10000) / 10000);
});

test('summarizePerformance windows slice by kickoff', () => {
    const rows = [
        tip({ kickoff: daysAgo(3), tip_outcome: 'hit' }),
        tip({ kickoff: daysAgo(20), tip_outcome: 'miss' }),
        tip({ kickoff: daysAgo(60), tip_outcome: 'hit' }),
    ];
    const w = summarizePerformance(rows, NOW).tips.windows;
    assert.equal(w['7d'].picks, 1);
    assert.equal(w['30d'].picks, 2);
    assert.equal(w.all.picks, 3);
    assert.equal(w['7d'].rate, 1);
    assert.equal(w['30d'].rate, 0.5);
});

test('empty ledger yields null rates, zero picks and no crashes', () => {
    const out = summarizePerformance([], NOW);
    assert.equal(out.tips.windows.all.picks, 0);
    assert.equal(out.tips.windows.all.rate, null);
    assert.equal(out.tips.windows.all.roi, null);
    assert.equal(out.hotpicks.windows.all.picks, 0);
    assert.equal(out.tips.ai_impact.vetoed.picks, 0);
    assert.equal(out.tips.ai_impact.saved, 0);
});

// --- buckets ---

test('buckets split settled tips by confidence band, market group and edge sign', () => {
    const rows = [
        // 0.8 x 1.5 - 1 = +0.2 edge, hit
        tip({ tip_market: '1', tip_price: 1.5, tip_confidence: 0.8, tip_outcome: 'hit' }),
        // 0.55 x 1.6 - 1 = -0.12 edge, miss
        tip({ tip_market: 'O 2.5', tip_price: 1.6, tip_confidence: 0.55, tip_outcome: 'miss' }),
    ];
    const b = summarizePerformance(rows, NOW).tips.buckets;
    assert.equal(b.confidence['0.80+'].picks, 1);
    assert.equal(b.confidence['0.50-0.59'].picks, 1);
    assert.equal(b.market['1X2'].picks, 1);
    assert.equal(b.market.over_under.picks, 1);
    assert.equal(b.edge.positive.picks, 1);
    assert.equal(b.edge.positive.profit, 0.5);
    assert.equal(b.edge.negative.picks, 1);
    assert.equal(b.edge.negative.profit, -1);
});

// --- AI-veto impact (vetoed picks settle but are excluded from headlines) ---

test('AI-vetoed tips are excluded from windows and reported as impact', () => {
    const rows = [
        tip({ tip_outcome: 'hit', tip_price: 2.0 }),
        tip({ tip_outcome: 'miss', tip_price: 2.0, tip_ai_verdict: 'veto' }), // veto avoided -1
        tip({ tip_outcome: 'hit', tip_price: 3.0, tip_ai_verdict: 'veto' }),  // veto cost +2
    ];
    const t = summarizePerformance(rows, NOW).tips;
    assert.equal(t.windows.all.picks, 1); // only the non-vetoed tip
    assert.equal(t.ai_impact.vetoed.picks, 2);
    assert.equal(t.ai_impact.vetoed.profit, 1); // -1 + 2
    assert.equal(t.ai_impact.saved, -1); // following the vetoes forfeited 1 unit
});

// --- hot picks stream ---

test('hot picks stake the O 2.5 price; AI-overturned candidates land in impact', () => {
    const rows = [
        { kickoff: daysAgo(2), hot: 1, score: '0.72', outcome: 'hit', over_price: '1.80', ai_verdict: 'confirm', tip_market: null },
        { kickoff: daysAgo(2), hot: 1, score: 0.65, outcome: 'miss', over_price: 1.7, ai_verdict: null, tip_market: null },
        // Rule-hot but AI-vetoed: hot=0 in the ledger, ai_verdict survives
        { kickoff: daysAgo(2), hot: 0, score: 0.7, outcome: 'miss', over_price: 1.9, ai_verdict: 'veto', tip_market: null },
    ];
    const h = summarizePerformance(rows, NOW).hotpicks;
    assert.equal(h.windows.all.picks, 2);
    assert.equal(h.windows.all.profit, Math.round((0.8 - 1) * 10000) / 10000);
    assert.equal(h.buckets.confidence['0.70-0.79'].picks, 1);
    assert.equal(h.buckets.confidence['0.60-0.69'].picks, 1);
    assert.equal(h.ai_impact.vetoed.picks, 1);
    assert.equal(h.ai_impact.saved, 1); // the vetoed pick missed - veto saved a unit
});

// --- shape stability for the API/CLI consumers ---

test('summary carries the documented top-level shape', () => {
    const out = summarizePerformance([tip({})], NOW);
    assert.deepEqual(Object.keys(out), ['generated_at', 'tips', 'hotpicks']);
    assert.deepEqual(Object.keys(out.tips), ['windows', 'buckets', 'ai_impact']);
    assert.deepEqual(Object.keys(out.tips.windows), ['7d', '30d', 'all']);
    assert.deepEqual(Object.keys(out.tips.buckets), ['confidence', 'market', 'edge']);
    assert.deepEqual(Object.keys(out.hotpicks.buckets), ['confidence', 'edge']);
});
