// Magic sort calculations (src/db/magic-rules.js): tip normalization,
// empirical calibration + shrinkage, ranking strategies, the day-grouped
// top-4 slip replay and the betslip math. Pure module - no .env/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    tipView, priceBand, computeCalibration, shrunkRate, estimateLegProb,
    STRATEGIES, scoreTip, magicSortRows, slipSummary, slipOutcome, slipTotals, simulateStrategies,
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
        ['days', 'survived', 'survival', 'profit', 'roi', 'avg_odds', 'quartile'],
    );
    assert.deepEqual(Object.keys(out.calibration), ['settled', 'global_rate', 'shrink_k', 'bands', 'groups', 'cells', 'lines', 'prices']);
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
    const ids = simulateStrategies(rows, { topN: 10 }).strategies.map(s => s.id);
    assert.ok(ids.indexOf('confidence') < ids.indexOf('edge'),
        'higher survival must outrank');
});

test('replayed strategies always outrank never-replayed ones (day tier)', () => {
    // 5 one-tip days: no slips anywhere, quartile only - every strategy has
    // days=0, so the tier guard is exercised and id order decides.
    const rows = Array.from({ length: 5 }, (_, d) => row({ day: `2026-07-0${d + 1}` }));
    const out = simulateStrategies(rows, { topN: 10 });
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
    });
});

test('slipTotals: empty slip cards are not bets; empty/null input is all zeros', () => {
    const zero = { slips: 0, won: 0, lost: 0, open: 0, staked: 0, returned: 0, profit: 0 };
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
