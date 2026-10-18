import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactBreakdown, leanRecord, resolveMarketSelection, LAZY_FIELDS } from '../src/db/lean-rules.js';
import { safeQualifies, hasSufficientStats, estimateLegProb, legPicks, tipView, scoreTip } from '../src/db/magic-rules.js';

// A tip_breakdown shaped like the live ones (2026-10-17 sample keys).
const fullBreakdown = () => ({
    market: '1X', price: 1.45, confidence: 0.74,
    market_prob: 0.71, stats_prob: 0.78, api_prob: 0.69,
    weights: { market: 0.5, stats: 0.3, api: 0.2 }, book_overround: 1.06,
    samples: { home_n: 6, away_n: 6, h2h_n: 3 }, stats_gap: 0.07, rung_gap: 0.02,
    runners_up: [
        { market: 'U 3.5', price: 1.3, confidence: 0.72, market_prob: 0.7, stats_prob: 0.75, api_prob: null, weights: { market: 0.6 } },
        { market: 'O 1.5', price: 1.35, confidence: 0.7, market_prob: 0.69, stats_prob: 0.71, api_prob: 0.68, weights: {} },
        { market: 'BTTS:no', price: 1.9, confidence: 0.5, market_prob: 0.5, stats_prob: 0.5, api_prob: 0.5 },
    ],
});
const fullRow = () => ({
    match_id: 11, api_id: 7, provider: 'betpawa', start_time: '2026-10-17T12:00:00.000Z',
    tip_market: '1X', tip_price: 1.45, tip_confidence: 0.74, tip_outcome: null,
    tip_breakdown: fullBreakdown(),
    hot_signals: [{ key: 'home_sample', value: 6, threshold: 6, pass: true }],
    hot_review: { verdict: 'confirm' }, tip_ai_review: { verdict: 'confirm' },
    h2h_meetings: [{ date: '2025-01-01', home: 'A', away: 'B', score: '1-0' }],
    h2h_count: 3, markets: { '1X': 1.45 }, markets_stale: {},
});
const CAL = {
    markets: { '1X': { n: 40, hits: 30 } },
    leg_cells: { cells: { 'DC|1.50': { n: 50, hits: 38 } } },
};

test('compactBreakdown keeps the scorer keys and the first two runners-up', () => {
    const c = compactBreakdown(fullBreakdown());
    assert.deepEqual(Object.keys(c).sort(), ['api_prob', 'confidence', 'market', 'market_prob', 'price', 'runners_up', 'samples', 'stats_prob']);
    assert.equal(c.runners_up.length, 2);
    assert.deepEqual(c.runners_up[0], { market: 'U 3.5', price: 1.3, confidence: 0.72, market_prob: 0.7, stats_prob: 0.75, api_prob: null });
    assert.deepEqual(c.samples, { home_n: 6, away_n: 6, h2h_n: 3 });
});

test('compactBreakdown passes null and non-objects through', () => {
    assert.equal(compactBreakdown(null), null);
    assert.equal(compactBreakdown(undefined), null);
    assert.equal(compactBreakdown('x'), 'x');
});

test('a lean row scores exactly like the full row in every shared scorer', () => {
    const full = fullRow();
    const lean = leanRecord(full);
    for (const opts of [{}, { minParts: 3 }, { minSamples: 7 }, { minH2H: 4 }]) {
        assert.equal(safeQualifies(lean, opts, CAL), safeQualifies(full, opts, CAL));
        assert.equal(hasSufficientStats(lean, opts), hasSufficientStats(full, opts));
    }
    assert.equal(estimateLegProb(tipView(lean), CAL), estimateLegProb(tipView(full), CAL));
    assert.deepEqual(legPicks(lean, CAL), legPicks(full, CAL));
    for (const id of ['banker', 'sure', 'target', 'value', 'agreement']) {
        assert.equal(scoreTip(lean, id, CAL), scoreTip(full, id, CAL), id);
    }
});

test('leanRecord drops the lazy fields and leaves the rest untouched', () => {
    const full = fullRow();
    const lean = leanRecord(full);
    for (const f of LAZY_FIELDS) assert.equal(f in lean, false, f);
    assert.equal(lean.h2h_count, 3);
    assert.deepEqual(lean.markets, full.markets);
    assert.ok(full.hot_signals, 'the input row is not mutated');
});

test('leanRecord keeps a redacted (null) breakdown null', () => {
    assert.equal(leanRecord({ ...fullRow(), tip_breakdown: null }).tip_breakdown, null);
});

const ALLOWED = new Set(['1X', 'O 2.5', 'U 3.5', 'BTTS:yes']);
const DEFAULTS = new Set(['1X', 'O 2.5']);

test('resolveMarketSelection: absent is the legacy full catalog, all is everything', () => {
    assert.deepEqual(resolveMarketSelection(null, ALLOWED, DEFAULTS), { allow: ALLOWED, canonical: null, subset: false });
    assert.deepEqual(resolveMarketSelection('all', ALLOWED, DEFAULTS), { allow: null, canonical: 'all', subset: false });
});

test('resolveMarketSelection canonicalises order and the default set', () => {
    const a = resolveMarketSelection('O 2.5,1X', ALLOWED, DEFAULTS);
    assert.equal(a.canonical, 'default');
    assert.equal(resolveMarketSelection('default', ALLOWED, DEFAULTS).canonical, 'default');
    // a non-market extra (a stats key from the sort chain) still lands on default
    assert.equal(resolveMarketSelection('default,home_rank', ALLOWED, DEFAULTS).canonical, 'default');
    const b = resolveMarketSelection('U 3.5,default', ALLOWED, DEFAULTS);
    assert.equal(b.canonical, '1X,O 2.5,U 3.5');
    assert.deepEqual([...b.allow], ['1X', 'O 2.5', 'U 3.5']);
    assert.equal(resolveMarketSelection('U 3.5, 1X ,U 3.5', ALLOWED, DEFAULTS).canonical, '1X,U 3.5');
});

test('resolveMarketSelection: an empty selection never collides with the legacy slot', () => {
    const r = resolveMarketSelection('nope', ALLOWED, DEFAULTS);
    assert.equal(r.canonical, 'none');
    assert.equal(r.allow.size, 0);
});

test('resolveMarketSelection without a catalog takes the list as given', () => {
    assert.equal(resolveMarketSelection('b,a', null, null).canonical, 'a,b');
});
