// M4.2 emergence-pattern mining rules (src/db/mine-rules.js). Pure module -
// these tests run with no .env, no DB and no network. The bootstrap test is
// the load-bearing one: it asserts we resample DAYS, not rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    temporalSplit, benjaminiHochberg, dayClusteredBootstrap,
    configSignature, runnerUpMarkets, hasStraddle, cascadeLadder, LADDER_LINES,
    blendParts, missProfile, consensusProxies,
} from '../src/db/mine-rules.js';

// Real breakdown captured from the warehouse on 2026-07-16 (tmp/m42-probe2.mjs)
const REAL_VIEW = {
    market: 'U 3.5', price: 1.54, confidence: 0.663, outcome: 'hit', vetoed: false,
    breakdown: {
        market: 'U 3.5', price: 1.54, confidence: 0.663,
        market_prob: 0.6111, stats_prob: 0.7667, api_prob: null,
        weights: { market: 0.6667, stats: 0.3333, api: null },
        samples: { home_n: 6, away_n: 6, h2h_n: 5 },
        runners_up: [
            { market: 'O 2.5', price: 1.59, confidence: 0.5696, market_prob: 0.5934, stats_prob: 0.5222, api_prob: null },
            { market: '1', price: 1.66, confidence: 0.543, market_prob: 0.5745, stats_prob: 0.5111, api_prob: 0.45 },
        ],
    },
};

test('temporalSplit cuts on day boundaries, oldest 70% train', () => {
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
        '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
    const { train, test: te } = temporalSplit(days, 0.7);
    assert.equal(train.length, 7);
    assert.equal(te.length, 3);
    assert.equal(train.at(-1), '2026-07-07');
    assert.equal(te[0], '2026-07-08');
});

test('temporalSplit sorts unsorted input before cutting', () => {
    const { train, test: te } = temporalSplit(['2026-07-03', '2026-07-01', '2026-07-02'], 0.7);
    assert.deepEqual(train, ['2026-07-01', '2026-07-02']);
    assert.deepEqual(te, ['2026-07-03']);
});

test('temporalSplit degenerates safely on tiny/empty input', () => {
    assert.deepEqual(temporalSplit([], 0.7), { train: [], test: [] });
    assert.deepEqual(temporalSplit(['2026-07-01'], 0.7), { train: ['2026-07-01'], test: [] });
});

// Benjamini & Hochberg (1995) worked example, q=0.05 -> reject the two smallest.
test('benjaminiHochberg matches the canonical worked example', () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    assert.deepEqual(benjaminiHochberg(p, 0.05),
        [true, true, false, false, false, false, false, false, false, false]);
});

test('benjaminiHochberg returns rejections in INPUT order, not sorted order', () => {
    // same p-values shuffled: the two smallest (0.001, 0.008) sit at index 3 and 0
    const p = [0.008, 0.216, 0.039, 0.001, 0.212];
    assert.deepEqual(benjaminiHochberg(p, 0.05), [true, false, false, true, false]);
});

// BH is a step-UP procedure: an interior rank may fail its OWN threshold and
// still be rejected, because a LATER rank passed. Here rank 2 (p=0.04) fails
// its 0.0333 threshold, but rank 3 (p=0.05) passes its 0.05 -> all three
// reject. A naive "stop at the first failure" loop would return [true,f,f].
test('benjaminiHochberg is a step-UP procedure, not first-failure-wins', () => {
    const p = [0.001, 0.04, 0.05];
    assert.deepEqual(benjaminiHochberg(p, 0.05), [true, true, true]);
});

test('benjaminiHochberg rejects nothing at q=0 or when all p are 1', () => {
    assert.deepEqual(benjaminiHochberg([0.001, 0.002], 0), [false, false]);
    assert.deepEqual(benjaminiHochberg([1, 1, 1], 0.1), [false, false, false]);
    assert.deepEqual(benjaminiHochberg([], 0.1), []);
});

// THE load-bearing test. Two days, perfectly split outcomes. Resampling DAYS
// can draw {A,A}=1.0, {A,B}=0.5, {B,B}=0.0 -> the CI must span nearly [0,1].
// A row-level resampler would report ~0.5 +/- 0.07 and fake precision we do
// not have. This test is the difference between honest and confident-wrong.
test('dayClusteredBootstrap resamples days, not rows', () => {
    const rows = [
        ...Array.from({ length: 50 }, () => ({ day: 'A', hit: 1 })),
        ...Array.from({ length: 50 }, () => ({ day: 'B', hit: 0 })),
    ];
    const rate = rs => (rs.length ? rs.reduce((s, r) => s + r.hit, 0) / rs.length : null);
    const { point, lo, hi } = dayClusteredBootstrap(rows, rate, { draws: 500, seed: 7 });
    assert.equal(point, 0.5);
    assert.ok(lo <= 0.01, `day-clustered lo should reach ~0, got ${lo}`);
    assert.ok(hi >= 0.99, `day-clustered hi should reach ~1, got ${hi}`);
});

test('dayClusteredBootstrap is deterministic for a given seed', () => {
    const rows = [
        ...Array.from({ length: 20 }, (_, i) => ({ day: 'A', hit: i % 2 })),
        ...Array.from({ length: 20 }, (_, i) => ({ day: 'B', hit: i % 3 ? 1 : 0 })),
        ...Array.from({ length: 20 }, (_, i) => ({ day: 'C', hit: i % 4 ? 0 : 1 })),
    ];
    const rate = rs => (rs.length ? rs.reduce((s, r) => s + r.hit, 0) / rs.length : null);
    const a = dayClusteredBootstrap(rows, rate, { draws: 200, seed: 42 });
    const b = dayClusteredBootstrap(rows, rate, { draws: 200, seed: 42 });
    assert.deepEqual(a, b);
});

test('dayClusteredBootstrap returns nulls on empty input', () => {
    assert.deepEqual(dayClusteredBootstrap([], () => null, { draws: 10, seed: 1 }),
        { point: null, lo: null, hi: null });
});

test('configSignature renders winner first, then runners-up in order', () => {
    assert.equal(configSignature(REAL_VIEW), 'U 3.5|O 2.5|1');
});

test('configSignature is total on malformed / absent breakdown', () => {
    assert.equal(configSignature(null), null);
    assert.equal(configSignature({ market: 'O 2.5', breakdown: null }), null);
    assert.equal(configSignature({ market: 'O 2.5', breakdown: {} }), null);
    assert.equal(configSignature({ market: 'O 2.5', breakdown: { runners_up: [] } }), null);
    assert.equal(configSignature({ market: 'O 2.5', breakdown: { runners_up: 'junk' } }), null);
    assert.equal(configSignature({ market: null, breakdown: { runners_up: [{ market: '1' }] } }), null);
    // a runner-up with no market key must not render "undefined"
    assert.equal(configSignature({ market: 'O 2.5', breakdown: { runners_up: [{ price: 2 }] } }), null);
});

test('runnerUpMarkets returns [] rather than throwing on junk', () => {
    assert.deepEqual(runnerUpMarkets(REAL_VIEW), ['O 2.5', '1']);
    assert.deepEqual(runnerUpMarkets(null), []);
    assert.deepEqual(runnerUpMarkets({ breakdown: { runners_up: [{ market: 5 }] } }), []);
});

// The user's own observation: runners-up "2:O 3.5, 3:U 3.5" => high-scoring.
test('hasStraddle detects an O k / U k pair on the SAME line', () => {
    const straddle = { market: '1', breakdown: { runners_up: [{ market: 'O 3.5' }, { market: 'U 3.5' }] } };
    assert.equal(hasStraddle(straddle), true);
});

test('hasStraddle rejects O/U pairs on DIFFERENT lines', () => {
    const mixed = { market: '1', breakdown: { runners_up: [{ market: 'O 3.5' }, { market: 'U 2.5' }] } };
    assert.equal(hasStraddle(mixed), false);
});

test('hasStraddle is false without a pair, and total on junk', () => {
    assert.equal(hasStraddle(REAL_VIEW), false);
    assert.equal(hasStraddle(null), false);
    assert.equal(hasStraddle({ breakdown: { runners_up: [] } }), false);
});

test('cascadeLadder marks every line the fixture actually cleared', () => {
    const view = { market: 'O 2.5', breakdown: {} };
    const l = cascadeLadder(view, 2, 1); // 3 goals
    assert.equal(l.tipLine, 2.5);
    assert.equal(l.total, 3);
    assert.equal(l.cleared['0.5'], true);
    assert.equal(l.cleared['1.5'], true);
    assert.equal(l.cleared['2.5'], true);
    assert.equal(l.cleared['3.5'], false);
    assert.equal(l.cleared['4.5'], false);
});

test('cascadeLadder uses strict > at the boundary (2 goals does NOT clear O 2.5)', () => {
    const l = cascadeLadder({ market: 'O 2.5', breakdown: {} }, 1, 1); // 2 goals
    assert.equal(l.cleared['1.5'], true);
    assert.equal(l.cleared['2.5'], false);
});

test('cascadeLadder returns null for non-Over markets and null scores', () => {
    assert.equal(cascadeLadder({ market: 'U 3.5', breakdown: {} }, 1, 1), null);
    assert.equal(cascadeLadder({ market: '1X', breakdown: {} }, 1, 1), null);
    assert.equal(cascadeLadder({ market: 'O 2.5', breakdown: {} }, null, 1), null);
    assert.equal(cascadeLadder({ market: 'O 2.5', breakdown: {} }, 1, undefined), null);
    assert.equal(cascadeLadder(null, 1, 1), null);
});

test('LADDER_LINES is the frozen ladder', () => {
    assert.deepEqual(LADDER_LINES, [0.5, 1.5, 2.5, 3.5, 4.5]);
});

test('blendParts counts only components that are actually present', () => {
    assert.equal(blendParts(REAL_VIEW), 2); // api_prob is null - 2-part blends are the majority
    assert.equal(blendParts({ breakdown: { market_prob: 0.5, stats_prob: 0.5, api_prob: 0.5 } }), 3);
    assert.equal(blendParts({ breakdown: {} }), 0);
    assert.equal(blendParts(null), 0);
});

test('missProfile reuses the shared labellers, never a new taxonomy', () => {
    const p = missProfile(REAL_VIEW);
    assert.equal(p.market, 'U 3.5');
    assert.equal(p.group, 'over_under');   // perf-rules marketGroup
    assert.equal(p.band, '1.35-1.54');     // magic-rules priceBand (1.54)
    assert.equal(p.parts, 2);
    assert.equal(p.thin, false);           // home_n 6 / away_n 6 >= 6
});

test('missProfile flags thin evidence from the persisted samples', () => {
    const thin = { market: 'O 2.5', price: 1.5, breakdown: { samples: { home_n: 3, away_n: 6, h2h_n: 0 } } };
    assert.equal(missProfile(thin).thin, true);
});

test('missProfile treats a sample-less row as thin, and is total on junk', () => {
    assert.equal(missProfile({ market: 'O 2.5', price: 1.5, breakdown: {} }).thin, true);
    assert.equal(missProfile(null), null);
    assert.equal(missProfile({ market: null }), null);
});

test('consensusProxies exposes the market-vs-stats spread (the thesis lens)', () => {
    const c = consensusProxies(REAL_VIEW);
    // |0.6111 - 0.7667| = 0.1556 -> our stats DISAGREE with the market here
    assert.ok(Math.abs(c.spread - 0.1556) < 1e-4, `spread was ${c.spread}`);
    assert.equal(c.band, '1.35-1.54');
    assert.equal(c.parts, 2);
    assert.equal(c.aiVerdict, null);
    // tipAgreement = min of present parts = min(0.6111, 0.7667)
    assert.ok(Math.abs(c.agreement - 0.6111) < 1e-4, `agreement was ${c.agreement}`);
});

test('consensusProxies spread is null when a component is missing', () => {
    const c = consensusProxies({ market: '1', price: 2, breakdown: { market_prob: 0.5, stats_prob: null } });
    assert.equal(c.spread, null);
});

test('consensusProxies carries the AI verdict through for the (underpowered) lens', () => {
    const v = { ...REAL_VIEW, vetoed: true };
    assert.equal(consensusProxies(v).aiVerdict, 'veto');
    assert.equal(consensusProxies({ ...REAL_VIEW, vetoed: false }).aiVerdict, null);
});

test('consensusProxies is total on junk', () => {
    assert.equal(consensusProxies(null), null);
    assert.equal(consensusProxies({ market: null }), null);
});
