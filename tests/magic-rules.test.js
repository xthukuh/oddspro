// Magic sort calculations (src/db/magic-rules.js): tip normalization,
// empirical calibration + shrinkage, ranking strategies, the day-grouped
// top-4 slip replay and the betslip math. Pure module - no .env/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    tipView, priceBand, computeCalibration, shrunkRate, estimateLegProb, legPicks,
    STRATEGIES, scoreTip, magicSortRows, slipSummary, slipOutcome, slipTotals, simulateStrategies,
    buildSlips, tipAgreement, safeQualifies, safeSelection, DEFAULT_SAFE,
    safePrior, WAREHOUSE_WLO, SAFE_TIERS, hasSufficientStats,
} from '../src/db/magic-rules.js';

const _round = v => Math.round(v * 10000) / 10000 + 0;
const _score = (id, tip, cal) => STRATEGIES.find(s => s.id === id).score(tip, cal);

// Ledger/records row factory (simulateStrategies + scoreTip input)
const row = (over = {}) => ({
    day: '2026-07-01',
    tip_market: '1X', tip_price: 1.3, tip_confidence: 0.75,
    tip_outcome: 'hit', tip_breakdown: null, tip_ai_verdict: null,
    ...over,
});

// Settled tipView factory (computeCalibration input)
const tv = (over = {}) => ({
    market: '1X', price: 1.3, confidence: 0.75, outcome: 'hit',
    vetoed: false, breakdown: null,
    ...over,
});

// --- tipView ---

test('tipView normalizes a tip row and nulls tipless rows', () => {
    assert.equal(tipView({ tip_market: null }), null);
    assert.equal(tipView(null), null);
    const t = tipView(row({
        tip_price: '1.30', tip_confidence: '0.7500', // DECIMAL strings
        tip_breakdown: '{"market_prob":0.8}',        // JSON string (loader raw)
        tip_ai_verdict: 'veto',
    }));
    assert.equal(t.market, '1X');
    assert.equal(t.price, 1.3);
    assert.equal(t.confidence, 0.75);
    assert.equal(t.outcome, 'hit');
    assert.equal(t.vetoed, true);
    assert.deepEqual(t.breakdown, { market_prob: 0.8 });
});

test('tipView tolerates malformed breakdown JSON and missing fields', () => {
    const t = tipView({ tip_market: 'O 2.5', tip_breakdown: '{oops' });
    assert.equal(t.breakdown, null);
    assert.equal(t.price, null);
    assert.equal(t.confidence, null);
    assert.equal(t.outcome, null);
    assert.equal(t.vetoed, false);
});

// --- legPicks (betslip per-leg market switcher, R26d) ---

test('legPicks returns the chosen pick plus up to two runners-up, each re-estimated', () => {
    const r = row({
        tip_market: 'O 2.5', tip_price: 1.5, tip_confidence: 0.72,
        tip_breakdown: {
            market: 'O 2.5', price: 1.5, confidence: 0.72, market_prob: 0.7,
            runners_up: [
                { market: 'O 1.5', price: 1.2, confidence: 0.81, market_prob: 0.8 },
                { market: '1X', price: 1.3, confidence: 0.66, market_prob: 0.64 },
            ],
        },
    });
    const picks = legPicks(r, null);
    assert.equal(picks.length, 3);
    assert.deepEqual(picks.map(p => p.market), ['O 2.5', 'O 1.5', '1X']);
    assert.deepEqual(picks.map(p => p.price), [1.5, 1.2, 1.3]);
    // cal=null → estimateLegProb falls back to each candidate's own confidence
    assert.equal(picks[0].prob, 0.72);
    assert.equal(picks[1].prob, 0.81);
    assert.equal(picks[2].prob, 0.66);
});

test('legPicks returns just the chosen pick when there are no runners-up', () => {
    const picks = legPicks(row({ tip_breakdown: { market: '1X', confidence: 0.75, market_prob: 0.7, runners_up: [] } }), null);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].market, '1X');
});

test('legPicks parses a string breakdown and skips malformed runners-up', () => {
    const r = row({
        tip_market: 'O 3.5', tip_price: 1.8, tip_confidence: 0.6,
        tip_breakdown: JSON.stringify({
            market: 'O 3.5', price: 1.8, confidence: 0.6, market_prob: 0.55,
            runners_up: [{ market: null }, { market: 'U 4.5', price: 1.4, confidence: 0.58, market_prob: 0.6 }],
        }),
    });
    const picks = legPicks(r, null);
    assert.deepEqual(picks.map(p => p.market), ['O 3.5', 'U 4.5']);
});

test('legPicks returns [] for a tipless row', () => {
    assert.deepEqual(legPicks({ tip_market: null }, null), []);
    assert.deepEqual(legPicks(null, null), []);
});

// --- calibration ---

test('priceBand brackets the observed tip price distribution', () => {
    assert.equal(priceBand(1.05), '1.00-1.19');
    assert.equal(priceBand(1.2), '1.20-1.34');
    assert.equal(priceBand(1.34), '1.20-1.34');
    assert.equal(priceBand(1.35), '1.35-1.54');
    assert.equal(priceBand(1.55), '1.55+');
    assert.equal(priceBand(null), 'unknown');
});

test('computeCalibration tallies bands, groups, cells, lines and prices', () => {
    const cal = computeCalibration([
        tv({ confidence: 0.85, market: '1X', outcome: 'hit' }),
        tv({ confidence: 0.85, market: '1X', outcome: 'miss' }),
        tv({ confidence: 0.65, market: 'O 2.5', price: 1.4, outcome: 'hit' }),
        tv({ confidence: 0.65, market: 'O 2.5', price: 1.4, outcome: 'hit', vetoed: true }), // vetoed still counts
        tv({ outcome: null }), // pending - ignored
    ]);
    assert.equal(cal.settled, 4);
    assert.equal(cal.global_rate, 0.75);
    assert.deepEqual(cal.bands['0.80+'], { n: 2, hits: 1 });
    assert.deepEqual(cal.bands['0.60-0.69'], { n: 2, hits: 2 });
    assert.deepEqual(cal.groups.double_chance, { n: 2, hits: 1 });
    assert.deepEqual(cal.cells['0.60-0.69|over_under'], { n: 2, hits: 2 });
    assert.deepEqual(cal.lines['O 2.5'], { n: 2, hits: 2 });
    assert.deepEqual(cal.prices['1.35-1.54'], { n: 2, hits: 2 });
    assert.deepEqual(cal.markets['1X'], { n: 2, hits: 1 });      // per-exact-market
    assert.deepEqual(cal.markets['O 2.5'], { n: 2, hits: 2 });
    assert.equal(cal.shrink_k, 10);
});

test('shrunkRate pulls thin buckets toward the global rate', () => {
    // Hand-computed: (hits + k*g) / (n + k)
    assert.equal(shrunkRate({ n: 4, hits: 4 }, 0.625, 10), (4 + 10 * 0.625) / 14);
    assert.equal(shrunkRate({ n: 2, hits: 2 }, 0.7, 10), (2 + 7) / 12); // 100% cell lands at 0.75, not 1
    assert.equal(shrunkRate(null, 0.7, 10), 0.7);       // missing bucket = global
    assert.equal(shrunkRate({ n: 0, hits: 0 }, 0.7), 0.7);
    assert.equal(shrunkRate({ n: 5, hits: 5 }, null), (5 + 10 * 0.5) / 15); // no global yet
});

test('estimateLegProb prefers the cell posterior, falls back to confidence, clamps', () => {
    const cal = computeCalibration([
        ...Array.from({ length: 20 }, () => tv({ confidence: 0.65, market: 'O 2.5', outcome: 'hit' })),
        ...Array.from({ length: 20 }, () => tv({ confidence: 0.85, market: '1X', outcome: 'miss' })),
    ]);
    // cell 0.60-0.69|over_under = 20/20, g = 0.5 -> (20 + 5) / 30
    assert.equal(estimateLegProb(tv({ confidence: 0.65, market: 'O 2.5' }), cal), _round(25 / 30));
    // no calibration -> blend confidence
    assert.equal(estimateLegProb(tv({ confidence: 0.72 }), null), 0.72);
    assert.equal(estimateLegProb(tv({ confidence: 0.999 }), null), 0.98); // clamp
    assert.equal(estimateLegProb(null, null), null);
});

// --- safePrior (live hit rate shrunk toward the warehouse anchor) ---

test('safePrior falls back to the warehouse anchor with no calibration', () => {
    assert.equal(safePrior('X2', null), WAREHOUSE_WLO['X2']);       // 0.669
    assert.equal(safePrior('U 4.5', null), WAREHOUSE_WLO['U 4.5']); // 0.868
    // Unknown market with no cal -> neutral 0.6 (never a hardcoded high prior)
    assert.equal(safePrior('GG', null), 0.6);
});

test('safePrior shrinks the live rate toward the anchor and resolves the warehouse<->live reversal', () => {
    // X2: weak warehouse anchor (0.669) but strong live -> shrinks UP.
    const calX2 = { global_rate: 0.73, markets: { X2: { n: 67, hits: 56 } } }; // live 83.6%
    // (56 + 20*0.669) / (67 + 20) = 69.38 / 87 = 0.7975
    assert.equal(safePrior('X2', calX2), _round((56 + 20 * 0.669) / 87));
    assert.ok(safePrior('X2', calX2) > WAREHOUSE_WLO['X2'], 'strong live pulls X2 up');
    // U 4.5: strong warehouse anchor (0.868) but weak live -> shrinks DOWN.
    const calU = { global_rate: 0.73, markets: { 'U 4.5': { n: 127, hits: 88 } } }; // live 69.3%
    assert.ok(safePrior('U 4.5', calU) < WAREHOUSE_WLO['U 4.5'], 'weak live pulls U 4.5 down');
    // Market with no anchor uses the live global rate as the shrink target.
    assert.equal(safePrior('GG', { global_rate: 0.7, markets: {} }), 0.7);
});

test('sure strategy = safePrior x confidence, ranking live-winners over price-blind precision', () => {
    const cal = computeCalibration([
        ...Array.from({ length: 67 }, (_, i) => tv({ market: 'X2', confidence: 0.75, outcome: i < 56 ? 'hit' : 'miss' })),
        ...Array.from({ length: 192 }, (_, i) => tv({ market: '12', confidence: 0.75, outcome: i < 138 ? 'hit' : 'miss' })),
    ]);
    // Same confidence 0.75: X2 (live 83.6%) must outrank 12 (live 71.9%) purely
    // via safePrior - the live term corrects the warehouse ordering.
    const sX2 = scoreTip({ tip_market: 'X2', tip_confidence: 0.75, tip_breakdown: '{}' }, 'sure', cal);
    const s12 = scoreTip({ tip_market: '12', tip_confidence: 0.75, tip_breakdown: '{}' }, 'sure', cal);
    assert.ok(sX2 > s12, `X2 (${sX2}) should outrank 12 (${s12}) under sure`);
    assert.equal(scoreTip({ tip_market: null }, 'sure', cal), null); // tipless sinks
});

// --- hasSufficientStats (the risky-exclusion gate) ---

test('hasSufficientStats excludes thin samples but tolerates rows without recorded samples', () => {
    const mk = (samples) => ({ tip_market: '1X', tip_price: 1.3, tip_confidence: 0.7,
        tip_breakdown: samples ? { market_prob: 0.8, stats_prob: 0.7, samples } : { market_prob: 0.8 } });
    assert.equal(hasSufficientStats(mk({ home_n: 7, away_n: 6, h2h_n: 4 })), true);
    assert.equal(hasSufficientStats(mk({ home_n: 4, away_n: 8, h2h_n: 4 })), false); // min side < 6
    assert.equal(hasSufficientStats(mk(null)), true);                                // no samples -> tolerated
    assert.equal(hasSufficientStats({ tip_market: null }), false);                   // tipless -> risky
    // minH2H is off by default; raising it gates
    assert.equal(hasSufficientStats(mk({ home_n: 7, away_n: 7, h2h_n: 1 }), { minH2H: 3 }), false);
    assert.equal(hasSufficientStats(mk({ home_n: 7, away_n: 7, h2h_n: 1 })), true);
});

test('SAFE_TIERS keeps minParts pinned and only balanced equals the shipped default', () => {
    assert.deepEqual(SAFE_TIERS.balanced, { minAgreement: 0.65, maxPrice: 1.6, maxPerDay: 3 });
    assert.ok(SAFE_TIERS['max-precision'].maxPerDay < SAFE_TIERS.volume.maxPerDay);
    // balanced merged over DEFAULT_SAFE reproduces the shipped gate values
    const bal = { ...DEFAULT_SAFE, ...SAFE_TIERS.balanced };
    assert.equal(bal.minAgreement, DEFAULT_SAFE.minAgreement);
    assert.equal(bal.maxPerDay, DEFAULT_SAFE.maxPerDay);
});

// --- strategies ---

test('every strategy scores a bare tip (null breakdown, no calibration)', () => {
    const bare = tv({ breakdown: null });
    for (const s of STRATEGIES) {
        const v = s.score(bare, null);
        assert.ok(Number.isFinite(v), `${s.id} must fall back to a finite score`);
    }
});

test('component strategies read the breakdown with fallback chains', () => {
    const t = tv({
        confidence: 0.7,
        breakdown: { market_prob: 0.8, stats_prob: 0.6, api_prob: 0.72 },
    });
    assert.equal(_score('market', t, null), 0.8);
    assert.equal(_score('stats', t, null), 0.6);
    assert.equal(_score('agreement', t, null), 0.6); // min of components
    assert.equal(_score('stats', tv({ confidence: 0.7, breakdown: { market_prob: 0.8 } }), null), 0.8);
    assert.equal(_score('market', tv({ confidence: 0.7 }), null), 0.7);
});

test('edge strategy is the EV proxy and nulls without a price', () => {
    assert.equal(_score('edge', tv({ confidence: 0.8, price: 1.5 }), null), 0.8 * 1.5 - 1);
    assert.equal(_score('edge', tv({ price: null }), null), null);
});

test('bucket strategy exploits the confidence inversion the raw blend misses', () => {
    // Live pattern: the 0.60-0.69 band hits more than the 0.80+ band.
    const cal = computeCalibration([
        ...Array.from({ length: 30 }, () => tv({ confidence: 0.65, market: 'O 2.5', outcome: 'hit' })),
        ...Array.from({ length: 10 }, () => tv({ confidence: 0.65, market: 'O 2.5', outcome: 'miss' })),
        ...Array.from({ length: 20 }, () => tv({ confidence: 0.85, market: 'O 2.5', outcome: 'hit' })),
        ...Array.from({ length: 20 }, () => tv({ confidence: 0.85, market: 'O 2.5', outcome: 'miss' })),
    ]);
    const low = tv({ confidence: 0.65, market: 'O 3.5' });
    const high = tv({ confidence: 0.85, market: 'O 3.5' });
    assert.ok(_score('confidence', high, cal) > _score('confidence', low, cal));
    assert.ok(_score('bucket', low, cal) > _score('bucket', high, cal), 'bucket must invert');
});

test('line strategy uses exact O/U line history and group rate for result markets', () => {
    const cal = computeCalibration([
        ...Array.from({ length: 10 }, () => tv({ market: 'O 2.5', outcome: 'hit' })),
        ...Array.from({ length: 10 }, () => tv({ market: 'U 4.5', outcome: 'miss' })),
    ]);
    assert.ok(_score('line', tv({ market: 'O 2.5' }), cal) > _score('line', tv({ market: 'U 4.5' }), cal));
    // result market -> group bucket (no double_chance settled here -> global)
    assert.equal(_score('line', tv({ market: '1X' }), cal), cal.global_rate);
});

// --- scoreTip / magicSortRows (the web table contract) ---

test('scoreTip nulls tipless, vetoed and unknown-strategy rows', () => {
    assert.equal(scoreTip(row({ tip_market: null, tip_skip_reason: 'no_markets' }), 'confidence', null), null);
    assert.equal(scoreTip(row({ tip_ai_verdict: 'veto' }), 'confidence', null), null);
    assert.equal(scoreTip(row(), 'nope', null), null);
    assert.equal(scoreTip(row({ tip_confidence: '0.75' }), 'confidence', null), 0.75);
});

test('magicSortRows sorts score desc, sinks nulls, keeps ties stable', () => {
    const a = row({ tip_confidence: 0.8, api_id: 1 });
    const b1 = row({ tip_confidence: 0.6, api_id: 2 });
    const b2 = row({ tip_confidence: 0.6, api_id: 3 });     // tie with b1
    const vetoed = row({ tip_confidence: 0.9, tip_ai_verdict: 'veto', api_id: 4 });
    const tipless = row({ tip_market: null, api_id: 5 });
    const sorted = magicSortRows([tipless, b2, vetoed, b1, a], 'confidence', null);
    assert.deepEqual(sorted.map(r => r.api_id), [1, 3, 2, 5, 4]); // ties AND the sunk tail keep input order
    assert.deepEqual([tipless, b2, vetoed, b1, a].map(r => r.api_id), [5, 3, 4, 2, 1], 'input untouched');
});

// --- safe selection (Safety Net Protocol gates + per-day cap) ---

// A row that clears every DEFAULT_SAFE gate: 3 components (>= 2 required),
// weakest 0.75 >= 0.65, price 1.25 <= 1.6, not vetoed.
const safe = (over = {}) => row({
    api_id: 1, tip_outcome: null, tip_price: 1.25,
    tip_breakdown: { market_prob: 0.8, stats_prob: 0.75, api_prob: 0.78 },
    ...over,
});

test('tipAgreement is the min of present components, null without any', () => {
    assert.equal(tipAgreement(tipView(safe())), 0.75);
    assert.equal(tipAgreement(tipView(safe({ tip_breakdown: { market_prob: 0.8 } }))), 0.8);
    assert.equal(tipAgreement(tipView(safe({ tip_breakdown: null }))), null);
    assert.equal(tipAgreement(null), null);
});

test('safeQualifies rejects each gate violation individually', () => {
    assert.equal(safeQualifies(safe()), true);
    assert.equal(safeQualifies(safe({ tip_ai_verdict: 'veto' })), false);
    assert.equal(safeQualifies(safe({ tip_market: null })), false);
    assert.equal(safeQualifies(safe({ tip_breakdown: null })), false);          // pre-2026-07-04 rows
    assert.equal(safeQualifies(safe({ tip_breakdown: { market_prob: 0.8 } })), false); // 1 of 3 parts < minParts 2
    assert.equal(safeQualifies(safe({ tip_breakdown: { market_prob: 0.8, stats_prob: 0.6, api_prob: 0.78 } })), false); // agree 0.60 < 0.65
    assert.equal(safeQualifies(safe({ tip_price: 1.7 })), false);
    assert.equal(safeQualifies(safe({ tip_price: null })), false);
    // partial opts merge over DEFAULT_SAFE (two parts pass by default, a
    // stricter override rejects)
    assert.equal(safeQualifies(safe({ tip_breakdown: { market_prob: 0.8, stats_prob: 0.75 } })), true);
    assert.equal(safeQualifies(safe({ tip_breakdown: { market_prob: 0.8, stats_prob: 0.75 } }), { minParts: 3 }), false);
});

test('safeQualifies normalizes DECIMAL strings and JSON-string breakdowns', () => {
    assert.equal(safeQualifies(safe({
        tip_price: '1.25', tip_confidence: '0.7500',
        tip_breakdown: '{"market_prob":0.8,"stats_prob":0.75,"api_prob":0.78}',
    })), true);
});

test('safeSelection collapses provider duplicates to one pick per api_id', () => {
    const rows = [
        safe({ api_id: 7, provider: 'betpawa' }),
        safe({ api_id: 7, provider: 'betika' }),
        safe({ api_id: 8 }),
    ];
    const picks = safeSelection(rows, null);
    assert.deepEqual(picks.map(r => r.api_id), [7, 8]);
    assert.equal(picks[0].provider, 'betpawa'); // first row represents the fixture
});

test('safeSelection ranks by the pinned strategy and caps per day', () => {
    // Explicit strategy:'market' so market_prob decides (the shipped default is
    // now 'sure', which for one market + equal confidence would tie here).
    const rows = [3, 1, 4, 2, 5].map(i => safe({
        api_id: i,
        tip_breakdown: { market_prob: 0.72 + i * 0.01, stats_prob: 0.75, api_prob: 0.78 },
    }));
    const picks = safeSelection(rows, null, { strategy: 'market' });
    assert.deepEqual(picks.map(r => r.api_id), [5, 4, 3]); // top 3 by market_prob
    assert.deepEqual(safeSelection(rows, null, { strategy: 'market', maxPerDay: 1 }).map(r => r.api_id), [5]);
});

test('safeSelection honors an alternative ranking strategy', () => {
    // A leads on market_prob, B leads on agreement (min component)
    const a = safe({ api_id: 1, tip_breakdown: { market_prob: 0.9, stats_prob: 0.73, api_prob: 0.74 } });
    const b = safe({ api_id: 2, tip_breakdown: { market_prob: 0.8, stats_prob: 0.79, api_prob: 0.78 } });
    assert.deepEqual(safeSelection([a, b], null, { maxPerDay: 1 }).map(r => r.api_id), [1]);
    assert.deepEqual(safeSelection([a, b], null, { maxPerDay: 1, strategy: 'agreement' }).map(r => r.api_id), [2]);
});

test('safeSelection caps per day independently, using start_time when day is absent', () => {
    const rows = [
        safe({ api_id: 1, day: null, start_time: '2026-07-01T12:00:00.000Z' }),
        safe({ api_id: 2, day: null, start_time: '2026-07-01T14:00:00.000Z' }),
        safe({ api_id: 3, day: null, start_time: '2026-07-02T12:00:00.000Z' }),
    ];
    const picks = safeSelection(rows, null, { maxPerDay: 1 });
    assert.deepEqual(picks.map(r => r.api_id), [1, 3]); // one per day, day order
});

test('safeSelection groups start_time by the EAT day, not the UTC date', () => {
    // 21:00Z = midnight EAT the NEXT day; a UTC slice would split one date
    // into two groups and double the per-day cap (live bug, 2026-07-09).
    const rows = [
        safe({ api_id: 1, day: null, start_time: '2026-07-08T21:00:00.000Z' }), // 2026-07-09 00:00 EAT
        safe({ api_id: 2, day: null, start_time: '2026-07-09T12:00:00.000Z' }), // 2026-07-09 15:00 EAT
    ];
    const picks = safeSelection(rows, null, { maxPerDay: 1 });
    assert.equal(picks.length, 1); // same EAT day -> one group, cap holds
});

// --- slip math ---

test('slipSummary multiplies prices and probabilities', () => {
    const s = slipSummary([{ price: 1.5, prob: 0.8 }, { price: 1.3, prob: 0.7 }], 10);
    assert.equal(s.odds, 1.95);
    assert.equal(s.payout, 19.5);
    assert.equal(s.survival, 0.56);
    assert.equal(s.ev, _round(0.56 * 1.95 - 1));
});

test('slipSummary on an empty slip is the identity bet', () => {
    assert.deepEqual(slipSummary([], 25), { odds: 1, payout: 25, survival: 1, ev: 0 });
});

// --- simulateStrategies ---

// 6 days x exactly 4 candidates: every strategy builds the same slip, so
// the slip mechanics are observable without depending on strategy choice.
const SIX_DAYS = [];
for (let d = 1; d <= 6; d++) {
    for (let i = 0; i < 4; i++) {
        SIX_DAYS.push(row({
            day: `2026-07-0${d}`,
            tip_confidence: 0.8 - i * 0.05, // miss (when present) ranks last
            tip_outcome: d === 6 && i === 3 ? 'miss' : 'hit',
        }));
    }
}

test('simulateStrategies replays day-grouped top-4 slips at real prices', () => {
    const out = simulateStrategies(SIX_DAYS, { topN: 10 });
    const conf = out.strategies.find(s => s.id === 'confidence');
    assert.equal(out.sample.settled, 24);
    assert.equal(out.sample.days, 6);
    assert.equal(out.sample.eligible_days, 6);
    assert.equal(out.sample.sufficient, true); // 6 >= min_days 5
    assert.equal(conf.stats.days, 6);
    assert.equal(conf.stats.survived, 5); // day 6 slip contains the miss
    assert.equal(conf.stats.survival, _round(5 / 6));
    assert.equal(conf.stats.avg_odds, _round(1.3 ** 4));
    assert.equal(conf.stats.profit, _round(5 * (1.3 ** 4 - 1) - 1));
    assert.equal(conf.stats.roi, _round((5 * (1.3 ** 4 - 1) - 1) / 6));
    // day 6 top-quarter pick (1 of 4) is the highest-confidence hit
    assert.deepEqual(conf.stats.quartile, { n: 6, hits: 6, rate: 1 });
    assert.equal(conf.low_sample, false);
});

test('days below the leg count feed the quartile metric but never a slip', () => {
    const rows = [
        ...Array.from({ length: 4 }, (_, i) => row({ day: '2026-07-01', tip_confidence: 0.8 - i * 0.05 })),
        ...Array.from({ length: 3 }, (_, i) => row({ day: '2026-07-02', tip_confidence: 0.8 - i * 0.05 })),
    ];
    const conf = simulateStrategies(rows, { topN: 10 }).strategies.find(s => s.id === 'confidence');
    assert.equal(conf.stats.days, 1); // only the 4-tip day builds a slip
    assert.equal(conf.stats.quartile.n, 2); // ceil(4/4) + ceil(3/4)
});

test('vetoed tips are calibration evidence but never slip candidates', () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({
        day: '2026-07-01',
        tip_confidence: 0.8 - i * 0.05,
        tip_ai_verdict: i === 0 ? 'veto' : null, // best tip vetoed
        tip_outcome: 'hit',
    }));
    const out = simulateStrategies(rows, { topN: 10 });
    assert.equal(out.calibration.settled, 5); // vetoed still counted
    const conf = out.strategies.find(s => s.id === 'confidence');
    assert.equal(conf.stats.days, 1); // 4 non-vetoed candidates remain
    assert.equal(conf.stats.quartile.n, 1);
});

// Leave-one-day-out leak check, hand-computed (k = 10):
// Day 1: 4x cell H ('0.80+|double_chance', all hit) + 4x cell L
//        ('0.50-0.59|double_chance', 1 hit / 3 miss)   -> g(day1) = 5/8
// Day 2: 3x H (hit) + 1x L (hit) + 3x cell M ('0.60-0.69|over_under', all
//        miss). M exists ONLY on day 2.
// Scoring day 2 WITHOUT leak (cal = day 1): H = 10.25/14 = .732,
// M -> empty cell/band -> g = .625, L = 7.25/14 = .518. Top 4 = 3H + one M
// (a miss) -> the slip FAILS. A leaked calibration would rate
// M = 7.33/13 = .564 below L = 9.33/15 = .622, swap L in and survive.
test('leave-one-day-out calibration keeps a day from grading its own answers', () => {
    const H = o => row({ tip_confidence: 0.85, tip_market: '1X', ...o });
    const L = o => row({ tip_confidence: 0.55, tip_market: 'X2', ...o });
    const M = o => row({ tip_confidence: 0.65, tip_market: 'O 2.5', ...o });
    const rows = [
        ...Array.from({ length: 4 }, () => H({ day: '2026-07-01', tip_outcome: 'hit' })),
        L({ day: '2026-07-01', tip_outcome: 'hit' }),
        ...Array.from({ length: 3 }, () => L({ day: '2026-07-01', tip_outcome: 'miss' })),
        ...Array.from({ length: 3 }, () => H({ day: '2026-07-02', tip_outcome: 'hit' })),
        L({ day: '2026-07-02', tip_outcome: 'hit' }),
        ...Array.from({ length: 3 }, () => M({ day: '2026-07-02', tip_outcome: 'miss' })),
    ];
    const bucket = simulateStrategies(rows, { topN: 10 }).strategies.find(s => s.id === 'bucket');
    assert.equal(bucket.stats.days, 2);
    // Day 1 survives (top 4 = 4x H, scored on day-2 evidence); day 2 fails
    // because M legitimately looks like the global rate without the leak.
    assert.equal(bucket.stats.survived, 1);
    assert.equal(bucket.stats.survival, 0.5);
});

test('simulateStrategies is deterministic', () => {
    assert.deepEqual(simulateStrategies(SIX_DAYS), simulateStrategies(SIX_DAYS));
});

test('small samples degrade honestly: insufficient flag + low_sample marks', () => {
    const rows = [];
    for (let d = 1; d <= 3; d++) {
        for (let i = 0; i < 4; i++) rows.push(row({ day: `2026-07-0${d}`, tip_confidence: 0.8 - i * 0.05 }));
    }
    const out = simulateStrategies(rows);
    assert.equal(out.sample.sufficient, false); // 3 days < min_days 5
    assert.equal(out.strategies.length, 5);     // top-5 still served
    assert.ok(out.strategies.every(s => s.low_sample === true));
});

test('empty ledger yields a null-stat report without crashing', () => {
    const out = simulateStrategies([]);
    assert.equal(out.sample.settled, 0);
    assert.equal(out.sample.sufficient, false);
    assert.equal(out.strategies.length, 5);
    assert.equal(out.strategies[0].stats.days, 0);
    assert.equal(out.strategies[0].stats.survival, null);
    assert.deepEqual(out.strategies[0].stats.streak, { days: 0, avg: null, best: 0 });
    assert.equal(out.calibration.settled, 0);
});

test('report carries the documented shape', () => {
    const out = simulateStrategies(SIX_DAYS);
    assert.deepEqual(Object.keys(out), ['sample', 'strategies', 'calibration']);
    assert.deepEqual(Object.keys(out.sample), ['settled', 'days', 'eligible_days', 'min_days', 'sufficient']);
    assert.equal(out.strategies.length, 5);
    const s = out.strategies[0];
    assert.deepEqual(Object.keys(s), ['id', 'label', 'low_sample', 'stats']);
    assert.deepEqual(
        Object.keys(s.stats),
        ['days', 'survived', 'survival', 'profit', 'roi', 'avg_odds', 'quartile', 'streak'],
    );
    assert.deepEqual(Object.keys(s.stats.streak), ['days', 'avg', 'best']);
    assert.deepEqual(Object.keys(out.calibration), ['settled', 'global_rate', 'shrink_k', 'bands', 'groups', 'cells', 'lines', 'prices', 'markets']);
});

test('streak counts depth-before-first-miss from the top of each day', () => {
    // Day 1 ranked by confidence: hit, hit, miss, hit -> streak 2 (the hit
    // behind the miss must not count). Day 2: all four hit -> streak 4.
    const rows = [
        ...[0, 1, 2, 3].map(i => row({
            day: '2026-07-01', tip_confidence: 0.8 - i * 0.05,
            tip_outcome: i === 2 ? 'miss' : 'hit',
        })),
        ...[0, 1, 2, 3].map(i => row({ day: '2026-07-02', tip_confidence: 0.8 - i * 0.05 })),
    ];
    const conf = simulateStrategies(rows, { topN: 10 }).strategies.find(s => s.id === 'confidence');
    assert.deepEqual(conf.stats.streak, { days: 2, avg: 3, best: 4 });
});

// --- strategy ranking (survival -> quartile rate -> roi, a user decision) ---

test('strategies rank by survival, then quartile rate, then roi', () => {
    // 5 days x 5 candidates, engineered so 'confidence' (ranks the miss
    // last every day) survives more slips than 'edge' (chases the one
    // high-priced tip, which is the day's miss on days 4-5).
    const rows = [];
    for (let d = 1; d <= 5; d++) {
        for (let i = 0; i < 4; i++) {
            rows.push(row({ day: `2026-07-0${d}`, tip_confidence: 0.8 - i * 0.05, tip_outcome: 'hit' }));
        }
        // Low-confidence long shot: top edge score (0.5x3-1) but a miss late on
        rows.push(row({
            day: `2026-07-0${d}`, tip_confidence: 0.5, tip_price: 3,
            tip_outcome: d >= 4 ? 'miss' : 'hit',
        }));
    }
    const ids = simulateStrategies(rows, { topN: 20 }).strategies.map(s => s.id);
    assert.ok(ids.indexOf('confidence') < ids.indexOf('edge'),
        'higher survival must outrank');
});

test('replayed strategies always outrank never-replayed ones (day tier)', () => {
    // 5 one-tip days: no slips anywhere, quartile only - every strategy has
    // days=0, so the tier guard is exercised and id order decides.
    const rows = Array.from({ length: 5 }, (_, d) => row({ day: `2026-07-0${d + 1}` }));
    const out = simulateStrategies(rows, { topN: 20 });
    assert.ok(out.strategies.every(s => s.stats.days === 0));
    assert.deepEqual(
        out.strategies.map(s => s.id),
        [...out.strategies.map(s => s.id)].sort(),
        'all-equal metrics fall through to deterministic id order',
    );
});

// --- slipOutcome (betslip backtest grader) ---

test('slipOutcome: all legs hit -> won', () => {
    const legs = [
        { api_id: 1, outcome: 'hit' },
        { api_id: 2, outcome: 'hit' },
    ];
    assert.deepEqual(slipOutcome(legs), { state: 'won', settled: 2, total: 2, broken: [] });
});

test('slipOutcome: any miss -> lost immediately, names the broken legs', () => {
    const legs = [
        { api_id: 1, outcome: 'hit' },
        { api_id: 2, outcome: 'miss' },
        { api_id: 3, outcome: null }, // pending leg cannot save a broken slip
    ];
    assert.deepEqual(slipOutcome(legs), { state: 'lost', settled: 2, total: 3, broken: [2] });
});

test('slipOutcome: pending legs stay open; legacy legs without outcome are pending', () => {
    assert.deepEqual(
        slipOutcome([{ api_id: 1, outcome: 'hit' }, { api_id: 2 }]),
        { state: 'open', settled: 1, total: 2, broken: [] });
    assert.deepEqual(slipOutcome([]), { state: 'open', settled: 0, total: 0, broken: [] });
    assert.deepEqual(slipOutcome(null), { state: 'open', settled: 0, total: 0, broken: [] });
});

// --- slipTotals (playground totals bar) ---

test('slipTotals: staked/returned/profit over a mixed book at flat stake', () => {
    const slips = [
        // won: 2.0 x 1.5 = 3.0 odds -> returns 300 at stake 100
        { legs: [{ api_id: 1, price: 2.0, outcome: 'hit' }, { api_id: 2, price: 1.5, outcome: 'hit' }] },
        // lost: stake burned regardless of the pending leg
        { legs: [{ api_id: 3, price: 1.8, outcome: 'miss' }, { api_id: 4, price: 1.4 }] },
        // open: not settled, excluded from profit
        { legs: [{ api_id: 5, price: 1.6, outcome: 'hit' }, { api_id: 6, price: 1.3 }] },
    ];
    assert.deepEqual(slipTotals(slips, 100), {
        slips: 3, won: 1, lost: 1, open: 1,
        staked: 300, returned: 300,
        profit: 100, // 300 returned - 200 settled stakes; open stake not yet lost
        potential: 208, // open slip 1.6 x 1.3 = 2.08 odds -> 208 if it lands
    });
});

test('slipTotals: empty slip cards are not bets; empty/null input is all zeros', () => {
    const zero = { slips: 0, won: 0, lost: 0, open: 0, staked: 0, returned: 0, profit: 0, potential: 0 };
    assert.deepEqual(slipTotals([{ legs: [] }, { legs: null }], 50), zero);
    assert.deepEqual(slipTotals([], 50), zero);
    assert.deepEqual(slipTotals(null, 50), zero);
});

test('slipTotals: all-lost book is a pure negative of settled stakes', () => {
    const slips = [
        { legs: [{ api_id: 1, price: 3.0, outcome: 'miss' }] },
        { legs: [{ api_id: 2, price: 2.0, outcome: 'miss' }] },
    ];
    const t = slipTotals(slips, 25);
    assert.equal(t.returned, 0);
    assert.equal(t.profit, -50);
    assert.equal(t.staked, 50);
});

// --- buildSlips (playground autogeneration) ---

// Pool of 6 tips at increasing prices; ids double as sanity anchors.
const POOL = [
    { api_id: 1, price: 1.5 }, { api_id: 2, price: 1.4 }, { api_id: 3, price: 1.6 },
    { api_id: 4, price: 1.3 }, { api_id: 5, price: 2.0 }, { api_id: 6, price: 1.7 },
];
const slipIds = slips => slips.map(s => s.map(l => l.api_id));

test('buildSlips: no target chunks the whole pool into maxLegs-sized slips', () => {
    const out = buildSlips(POOL, { maxLegs: 4, targetOdds: 0, maxSlips: 0 });
    assert.deepEqual(slipIds(out), [[1, 2, 3, 4], [5, 6]]); // last slip takes the remainder
});

test('buildSlips: a slip closes early once combined odds reach targetOdds', () => {
    // 1.5 x 1.4 = 2.10 >= 2.0 -> close after 2 legs; then 1.6 x 1.3 = 2.08 -> close;
    // then 2.0 alone already >= 2.0 -> close; then 1.7 alone ends the pool.
    const out = buildSlips(POOL, { maxLegs: 4, targetOdds: 2.0, maxSlips: 0 });
    assert.deepEqual(slipIds(out), [[1, 2], [3, 4], [5], [6]]);
});

test('buildSlips: maxLegs is a hard cap even when target is unreachable', () => {
    const out = buildSlips(POOL, { maxLegs: 2, targetOdds: 100, maxSlips: 0 });
    assert.deepEqual(slipIds(out), [[1, 2], [3, 4], [5, 6]]);
});

test('buildSlips: maxSlips stops creation, leaving later tips unused', () => {
    const out = buildSlips(POOL, { maxLegs: 2, targetOdds: 0, maxSlips: 2 });
    assert.deepEqual(slipIds(out), [[1, 2], [3, 4]]); // ids 5,6 left out
});

test('buildSlips: pool exhausted before target leaves a final under-target slip', () => {
    const out = buildSlips([{ api_id: 1, price: 1.2 }, { api_id: 2, price: 1.1 }], { maxLegs: 4, targetOdds: 5 });
    assert.deepEqual(slipIds(out), [[1, 2]]); // 1.2 x 1.1 = 1.32 < 5, but the pool ran out
});

test('buildSlips: empty / non-array pool yields no slips', () => {
    assert.deepEqual(buildSlips([], { maxLegs: 4 }), []);
    assert.deepEqual(buildSlips(null, { maxLegs: 4 }), []);
});
