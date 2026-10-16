// The Pick (owner directive 2026-10-16): ONE obvious tip per game, priced at
// 1.50 or more, chosen by OUR walk-forward calibration, never by the
// bookmaker's own number. It is stored in the fixture_predictions
// tip_banker_* columns (the old Banker - the shortest price on the board,
// O 0.5 in 30% of games at an average 1.03 - is retired by this module; see
// the 2026-10-16 regime note in docs/memory-bank.md).
//
// Pure; imports only the sibling pure leg-calibration.js (for its cell key),
// so the web imports the same predicates the server writes with.
//
// CALIBRATOR (makePickCalibrator, walk-forward: it observes only legs settled
// before the day it scores):
//   cell = market group x price band   (leg-calibration.js cellKey)
//   P(leg) = clamp(prob + sum(hit - prob) / (n + shrinkK), 0.005, 0.995)
// i.e. the leg keeps its own price information and gains only the measured
// bias of its cell. The shared leg-cell calibrator instead REPLACES a leg's
// number with its cell's average hit rate; inside the wide 1.60-2.20 band
// that rates a 2.15 leg like a 1.61 leg, drifts the Pick to the longest
// price and over-claims (replay: claimed 60.5%, realized 57.4%). The residual
// form claims 59.4% and realizes 59.4% on the same games.
//
// PICK (fixturePick; input: one game's menu legs [{ market, price, prob }],
// prob = the devigged book probability):
//   1. Candidates: legs with minPrice <= price <= maxPrice, prob in (0, 1),
//      and a market that is not Draw No Bet (a DNB push settles void, which
//      no single win chance can describe).
//   2. Each candidate's chance = cal.prob(leg); with no calibrator, the devig.
//   3. The Pick = the candidate with the highest chance; ties go to the
//      shorter price. No candidate -> no Pick.
//
// DAY CARD (selectTopPicks): the day's games with a Pick, ranked by chance
// descending, the first `cardSize` taken (one per game by construction),
// then shown in kickoff order - the path the day walks. Each pick is a
// SINGLE stake: one miss never erases the others.
//
// DAY VERDICT (picksDayScore): units = sum over settled picks of
// (price - 1) on a hit, -1 on a miss, 0 on a void. Once every pick is
// settled the day is 'won' when units > 0, 'void' when nothing was decided,
// else 'lost'. The card's headline is the score ("2 of 3 won, +0.04u"),
// never a bare verdict word.
//
// Measured (scripts/replay-picks.js over 28,843 settled fixtures, 2026-07-02
// ..10-15, walk-forward, hindsight-free): one Pick per game hits 59.4% at an
// average 1.58; the day's top 3 land 2 or more on 62% of train days and 69%
// of the untouched test tail. Prices at 1.50+ cap any single pick near 65%:
// the price is the ceiling, not the model.
import { cellKey } from './leg-calibration.js';

export const DEFAULT_PICK = Object.freeze({
    minPrice: 1.5,
    maxPrice: 2.2,
    cardSize: 3,
    shrinkK: 300,
});

export const isPickMarket = m => m != null && !/^DNB/.test(String(m));

// True when a stored (market, price) is a Pick under the current rules.
// Rows written before 2026-10-16 hold the retired Banker (prices from 1.01);
// readers use this to show those as "no pick" instead of resurfacing O 0.5.
export function isPick(market, price, opts = DEFAULT_PICK) {
    const p = Number(price);
    return isPickMarket(market) && p >= opts.minPrice && p <= opts.maxPrice;
}

// Residual calibrator (see the header). `cells` rehydrates a prior export().
// Legs: { market, price, prob, outcome } - only 'hit'/'miss' teach.
export function makePickCalibrator({ shrinkK = DEFAULT_PICK.shrinkK, cells = null } = {}) {
    const map = new Map(cells ? Object.entries(cells).map(([k, c]) => [k, { n: c.n, r: c.r }]) : []);
    return {
        observe(leg) {
            if (leg.outcome !== 'hit' && leg.outcome !== 'miss') return;
            const prob = Number(leg.prob);
            if (!(prob > 0 && prob < 1) || !isPickMarket(leg.market)) return;
            const k = cellKey(leg), c = map.get(k) ?? { n: 0, r: 0 };
            c.n++; c.r += (leg.outcome === 'hit' ? 1 : 0) - prob;
            map.set(k, c);
        },
        prob(leg) {
            const prob = Number(leg.prob), c = map.get(cellKey(leg));
            const lift = c ? c.r / (c.n + shrinkK) : 0;
            return Math.min(0.995, Math.max(0.005, prob + lift));
        },
        cell(leg) {
            const c = map.get(cellKey(leg));
            return c ? { n: c.n, lift: Math.round(10000 * c.r / (c.n + shrinkK)) / 10000 } : null;
        },
        export() {
            return { shrinkK, cells: Object.fromEntries([...map].map(([k, c]) => [k, { n: c.n, r: Math.round(c.r * 1e4) / 1e4 }])) };
        },
    };
}

// legs: [{ market, price, prob }]. cal: { prob(leg) } | null.
// Returns { market, price, prob, calProb } | null.
export function fixturePick(legs, cal = null, opts = DEFAULT_PICK) {
    const o = { ...DEFAULT_PICK, ...opts };
    let best = null;
    for (const l of legs ?? []) {
        const price = Number(l.price), prob = Number(l.prob);
        if (!isPick(l.market, price, o) || !(prob > 0 && prob < 1)) continue;
        const raw = cal ? Number(cal.prob({ market: l.market, price, prob })) : prob;
        const calProb = Math.round(Math.min(0.995, Math.max(0.005, raw)) * 10000) / 10000;
        if (best && (calProb < best.calProb || (calProb === best.calProb && price >= best.price))) continue;
        best = { market: l.market, price, prob, calProb };
    }
    return best;
}

// games: [{ id, kickoff, pick: { market, price, prob, calProb } | null, ... }].
// Returns the chosen games (each carrying its pick) in kickoff order.
export function selectTopPicks(games, opts = DEFAULT_PICK) {
    const o = { ...DEFAULT_PICK, ...opts };
    const ranked = (games ?? [])
        .filter(g => g?.pick && Number.isFinite(Number(g.pick.calProb)))
        .sort((a, b) => (b.pick.calProb - a.pick.calProb) || (a.pick.price - b.pick.price)
            || (String(a.id) < String(b.id) ? -1 : 1));
    const taken = [];
    const seen = new Set();
    for (const g of ranked) {
        if (seen.has(g.id)) continue;
        seen.add(g.id);
        taken.push(g);
        if (taken.length >= o.cardSize) break;
    }
    return taken.sort((a, b) => (Date.parse(a.kickoff) || 0) - (Date.parse(b.kickoff) || 0));
}

// legs: [{ price, outcome: 'hit' | 'miss' | 'void' | null }].
export function picksDayScore(legs) {
    let won = 0, lost = 0, voided = 0, pending = 0, units = 0;
    for (const l of legs ?? []) {
        if (l.outcome === 'hit') { won++; units += Number(l.price) - 1; }
        else if (l.outcome === 'miss') { lost++; units -= 1; }
        else if (l.outcome === 'void') voided++;
        else pending++;
    }
    units = Math.round(units * 100) / 100;
    const outcome = pending > 0 ? null : (won + lost === 0 ? 'void' : (units > 0 ? 'won' : 'lost'));
    return { won, lost, void: voided, pending, units, outcome };
}

// --- Daily slip (owner wizard 2026-10-16: 2 legs, combined 2.5x or more) ----
// The fewest-legs multiplier card: exactly `legs` legs, one per game, each a
// 1.50-2.20 market (not DNB), maximizing the product of our calibrated
// chances subject to combined odds >= minOdds. Candidates are any qualifying
// market of the day's games (not only each game's Pick); a candidate that
// contradicts its game's Pick is dropped by the caller.
//
// Replay (scripts/replay-slips.js, this selector, walk-forward, one slip a
// day, train 2026-07-16..09-13 / untouched test 09-14..10-15):
//   2 legs >= 2.5x: won 46.7% / 56.3% of days at 2.56x, flat ROI +21% / +42%
//   2 legs >= 3x:   won 35.0% / 40.6% at 3.03x, ROI +7% / +23%
//   3 legs >= 4x:   won 25.0% / 34.4% at 4.13x, ROI +4.5% / +38.7%
// Small samples (60 / 32 days): early evidence, not proof. The claimed chance
// ran BELOW realized (38-40% claimed). Gating days on the claimed chance did
// not separate winners from losers, so every day publishes.
export const DEFAULT_SLIP = Object.freeze({
    legs: 2,
    minOdds: 2.5,
    minPrice: 1.5,
    maxPrice: 2.2,
    pool: 40,
});

// cands: [{ fixture, market, price, calProb, ... }]. Returns
// { legs (kickoff order not applied), odds, chance } | null.
export function selectSlip(cands, opts = DEFAULT_SLIP) {
    const o = { ...DEFAULT_SLIP, ...opts };
    const eff = c => Math.log(c.calProb) / Math.log(c.price);   // survival cost per unit of log-odds
    const pool = (cands ?? [])
        .filter(c => c && isPick(c.market, c.price, o) && c.calProb > 0 && c.calProb < 1)
        .sort((a, b) => (eff(b) - eff(a)) || (b.calProb - a.calProb))
        .slice(0, o.pool)
        .sort((a, b) => (b.calProb - a.calProb) || (a.price - b.price));
    const need = Math.log(o.minOdds) - 1e-9;
    let top = null;
    const chosen = [], used = new Set();
    const rec = (start, lp, lo) => {
        if (chosen.length === o.legs) {
            if (lo >= need && (!top || lp > top.lp)) top = { lp, lo, legs: [...chosen] };
            return;
        }
        for (let i = start; i < pool.length; i++) {
            const c = pool[i];
            if (used.has(c.fixture)) continue;
            used.add(c.fixture); chosen.push(c);
            rec(i + 1, lp + Math.log(c.calProb), lo + Math.log(c.price));
            chosen.pop(); used.delete(c.fixture);
        }
    };
    rec(0, 0, 0);
    if (!top) return null;
    return {
        legs: top.legs,
        odds: Math.round(Math.exp(top.lo) * 100) / 100,
        chance: Math.round(Math.exp(top.lp) * 10000) / 10000,
    };
}
