import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tipHitSafe } from '../src/db/tip-rules.js';
import { computeScorecard } from '../src/db/scorecard-rules.js';
import { formatScorecard } from '../scripts/ai-scorecard.js';

// ---------------------------------------------------------------------------
// Equivalence proof: the pre-refactor scripts/ai-scorecard.js carried a local
// settle(market, h, a) duplicating the canonical settler. scorecard-rules.js
// now uses tipHitSafe from src/db/tip-rules.js instead. This test proves the
// two agree over all 7 BLIND_MARKETS (src/db/ai-rules.js) under the mapping
// hit -> true / miss -> false / null -> null, and that 'void' never occurs
// for this market menu (no DNB in it) - REQUIRED before scorecard-rules.js
// is allowed to rely on tipHitSafe instead of a fifth settle() copy.
// ---------------------------------------------------------------------------

// The exact retired logic from scripts/ai-scorecard.js:49 (pre-refactor).
function oldSettle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case 'O 2.5': return tot > 2.5; case 'U 2.5': return tot < 2.5;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        default: return null;
    }
}

const BLIND_MARKETS = ['1', 'X', '2', 'O 2.5', 'U 2.5', 'GG', 'NG'];

// Representative final scores: 0-0 draw, low-scoring wins both directions,
// a high draw, over/under-2.5 boundary straddlers, BTTS both directions,
// blowouts.
const SCORES = [
    [0, 0], [1, 0], [0, 1], [1, 1], [2, 2],
    [2, 1], [1, 2], [3, 0], [0, 3], [2, 0], [0, 2],
    [3, 3], [4, 1], [1, 4], [5, 0], [0, 5], [10, 0],
];

test('tipHitSafe agrees with the retired local settle() on all 7 BLIND_MARKETS (equivalence proof)', () => {
    let compared = 0;
    for (const market of BLIND_MARKETS) {
        for (const [h, a] of SCORES) {
            const old = oldSettle(market, h, a);
            const now = tipHitSafe(market, h, a);
            assert.notEqual(now, 'void', `${market} ${h}-${a}: tipHitSafe returned 'void' - unreachable per spec (no DNB in BLIND_MARKETS)`);
            const mapped = now === 'hit' ? true : now === 'miss' ? false : null;
            assert.equal(mapped, old, `${market} ${h}-${a}: old settle()=${old}, tipHitSafe()=${now} (mapped ${mapped}) - DIVERGENCE`);
            compared++;
        }
    }
    // Sanity: this test must have actually exercised something.
    assert.equal(compared, BLIND_MARKETS.length * SCORES.length);
});

// ---------------------------------------------------------------------------
// Fixture-driven parity test: computeScorecard + formatScorecard against a
// hand-built {picks, insights} set, asserting BOTH the structured numbers
// and the exact printed text. The fixture below is mirrored 1:1 by
// scripts/ai-scorecard.js's pre-refactor logic (verified by hand replay
// during the refactor); this is the offline half of the parity proof, the
// live half being the before/after CLI diff run against the real DB.
// ---------------------------------------------------------------------------

const picks = [
    // S1 group "modelA": 2 confirms (1 hit, 1 miss), 1 veto (hit), 1 error.
    { fixture_id: 1, hot: 1, outcome: 'hit', over_price: 1.8, ai_verdict: 'confirm', ai_model: 'modelA', ai_review: null, tip_market: null, tip_price: null, tip_confidence: null, tip_outcome: null, tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null, day: '2026-07-10' },
    { fixture_id: 2, hot: 1, outcome: 'miss', over_price: 1.9, ai_verdict: 'confirm', ai_model: 'modelA', ai_review: null, tip_market: null, tip_price: null, tip_confidence: null, tip_outcome: null, tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null, day: '2026-07-10' },
    { fixture_id: 3, hot: 0, outcome: 'hit', over_price: 2.0, ai_verdict: 'veto', ai_model: 'modelA', ai_review: null, tip_market: null, tip_price: null, tip_confidence: null, tip_outcome: null, tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null, day: '2026-07-11' },
    { fixture_id: 4, hot: 1, outcome: 'miss', over_price: 1.5, ai_verdict: 'error', ai_model: 'modelA', ai_review: null, tip_market: null, tip_price: null, tip_confidence: null, tip_outcome: null, tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null, day: '2026-07-11' },
    // Settled hot pick with NO verdict at all - counts toward S1's coverage
    // note and S5's denominator, but never enters a group.
    { fixture_id: 5, hot: 1, outcome: 'hit', over_price: 1.7, ai_verdict: null, ai_model: null, ai_review: null, tip_market: null, tip_price: null, tip_confidence: null, tip_outcome: null, tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null, day: '2026-07-12' },
    // S2 group "tipModelX": 2 confirms (1 hit, 1 miss), 1 veto (hit, decided),
    // 1 error that is ALSO a DNB void (excluded from decided/confirm/veto but
    // still counted in errors + drift, matching the pre-refactor script).
    { fixture_id: 6, hot: 0, outcome: null, over_price: null, ai_verdict: null, ai_model: null, ai_review: null, tip_market: 'O 2.5', tip_price: 1.8, tip_confidence: 0.7, tip_outcome: 'hit', tip_ai_verdict: 'confirm', tip_ai_model: 'tipModelX', tip_ai_review: JSON.stringify({ judged: { tip_price: 1.75 } }), day: '2026-07-10' },
    { fixture_id: 7, hot: 0, outcome: null, over_price: null, ai_verdict: null, ai_model: null, ai_review: null, tip_market: '1', tip_price: 2.1, tip_confidence: 0.6, tip_outcome: 'miss', tip_ai_verdict: 'confirm', tip_ai_model: 'tipModelX', tip_ai_review: JSON.stringify({ judged: { tip_price: 2.0 } }), day: '2026-07-10' },
    { fixture_id: 8, hot: 0, outcome: null, over_price: null, ai_verdict: null, ai_model: null, ai_review: null, tip_market: 'X2', tip_price: 1.6, tip_confidence: 0.55, tip_outcome: 'hit', tip_ai_verdict: 'veto', tip_ai_model: 'tipModelX', tip_ai_review: null, day: '2026-07-11' },
    { fixture_id: 9, hot: 0, outcome: null, over_price: null, ai_verdict: null, ai_model: null, ai_review: null, tip_market: 'DNB1', tip_price: 1.5, tip_confidence: 0.65, tip_outcome: 'void', tip_ai_verdict: 'error', tip_ai_model: 'tipModelX', tip_ai_review: JSON.stringify({ judged: { tip_price: 1.5 } }), day: '2026-07-11' },
    // S4-only row: an error verdict on a day with no other activity (outcome
    // stays null so it never enters hotSettled/S1/S5).
    { fixture_id: 10, hot: 0, outcome: null, over_price: null, ai_verdict: 'error', ai_model: 'modelA', ai_review: null, tip_market: null, tip_price: null, tip_confidence: null, tip_outcome: null, tip_ai_verdict: null, tip_ai_model: null, tip_ai_review: null, day: '2026-07-09' },
];

const insights = [
    { model_tag: 'blindModelY', payload: JSON.stringify({ probabilities: { '1': 0.55, 'X': 0.25, '2': 0.15, 'O 2.5': 0.65, 'U 2.5': 0.35, 'GG': 0.85, 'NG': 0.15 } }), ft_home: 2, ft_away: 1 },
    // No probabilities at all - must be skipped, not crash.
    { model_tag: 'blindModelY', payload: JSON.stringify({ probabilities: {} }), ft_home: 0, ft_away: 0 },
];

const TIP_AI_MIN_CONFIDENCE = 0.6;
const TIP_AI_REUSE_PRICE_TOL = 0.05;

test('computeScorecard: S1 groups confirm/veto/error correctly and counts no-verdict coverage', () => {
    const summary = computeScorecard({ picks, insights, tipAiMinConfidence: TIP_AI_MIN_CONFIDENCE, tipAiReusePriceTol: TIP_AI_REUSE_PRICE_TOL });
    assert.equal(summary.s1.groups.length, 1);
    const g = summary.s1.groups[0];
    assert.equal(g.tag, 'modelA');
    assert.equal(g.n, 4);
    assert.deepEqual(g.confirm, { n: 2, rate: 0.5 });
    assert.deepEqual(g.veto, { n: 1, rate: 1 });
    assert.equal(g.errors, 1);
    assert.equal(g.saved, -1); // the veto hit at price 2.0 -> profit +1.0 -> saved = -1.0
    assert.equal(summary.s1.noVerdict, 1);
    assert.equal(summary.s1.settledTotal, 5);
});

test('computeScorecard: S2 excludes void rows from decided but keeps them in errors/drift', () => {
    const summary = computeScorecard({ picks, insights, tipAiMinConfidence: TIP_AI_MIN_CONFIDENCE, tipAiReusePriceTol: TIP_AI_REUSE_PRICE_TOL });
    assert.equal(summary.s2.groups.length, 1);
    const g = summary.s2.groups[0];
    assert.equal(g.tag, 'tipModelX');
    assert.equal(g.n, 3); // decided excludes the void row
    assert.deepEqual(g.confirm, { n: 2, rate: 0.5 });
    assert.deepEqual(g.veto, { n: 1, rate: 1 });
    assert.equal(g.errors, 1); // the void row's tip_ai_verdict='error' still counts
    assert.equal(g.drift.n, 3); // the void row's judged context still counts (1 skipped: null review)
    assert.equal(summary.s2.tol, 0.05);
});

test('computeScorecard: S3 bins settle via tipHitSafe and skip probability-less insight rows', () => {
    const summary = computeScorecard({ picks, insights, tipAiMinConfidence: TIP_AI_MIN_CONFIDENCE, tipAiReusePriceTol: TIP_AI_REUSE_PRICE_TOL });
    assert.equal(summary.s3.hasTerms, true);
    assert.equal(summary.s3.groups.length, 1);
    const g = summary.s3.groups[0];
    assert.equal(g.tag, 'blindModelY');
    assert.equal(g.n, 7); // all 7 BLIND_MARKETS from the one insight row with probabilities
    assert.equal(Number(g.brier.toFixed(4)), 0.0825);
    assert.equal(g.bins.length, 5); // one non-empty bin per 0.2-wide slice
});

test('computeScorecard: S4 groups error verdicts by day, sorted', () => {
    const summary = computeScorecard({ picks, insights, tipAiMinConfidence: TIP_AI_MIN_CONFIDENCE, tipAiReusePriceTol: TIP_AI_REUSE_PRICE_TOL });
    assert.equal(summary.s4.hasErrors, true);
    assert.deepEqual(summary.s4.days, [
        { day: '2026-07-09', hot: 1, tip: 0 },
        { day: '2026-07-11', hot: 1, tip: 1 },
    ]);
});

test('computeScorecard: S5 coverage denominator is gated by tipAiMinConfidence', () => {
    const summary = computeScorecard({ picks, insights, tipAiMinConfidence: TIP_AI_MIN_CONFIDENCE, tipAiReusePriceTol: TIP_AI_REUSE_PRICE_TOL });
    assert.equal(summary.s5.tipAiMinConfidence, 0.6);
    assert.deepEqual(summary.s5.days, [
        { day: '2026-07-10', hot: { covered: 2, total: 2 }, tip: { covered: 2, total: 2 } },
        { day: '2026-07-11', hot: { covered: 2, total: 2 }, tip: { covered: 1, total: 1 } }, // the 0.55-confidence veto row is below the 0.6 floor, excluded from tip
        { day: '2026-07-12', hot: { covered: 0, total: 1 }, tip: null },
    ]);
});

// The exact ground-truth text, derived by replaying the ORIGINAL (pre-
// refactor) scripts/ai-scorecard.js algorithm against this same fixture in
// an isolated scratch script (not part of the shipped codebase) - a
// hand-computation would be too error-prone for the padded S3/S5 columns.
const EXPECTED = [
    '############ S1 — hot-pick adjudicator (settled, per model tag) ############',
    '  modelA  [UNDERPOWERED < 40]',
    '    confirm 2 hit 50.0% | veto 1 hit 100.0% (following vetoes saved -1.00u) | error 1',
    '  settled hot rows without any verdict: 1 of 5 (coverage detail in S5)',
    '',
    '############ S2 — tip reviewer (settled, per model tag) ############',
    '  tipModelX  [UNDERPOWERED < 40]',
    '    confirm 2 hit 50.0% | veto 1 hit 100.0% (following vetoes saved -0.60u) | error 1',
    '    price drift vs judged: n=3 mean 2.6% max 5.0% (tol 5.0%; legacy verdicts carry no judged context)',
    '',
    '############ S3 — blind reasoner calibration (settled, per model tag) ############',
    '  blindModelY: 7 (fixture,market) terms  [UNDERPOWERED < 40]',
    '    Brier 0.0825 (0.25 = coin-flip on a balanced menu; lower is better)',
    '    bin        n   mean(p)  realized   (aligned columns = well calibrated)',
    '    [0.0,0.2)     2    15.0%     0.0%',
    '    [0.2,0.4)     2    30.0%     0.0%',
    '    [0.4,0.6)     1    55.0%   100.0%',
    '    [0.6,0.8)     1    65.0%   100.0%',
    '    [0.8,1.0)     1    85.0%   100.0%',
    '',
    '############ S4 — error verdicts per day (transport/parse/guard health) ############',
    '  2026-07-09: hot 1, tip 0 (errors re-fire next drain; sustained runs trip the breaker)',
    '  2026-07-11: hot 1, tip 1 (errors re-fire next drain; sustained runs trip the breaker)',
    '',
    '############ S5 — verdict coverage per day (settled rows; NULL = missed the kickoff freeze) ############',
    '  tips scoped to confidence >= TIP_AI_MIN_CONFIDENCE (0.6); hot = hot pick or stored verdict.',
    '  day          hot covered      tips covered',
    '  2026-07-10   2/2 (100.0%)     2/2 (100.0%)',
    '  2026-07-11   2/2 (100.0%)     1/1 (100.0%)',
    '  2026-07-12   0/1 (0.0%)       -',
    '',
    '  READ: coverage < 100% = rows that kicked off before the worker reached them (the',
    '  freeze forbids post-kickoff adjudication - leakage would resemble brilliance).',
    '  Pre-worker history (before 2026-07-17) settled largely uncovered by design.',
].join('\n');

test('formatScorecard(computeScorecard(fixture)) matches the pre-refactor CLI output byte-for-byte', () => {
    const summary = computeScorecard({ picks, insights, tipAiMinConfidence: TIP_AI_MIN_CONFIDENCE, tipAiReusePriceTol: TIP_AI_REUSE_PRICE_TOL });
    const text = formatScorecard(summary);
    assert.equal(text, EXPECTED);
});

test('computeScorecard: empty picks/insights produce well-formed empty structure, no throw', () => {
    const summary = computeScorecard({ picks: [], insights: [], tipAiMinConfidence: 0.75, tipAiReusePriceTol: 0 });
    assert.deepEqual(summary.s1, { groups: [], noVerdict: 0, settledTotal: 0 });
    assert.deepEqual(summary.s2, { groups: [], tol: 0 });
    assert.deepEqual(summary.s3, { hasTerms: false, groups: [] });
    assert.deepEqual(summary.s4, { hasErrors: false, days: [] });
    assert.deepEqual(summary.s5, { tipAiMinConfidence: 0.75, days: [] });
});
