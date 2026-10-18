// Sharp-anchored Pick rules (src/db/anchor-rules.js): Pinnacle devig, the
// eligibility/evidence gates, one leg per fixture, the kickoff-committed
// daily card, the due moments and the forward report. Pure - no .env / DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_ANCHOR, ANCHOR_MARKETS, devigReference, bestKenyanPrices, hasEvidence, anchorLeg,
    selectAnchorCard, planReferenceDue, legUnits, anchorSummary, anchorPassBar,
} from '../src/db/anchor-rules.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('devigReference: multiplicative per complete group, incomplete groups dropped', () => {
    const f = devigReference({ 1: 2.0, X: 3.5, 2: 4.0, 'O 2.5': 1.9, 'U 2.5': 1.95, 'O 1.5': 1.2 });
    const s = 1 / 2 + 1 / 3.5 + 1 / 4;
    near(f['1'], 0.5 / s);
    near(f['1'] + f.X + f['2'], 1);
    near(f['O 2.5'] + f['U 2.5'], 1);
    assert.equal(f['O 1.5'], undefined);
    assert.deepEqual(devigReference({ 1: 2, X: 3 }), {});
});

test('vocabulary never holds O 0.5', () => {
    assert.ok(!ANCHOR_MARKETS.includes('O 0.5'));
});

test('bestKenyanPrices: lowest listing per provider, best across providers', () => {
    const k = bestKenyanPrices([
        { provider: 'betpawa', market: '1', price: '1.80' },
        { provider: 'betpawa', market: '1', price: '1.75' },
        { provider: 'betika', market: '1', price: '1.78' },
        { provider: 'betika', market: 'X', price: 3.4 },
        { provider: 'betika', market: '2', price: 1 },
    ]);
    assert.deepEqual(k, { 1: { price: 1.78, provider: 'betika' }, X: { price: 3.4, provider: 'betika' } });
});

test('hasEvidence: both teams need 10 finished games', () => {
    assert.equal(hasEvidence(10, 10), true);
    assert.equal(hasEvidence(9, 30), false);
    assert.equal(hasEvidence(30, null), false);
});

// Pinnacle 1 at 1.85 / X 3.6 / 2 4.6 -> fair(1) ~ 0.5226.
const reference = { 1: 1.85, X: 3.6, 2: 4.6, 'O 2.5': 2.0, 'U 2.5': 1.87 };

test('anchorLeg: eligible when price x fair >= 1.02, strong at 1.04', () => {
    const fair1 = devigReference(reference)['1'];
    const leg = anchorLeg({ kenyan: { 1: { price: 1.98, provider: 'betika' } }, reference, homeGames: 20, awayGames: 20 });
    assert.equal(leg.market, '1');
    assert.equal(leg.provider, 'betika');
    assert.equal(leg.refPrice, 1.85);
    near(leg.ratio, Math.round(1.98 * fair1 * 10000) / 10000);
    assert.equal(leg.strong, 1.98 * fair1 >= 1.04);
    // Just below 1.02 -> nothing.
    const p = Math.floor((1.019 / fair1) * 100) / 100;
    assert.equal(anchorLeg({ kenyan: { 1: { price: p, provider: 'x' } }, reference, homeGames: 20, awayGames: 20 }), null);
});

test('anchorLeg: price band 1.50-2.20 and the evidence gate drop silently', () => {
    const fair = devigReference(reference);
    const wide = { 2: { price: 5.5, provider: 'b' } };   // great ratio, outside the band
    assert.ok(5.5 * fair['2'] > 1.04);
    assert.equal(anchorLeg({ kenyan: wide, reference, homeGames: 20, awayGames: 20 }), null);
    const good = { 1: { price: 2.05, provider: 'b' } };
    assert.ok(anchorLeg({ kenyan: good, reference, homeGames: 20, awayGames: 20 }));
    assert.equal(anchorLeg({ kenyan: good, reference, homeGames: 9, awayGames: 20 }), null);
    assert.equal(anchorLeg({ kenyan: good, reference: {}, homeGames: 20, awayGames: 20 }), null);
});

test('anchorLeg: the highest ratio market wins', () => {
    const fair = devigReference(reference);
    const kenyan = { 1: { price: 2.0, provider: 'a' }, 'O 2.5': { price: 2.2, provider: 'b' } };
    const leg = anchorLeg({ kenyan, reference, homeGames: 20, awayGames: 20 });
    const best = 2.0 * fair['1'] > 2.2 * fair['O 2.5'] ? '1' : 'O 2.5';
    assert.equal(leg.market, best);
});

const L = (fixtureId, ratio, extra = {}) => ({ fixtureId, ratio, fair: 0.55, strong: ratio >= 1.04, frozen: false, onCard: false, ...extra });

test('selectAnchorCard: top 3, strong first, ratio desc', () => {
    const card = selectAnchorCard([L(1, 1.03), L(2, 1.05), L(3, 1.035), L(4, 1.10), L(5, 1.021)]);
    assert.deepEqual([...card].sort(), [2, 3, 4]);
    const strongFirst = selectAnchorCard([L(1, 1.039), L(2, 1.038), L(3, 1.037), L(4, 1.041)]);
    assert.ok(strongFirst.has(4));
});

test('selectAnchorCard: kicked-off card legs keep their slot; kicked-off non-card legs never join', () => {
    const legs = [
        L(1, 1.03, { frozen: true, onCard: true }),
        L(2, 1.20, { frozen: true, onCard: false }),   // better, but committed off-card
        L(3, 1.05), L(4, 1.06), L(5, 1.07),
    ];
    assert.deepEqual([...selectAnchorCard(legs)].sort(), [1, 4, 5]);
    assert.equal(selectAnchorCard(legs, { cardSize: 1 }).size, 1);
    assert.ok(selectAnchorCard(legs, { cardSize: 1 }).has(1));
});

test('planReferenceDue: T-3h and T-1h windows, once each, never after kickoff', () => {
    const H = 3_600_000, M = 60_000;
    const kick = 10 * H;
    const fx = (lastMs = null) => [{ id: 7, kickoffMs: kick, lastMs }];
    assert.deepEqual(planReferenceDue(kick - 3 * H - 2 * M, fx()).due, [{ id: 7, target: 't3h' }]);
    assert.deepEqual(planReferenceDue(kick - 3 * H + 4 * M, fx()).due, [{ id: 7, target: 't3h' }]);
    assert.equal(planReferenceDue(kick - 3 * H - 6 * M, fx()).due.length, 0);   // not open yet
    assert.equal(planReferenceDue(kick - 3 * H + 6 * M, fx()).due.length, 0);   // closed
    assert.equal(planReferenceDue(kick - 3 * H, fx(kick - 3 * H - 1 * M)).due.length, 0);   // already captured
    assert.deepEqual(planReferenceDue(kick - H, fx(kick - 3 * H)).due, [{ id: 7, target: 't1h' }]);
    assert.equal(planReferenceDue(kick, fx()).due.length, 0);
    const many = [1, 2, 3].map(i => ({ id: i, kickoffMs: kick + i * M, lastMs: null }));
    const p = planReferenceDue(kick - H, many, { cap: 2 });
    assert.equal(p.total, 3);
    assert.deepEqual(p.due.map(d => d.id), [1, 2]);
});

test('anchorSummary + legUnits: flat ROI with standard error, voids excluded', () => {
    near(legUnits({ outcome: 'hit', price: 1.9 }), 0.9);
    assert.equal(legUnits({ outcome: 'miss', price: 1.9 }), -1);
    assert.equal(legUnits({ outcome: 'void', price: 1.9 }), 0);
    const legs = [
        { price: 2.0, fair: 0.52, outcome: 'hit' },
        { price: 2.0, fair: 0.52, outcome: 'miss' },
        { price: 1.8, fair: 0.58, outcome: 'hit' },
        { price: 1.8, fair: 0.58, outcome: 'void' },
        { price: 1.8, fair: 0.58, outcome: null },
    ];
    const s = anchorSummary(legs);
    assert.equal(s.n, 3);
    assert.equal(s.hits, 2);
    near(s.units, 1 - 1 + 0.8);
    near(s.roi, 0.8 / 3);
    near(s.claim, (0.52 + 0.52 + 0.58) / 3);
    const u = [1, -1, 0.8], m = 0.8 / 3;
    near(s.se, Math.sqrt(u.reduce((a, x) => a + (x - m) ** 2, 0) / 2 / 3));
    near(s.lo95, s.roi - 1.96 * s.se);
    assert.equal(anchorSummary([]).roi, null);
});

test('anchorPassBar: every check must hold', () => {
    const ok = { n: 450, hitRate: 0.60, claim: 0.59, roi: 0.05, lo95: 0.001 };
    assert.equal(anchorPassBar(ok, 30).pass, true);
    assert.equal(anchorPassBar(ok, 29).pass, false);
    assert.equal(anchorPassBar({ ...ok, n: 399 }, 30).pass, false);
    assert.equal(anchorPassBar({ ...ok, lo95: -0.03 }, 30).pass, false);
    assert.equal(anchorPassBar({ ...ok, roi: 0 }, 30).pass, false);
    assert.equal(anchorPassBar({ ...ok, hitRate: 0.62, claim: 0.59 }, 30).pass, false);
    assert.equal(anchorPassBar({ n: 0, hitRate: null, claim: null, roi: null, lo95: null }, 0).pass, false);
    assert.equal(DEFAULT_ANCHOR.cardSize, 3);
});
