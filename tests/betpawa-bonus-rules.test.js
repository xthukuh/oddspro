import { test } from 'node:test';
import assert from 'node:assert/strict';
import { betpawaWinBonus } from '../src/db/betpawa-bonus-rules.js';

const mk = a => a.map(([price, winProbability]) => ({ price, winProbability }));

// Expected values were produced 2026-10-15 by BetPawa's own v5
// DynamicBonusCalculator, executed in its page with the live config.
const SITE_V5 = [
    { legs: mk([[1.82, 0.514], [1.5, 0.631], [1.23, 0.776]]), totalOdds: 3.52, pct: 0.07 },
    { legs: mk([[1.6, 0.59], [1.45, 0.65], [1.3, 0.73], [2.1, 0.45]]), totalOdds: 6.81, pct: 0.09 },
    { legs: mk(Array.from({ length: 12 }, (_, i) => [+(1.3 + 0.05 * i).toFixed(2), +(0.95 / (1.3 + 0.05 * i)).toFixed(4)])), totalOdds: 313.67, pct: 0.45 },
    { legs: mk(Array.from({ length: 30 }, () => [1.25, 0.77])), totalOdds: 2139, pct: 1.65 },
];

test('betpawaWinBonus reproduces the site v5 calculator on all-eligible slips', () => {
    for (const s of SITE_V5) {
        const r = betpawaWinBonus(s.legs);
        assert.equal(r.bonusPct, s.pct);
        assert.equal(Math.floor(r.totalOdds * 100 + 1e-9) / 100, s.totalOdds);
    }
});

test('no bonus below 3 legs, with a sub-1.20 leg, or at zero margin', () => {
    assert.equal(betpawaWinBonus(mk([[2, 0.45], [2, 0.45]])).multiplier, 1);
    assert.equal(betpawaWinBonus(mk([[1.15, 0.84], [1.6, 0.59], [1.45, 0.65], [1.3, 0.73]])).multiplier, 1);
    assert.equal(betpawaWinBonus(mk([[2, 0.5], [2, 0.5], [2, 0.5]])).multiplier, 1);
});

test('book-fair punter EV stays below 1 with the bonus (house keeps its share)', () => {
    for (const s of SITE_V5) {
        const r = betpawaWinBonus(s.legs);
        const q = s.legs.reduce((a, l) => a * l.winProbability, 1);
        assert.ok(q * r.totalOdds < 1);
    }
});
