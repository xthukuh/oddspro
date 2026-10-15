// BetPawa Kenya "Win Bonus" (dynamic bonus), transcribed 2026-10-15 from the
// site's own calculator bundle (calculator-bundle-*.js, namespace
// com.betpawa.bonus.dynamic) and its live configuration
// (GET /api/preference/v1/brand-component-data -> bonusConfigurations.dynamicBonus).
// Pure and zero-import: the replay harness, the slip builder and the web can
// all price a slip's bonus with ONE definition.
//
// Algorithm (inputs: legs [{ price, winProbability? }], config C):
//   1. Eligible legs E = legs with price >= C.minEligibleItemPrice.
//   2. For each eligible leg, q = winProbability, or 1/price when absent
//      (the site's getWinProbabilityAdjustedForVoid with no void probability).
//   3. totalMargin d = product over E of 1 / (q * price); houseEV g = 1 - 1/d.
//   4. Per-leg reduced margin: u = 1/(q * price); s = min(u, k/(k-1)) with
//      k = C.itemMarginReductionFactor; o = 1 + (s - 1)/s^k, clamped to
//      [C.minItemMargin, C.maxItemMargin]. Reduced house EV V = 1 - 1/prod(o).
//   5. Punter give-back R = V * C.houseEVToGiveBackToPunter. If g - R is below
//      C.minimumHouseEV the give-back is 0 (no bonus); else F = max(0, R).
//   6. slipOdds p = product of ALL leg prices; Q = product over E of q.
//      Raw multiplier T = max(1, (p + F/Q) / p).
//   7. Clamp T to the min/max entry with the largest `legs` <= |E| (no entry,
//      or |E| = 0: multiplier 1). Boosted odds N = p * clampedT.
//   8. Net bonus percentage K = floor2((N - p)/(p - 1)) (floor to 2 decimals,
//      the site's rounding); paid total odds X = p + (p - 1) * K.
//   0. Any leg below C.minEligibleItemPrice: no modelled bonus (see below).
// Verified 2026-10-15 against the site's own v5 calculator executed in its
// page on four all-eligible slips: multipliers 1.05 / 1.08 / 1.45 / 2.6489 and
// total odds 3.52 / 6.81 / 313.67 / 2139 reproduced exactly.
// Output: { eligibleLegs, slipOdds: p, bonusPct: K, multiplier: X/p, totalOdds: X, houseEV: g }.
//
// Honest reading: with q equal to the true probability, punter EV = Q * X is
// below 1 by construction (the house keeps at least (1 - giveBack) of its edge
// and the per-leg-count caps bind early). The bonus only pays when the
// punter's probability beats the book's own q on the chosen legs.

export const BETPAWA_KE_BONUS = Object.freeze({
    minEligibleItemPrice: 1.2,
    minimumHouseEV: 0,
    itemMarginReductionFactor: 2,
    minItemMargin: 1,
    maxItemMargin: 1.2,
    houseEVToGiveBackToPunter: 0.8,
    // [legs, maxMultiplier]; every minMultiplier is 1 in the live config.
    maxMultipliers: [
        [1, 1], [2, 1], [3, 1.05], [4, 1.08], [5, 1.12], [6, 1.16], [7, 1.2], [8, 1.25], [9, 1.3],
        [10, 1.35], [11, 1.4], [12, 1.45], [13, 1.5], [14, 1.55], [15, 1.6], [16, 1.7], [17, 1.8],
        [18, 1.9], [19, 2], [20, 2.1], [21, 2.25], [22, 2.35], [23, 2.5], [24, 2.7], [25, 2.8],
        [26, 3], [27, 3.1], [28, 3.25], [29, 3.5], [30, 4.5], [31, 4.55], [32, 4.6], [33, 4.65],
        [34, 4.75], [35, 4.85], [36, 4.95], [37, 5], [38, 5.25], [39, 5.5], [40, 6], [41, 6.1],
        [42, 6.2], [43, 6.3], [44, 6.4], [45, 6.5], [46, 6.75], [47, 7], [48, 7.25], [49, 7.5],
        [50, 7.95], [51, 8.41], [52, 8.86], [53, 9.32], [54, 9.77], [55, 10.23], [56, 10.68],
        [57, 11.14], [58, 11.59], [59, 12.05], [60, 13.5],
    ],
});

function _legQ(leg) {
    const q = Number(leg.winProbability);
    return q > 0 && q < 1 ? q : 1 / Number(leg.price);
}

function _reducedMargin(u, c) {
    const k = c.itemMarginReductionFactor;
    const cap = k > 1 ? k / (k - 1) : Number.MAX_VALUE;
    const s = Math.min(u, cap);
    const o = 1 + (s - 1) / s ** k;
    return Math.max(c.minItemMargin, Math.min(o, c.maxItemMargin));
}

function _maxMultiplier(n, c) {
    let best = null;
    for (const [legs, max] of c.maxMultipliers) if (legs <= n && (!best || legs > best[0])) best = [legs, max];
    return best ? best[1] : 1;
}

const _floor2 = x => Math.floor(x * 100 + 1e-9) / 100;

export function betpawaWinBonus(legs, c = BETPAWA_KE_BONUS) {
    const slipOdds = legs.reduce((a, l) => a * Number(l.price), 1);
    const eligible = legs.filter(l => Number(l.price) >= c.minEligibleItemPrice);
    // A slip carrying any sub-minimum leg gets NO modelled bonus: the site's v5
    // calculator shrinks the bonus in that case by a rule not visible in the
    // bundle (measured: 1.0435x where this module's v2-era math says 1.05x),
    // so the conservative answer is none.
    if (!eligible.length || eligible.length < legs.length) {
        return { eligibleLegs: eligible.length, slipOdds, multiplier: 1, totalOdds: slipOdds, houseEV: null };
    }
    let d = 1, reduced = 1, Q = 1;
    for (const l of eligible) {
        const q = _legQ(l), u = 1 / (q * Number(l.price));
        d *= u; reduced *= _reducedMargin(u, c); Q *= q;
    }
    const houseEV = 1 - 1 / d;
    const R = (1 - 1 / reduced) * c.houseEVToGiveBackToPunter;
    const F = houseEV - R < c.minimumHouseEV ? 0 : Math.max(0, R);
    const T = Math.max(1, (slipOdds + F / Q) / slipOdds);
    const mult = Math.max(1, Math.min(T, _maxMultiplier(eligible.length, c)));
    const N = slipOdds * mult;
    // The site floors the net bonus percentage and the total odds to 2 decimals.
    const K = slipOdds > 1 ? _floor2((N - slipOdds) / (slipOdds - 1)) : 0;
    // Paid odds use the floored K at full precision (the site floors only the
    // DISPLAYED total to 2 decimals; the payout is stake * (p + (p - 1) * K)).
    const totalOdds = slipOdds + (slipOdds - 1) * K;
    return { eligibleLegs: eligible.length, slipOdds, bonusPct: K, multiplier: totalOdds / slipOdds, totalOdds, houseEV };
}
