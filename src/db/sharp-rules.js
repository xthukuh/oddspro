// Sharp 4x card (2026-10-15 research, scripts/sharp-*.js): one BetPawa slip a
// day, exactly LEGS legs, combined odds >= TARGET, priced WITH BetPawa's Win
// Bonus. Pure and zero-import apart from sibling pure rule modules.
//
// Why BetPawa only: it publishes its own per-price win probability q (stored
// as odds_markets.probability) and its Win Bonus is computed FROM q. Measured
// over 763,689 settled pre-kickoff BetPawa prices (2026-07-02..10-15): q runs
// low in every band from 1.02 to 3.50 (realized beats it by 0.4-1.0 points,
// both chronological halves), and 1X2 favourites at 1.35-1.60 by ~2.5 points.
// Legs picked walk-forward by the residual below beat q by 4.5% +/- 2.2%
// (r = hits / sum q over 2,545 legs, halves 1.029 / 1.053).
//
// Calibrator (walk-forward; observe only legs settled BEFORE the day built):
//   cell = groupOf(market) | bandOf(price)          (leg-calibration.js)
//   P(leg) = clamp(q + sum(hit - q) / (n + shrinkK), 0.005, 0.995)
// Draw No Bet is excluded everywhere: BetPawa's q for DNB is the
// unconditional win chance and its calculator adds the draw back through a
// voidProbability the warehouse does not store.
//
// Selector (exact-LEGS group knapsack; one leg per fixture):
//   1. Candidate legs: price in [minPrice, maxPrice], q present, not DNB.
//   2. Per fixture keep the topPerFixture legs by efficiency ln(P)/ln(price);
//      pool = the poolSize most efficient overall. (Never rank the pool by raw
//      P: it fills with legs too short to ever reach TARGET - the 2026-08-08
//      silent zero-publish trap.)
//   3. Maximize sum ln(P) subject to sum ln(price) >= ln(TARGET), exactly LEGS
//      legs, log-odds discretized to 0.01.
// Output: { legs, slipOdds, bonus, totalOdds, predProb, bookProb } | null.
//
// Replay (hindsight-free, 85 days 2026-07-23..10-15, one slip a day, bonus
// applied): published 85/85, won 24 (28.2%) vs BetPawa's own 23.2%, avg 4.19x,
// gross ROI +18% (halves +29% / +7%); net of 20% withholding ~0%. A 4x slip
// can win at most EV/4 of days: this is a positive-expectation card that wins
// about one day in four, never a daily guarantee.
import { bandOf, groupOf } from './leg-calibration.js';
import { betpawaWinBonus, BETPAWA_KE_BONUS } from './betpawa-bonus-rules.js';
import { tipBookKey } from './tip-rules.js';

export const SHARP_DEFAULTS = Object.freeze({
    target: 4,
    legs: 3,
    minPrice: 1.3,
    maxPrice: 2.0,
    shrinkK: 300,
    topPerFixture: 3,
    poolSize: 150,
});

export const sharpCellKey = l => `${groupOf(l.market)}|${bandOf(Number(l.price))}`;
export const isSharpMarket = m => !/^DNB/.test(String(m));

// Raw odds rows of ONE fixture -> its BetPawa sharp legs [{ market, price, q }]:
// betpawa rows carrying a probability, keyed by tipBookKey (the shared market
// identity), lowest price per key with that row's probability (the provider-
// bag fold buildTipBooks uses), DNB excluded.
export function sharpLegsFromRows(rows, homeName, awayName) {
    const best = new Map();
    for (const r of rows ?? []) {
        if (r.provider !== 'betpawa') continue;
        const q = Number(r.probability), price = Number(r.price);
        if (!(q > 0 && q < 1) || !(price > 1)) continue;
        let key = null;
        try { key = tipBookKey(r, homeName, awayName); } catch { continue; }
        if (!key || !isSharpMarket(key)) continue;
        const cur = best.get(key);
        if (!cur || price < cur.price) best.set(key, { market: key, price, q });
    }
    return [...best.values()];
}

export function makeSharpCalibrator({ shrinkK = SHARP_DEFAULTS.shrinkK, cells = null } = {}) {
    const map = new Map(cells ? Object.entries(cells).map(([k, c]) => [k, { ...c }]) : []);
    return {
        // leg: { market, price, q, outcome } - only hit/miss teach.
        observe(leg) {
            if (leg.outcome !== 'hit' && leg.outcome !== 'miss') return;
            const q = Number(leg.q);
            if (!(q > 0 && q < 1) || !isSharpMarket(leg.market)) return;
            const k = sharpCellKey(leg), c = map.get(k) ?? { n: 0, r: 0 };
            c.n++; c.r += (leg.outcome === 'hit' ? 1 : 0) - q;
            map.set(k, c);
        },
        prob(leg) {
            const q = Number(leg.q), c = map.get(sharpCellKey(leg));
            const lift = c ? c.r / (c.n + shrinkK) : 0;
            return Math.min(0.995, Math.max(0.005, q + lift));
        },
        cell(leg) {
            const c = map.get(sharpCellKey(leg));
            return c ? { n: c.n, lift: c.r / (c.n + shrinkK) } : null;
        },
        export() { return { shrinkK, cells: Object.fromEntries(map) }; },
    };
}

const STEP = 0.01;

// fixtures: [{ id, legs: [{ market, price, q }] , ...anything }]
export function selectSharpCard(fixtures, cal, opts = {}, bonusConfig = BETPAWA_KE_BONUS) {
    const o = { ...SHARP_DEFAULTS, ...opts };
    const need = Math.ceil(Math.log(o.target) / STEP);
    const eff = l => Math.log(l.P) / Math.log(l.price);
    const pool = [];
    for (const f of fixtures) {
        const ls = (f.legs ?? [])
            .filter(l => isSharpMarket(l.market) && Number(l.q) > 0 && Number(l.q) < 1
                && Number(l.price) >= o.minPrice && Number(l.price) <= o.maxPrice)
            .map(l => ({ ...l, price: Number(l.price), q: Number(l.q), fixture: f.id, P: cal.prob(l) }))
            .sort((a, b) => eff(b) - eff(a))
            .slice(0, o.topPerFixture);
        pool.push(...ls);
    }
    pool.sort((a, b) => eff(b) - eff(a));
    const byFix = new Map();
    for (const l of pool.slice(0, o.poolSize)) {
        const a = byFix.get(l.fixture) ?? []; a.push(l); byFix.set(l.fixture, a);
    }
    // dp[k]: Map(capped log-odds bucket -> { s, legs }), maximize s = sum ln P.
    let dp = Array.from({ length: o.legs + 1 }, () => new Map());
    dp[0].set(0, { s: 0, legs: [] });
    for (const legs of byFix.values()) {
        const nxt = dp.map(m => new Map(m));
        for (let k = 0; k < o.legs; k++) {
            for (const [v, st] of dp[k]) {
                for (const l of legs) {
                    const nv = Math.min(need, v + Math.floor(Math.log(l.price) / STEP));
                    const s = st.s + Math.log(l.P);
                    const cur = nxt[k + 1].get(nv);
                    if (!cur || s > cur.s) nxt[k + 1].set(nv, { s, legs: [...st.legs, l] });
                }
            }
        }
        dp = nxt;
    }
    const best = dp[o.legs].get(need);
    if (!best) return null;
    const legs = best.legs;
    const bonus = betpawaWinBonus(legs.map(l => ({ price: l.price, winProbability: l.q })), bonusConfig);
    return {
        legs,
        slipOdds: bonus.slipOdds,
        bonus: { multiplier: bonus.multiplier, pct: bonus.bonusPct },
        totalOdds: bonus.totalOdds,
        predProb: legs.reduce((a, l) => a * l.P, 1),
        bookProb: legs.reduce((a, l) => a * l.q, 1),
    };
}
