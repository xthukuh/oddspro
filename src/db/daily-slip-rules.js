// Daily MultiBet slip rules (engine-v2 final touches, spec 2026-08-06-0100):
// banker-style max-survival construction with UNCAPPED combined odds (owner
// decision 2). Strong days take every leg that passes the strict gates,
// weak days shrink toward minLegs, and a day with fewer than minLegs
// qualifiers publishes an honest no-slip entry instead of forcing bad legs.
// Pure: imports only the pure calibration sibling (sanctioned cross-pure
// import, like tip-rules -> markets), offline-testable, shared by the
// production builder, the simulation harness and (later) the web.

import { cellKey } from './leg-calibration.js';

// BAKED by the 2026-08-06 simulation grids (scripts/simulate-daily-slip.js,
// 3 disclosed rounds, 158 cells, 35 hindsight-free days on the warehouse;
// winner rule pre-committed: green-day rate > best streak > flat P&L among
// cells publishing on >= 2/3 of days). Winner: prob-rank, floor 0.96, top 6
// legs = 26/30 green (86.7%), best streak 8, avg 5.5 legs @ 1.07x. What the
// grids taught: unlimited depth collapses survival (floor 0.90 uncapped =
// 11.4% green); the depth cap is load-bearing; minLegPrice > 1.0 empties the
// pool (the market does NOT sell calibrated 94%+ at 1.08+, a real finding);
// efficiency ranking trades ~3pp green for +4% odds and an 11-streak (the
// odds-bearing arm lives on as the Phase 3 'target' strategy instead). Mood
// thresholds = pool-depth/quality terciles of the winner's published days.
// v1.2 (2026-08-06 evolution run, scripts/evolve-daily-slip.js): deterministic
// coordinate-descent over the walk-forward replay, train/test split. Champion
// (floor 0.95, top-5, STREAK-FIRST ranking - unbroken-record cells before
// everything else, the owner's feature preference) took the full window
// 86.7% -> 91.2% green (31/34) and best streak 8 -> 12, tying the incumbent
// on the held-out test tail (91.7%). Hard streak GATES (perfect-cell /
// tail-streak / miss-cooldown) were all rejected by the search: they starve
// publishing. Re-run the evolution monthly as the ledger grows.
// v1.5 (owner order 2026-08-06: safe legs capped at MIN price 1.2 - junk
// 1.01 legs banned from the safety cards). Round-8 grid under the 1.2+
// regime (production decay calibrator, split-2x2): winner floor 0.75 prob-
// rank publishes 36/36 days at 4 legs @ 2.08x combined - any-card green
// 86.1%, strict both-cards 50%, flat P&L +1.36u (the first POSITIVE safe-arm
// replay). Floors >= 0.88 empty the pool (no calibrated 88%+ exists at
// 1.2+, the round-3 market-structure fact). Trade-off vs the 1.01-leg era
// (strict 88.6% / any 100% / 1.04x) accepted by owner order: real odds.
export const DEFAULT_DAILY_SLIP = {
    minLegs: 2,
    maxLegs: 5,
    probFloor: 0.75,
    minLegPrice: 1.2,
    maxLegPrice: 1.35,
    maxPerLeague: 3,
    minCellN: 0,
    rankBy: 'prob',         // 'prob' = calibrated survival | 'streak' = unbroken cells first | 'eff' = cost per log-odds
    mood: {
        green: { legs: 74, meanProb: 0.840 },
        amber: { legs: 36, meanProb: 0.831 },
    },
};

// Efficiency: how much survival a leg costs per unit of combined odds it
// contributes (the replay showcase's buildCard metric). Lower is better:
// a 1.25 leg at 96% beats a 1.01 leg at 97% because it buys ~22x the
// log-odds for one point of survival.
const _eff = l => -Math.log(Math.max(1e-9, Math.min(1, l.calProb))) / Math.log(l.price);

const _num = v => (v == null ? NaN : Number(v));

// fixtures: [{ id, league, menuLegs: [{ market, price, prob }] }]
// Returns one leg per fixture (its best CALIBRATED leg passing every gate),
// globally ranked by calibrated prob desc, league-capped. Deterministic:
// ties break on lower price, then fixture id asc.
export function selectDailyLegs(fixtures, cal, opts = DEFAULT_DAILY_SLIP) {
    const o = { ...DEFAULT_DAILY_SLIP, ...opts };
    // Unbroken-record depth: n for a cell that has NEVER missed (decay scales
    // n and hit together, so the equality survives fractional counts), -1
    // otherwise - broken cells and unknown cells rank purely by calProb.
    const _unbroken = c => (c && c.n > 0 && (c.n - c.hit) < 1e-9 ? c.n : -1);
    const better = o.rankBy === 'eff'
        ? (a, b) => (_eff(a) - _eff(b)) || (b.calProb - a.calProb)
        : o.rankBy === 'streak'
            ? (a, b) => (_unbroken(b.cell) - _unbroken(a.cell)) || (b.calProb - a.calProb) || (a.price - b.price)
            : (a, b) => (b.calProb - a.calProb) || (a.price - b.price);
    const picked = [];
    for (const f of fixtures) {
        const cands = (f.menuLegs ?? [])
            // The fixture's league rides every calibrator call so the v2
            // league-stereotype layer (leg-calibration leagueK) can apply;
            // with the layer off the extra field is inert.
            .map(l => ({ ...l, league: f.league ?? null }))
            .filter(l => {
                const price = _num(l.price);
                if (!(price > 1) || price > o.maxLegPrice) return false;
                if (o.minLegPrice > 1 && price < o.minLegPrice) return false;
                if (o.minCellN > 0 && (cal.cell(l)?.n ?? 0) < o.minCellN) return false;
                return cal.prob(l) >= o.probFloor;
            })
            .map(l => ({
                id: f.id, league: f.league ?? null,
                market: l.market, price: _num(l.price), prob: _num(l.prob),
                calProb: cal.prob(l), cell: cal.cell(l), cellKey: cellKey(l),
            }));
        cands.sort((a, b) => better(a, b)
            || (a.market < b.market ? -1 : a.market > b.market ? 1 : 0));
        if (cands[0]) picked.push(cands[0]);
    }
    picked.sort((a, b) => better(a, b) || (a.id - b.id));
    const out = [];
    const perLeague = new Map();
    for (const l of picked) {
        const n = perLeague.get(l.league) ?? 0;
        if (l.league != null && n >= o.maxPerLeague) continue;
        perLeague.set(l.league, n + 1);
        out.push(l);
    }
    return out;
}

// Mood: green needs BOTH depth and quality; amber needs either a deep pool
// (depth at green level even if quality lags) or the amber depth+quality
// pair; red otherwise. Thresholds live in opts.mood (simulation-finalized).
export function dayMood(legs, opts = DEFAULT_DAILY_SLIP) {
    const m = { ...DEFAULT_DAILY_SLIP.mood, ...(opts.mood ?? {}) };
    const n = legs.length;
    if (!n) return 'red';
    const mean = legs.reduce((s, l) => s + l.calProb, 0) / n;
    if (n >= m.green.legs && mean >= m.green.meanProb) return 'green';
    if (n >= m.green.legs) return 'amber';
    if (n >= m.amber.legs && mean >= m.amber.meanProb) return 'amber';
    return 'red';
}

// Day groupings (owner directive 2026-08-06; scripts/grouping-daily-slip.js):
// splitting the day's top legs into MULTIPLE small cards took any-green days
// (>=1 card wins) to 35/35 = 100% over the window while keeping strict
// all-green at the single-card 88.6% and improving P&L per staked unit
// (-5.3% -> -3.3%). Baked winner: top-4 dealt round-robin into two 2-leg
// cards. `groupCards` returns card arrays with each leg tagged `card: i`;
// under 2 qualifying legs = no cards (the honest no-slip day still applies).
export const DEFAULT_GROUPING = { cards: 2, take: 4, mode: 'interleave' };

export function groupCards(legs, g = DEFAULT_GROUPING) {
    const o = { ...DEFAULT_GROUPING, ...(g ?? {}) };
    const taken = legs.slice(0, o.take);
    if (taken.length < 2) return [];
    const k = Math.max(1, Math.min(o.cards, Math.floor(taken.length / 2)));
    const cards = Array.from({ length: k }, () => []);
    if (o.mode === 'tiered') {
        const size = Math.ceil(taken.length / k);
        taken.forEach((l, i) => cards[Math.min(k - 1, Math.floor(i / size))].push({ ...l, card: Math.min(k - 1, Math.floor(i / size)) }));
    } else {
        taken.forEach((l, i) => cards[i % k].push({ ...l, card: i % k }));
    }
    return cards.filter(c => c.length >= 2);
}

// VALUE cards (owner ship order 2026-08-06; scripts/evolve-value-slip.js
// rounds 1-3): two efficiency-ranked cards per day that each CLOSE the moment
// combined odds reach targetOdds - inherently the fewest legs consistent with
// the target (measured 3.75 avg legs/card; hard 2-3 leg caps lost on
// worst-half profit). Replay record: 44/72 cards = 61.1% at 1.63x avg, ROI
// -0.4% (break-even vs -4.5% single-card), any-win day streak 11, test tail
// held. Round 1's +28.8%-train mirage collapsed -41.6% OOS and is the
// standing reason every re-bake must clear worst-half fitness + the tail.
// HONESTY: break-even at real odds, not proven +EV - labeled so in the UI.
export const DEFAULT_VALUE_CARDS = {
    minLegs: 2, maxLegs: 0,        // selection pool depth uncapped; cards self-limit
    targetOdds: 1.5, maxCards: 2, maxLegsPerCard: 6,
    probFloor: 0.80, minLegPrice: 1.0, maxLegPrice: 1.35,
    maxPerLeague: 3, minCellN: 0, rankBy: 'eff',
};

// pool: selectDailyLegs output under the value opts (eff-ranked). Deals legs
// greedily into cards that close at >= targetOdds; an unclosable remainder is
// discarded, never bet. Legs are tagged { card: startIndex + i, kind: 'value' }.
export function valueCards(pool, opts = DEFAULT_VALUE_CARDS, startIndex = 0) {
    const o = { ...DEFAULT_VALUE_CARDS, ...(opts ?? {}) };
    const cards = [];
    const perLeague = new Map();
    let cur = [], prod = 1;
    for (const l of pool) {
        if (cards.length >= o.maxCards) break;
        const n = perLeague.get(l.league) ?? 0;
        if (l.league != null && n >= o.maxPerLeague) continue;
        perLeague.set(l.league, n + 1);
        cur.push(l); prod *= l.price;
        if (prod >= o.targetOdds) {
            const idx = startIndex + cards.length;
            cards.push(cur.map(x => ({ ...x, card: idx, kind: 'value' })));
            cur = []; prod = 1;
        } else if (cur.length >= o.maxLegsPerCard) {
            cur = []; prod = 1;
        }
    }
    return cards;
}

// legs: selectDailyLegs output (calibrated-prob ranked). The card takes the
// TOP maxLegs of the qualifying pool (the 2026-08-06 grid: unlimited depth
// collapses survival - floor 0.90 uncapped went 11% green vs the capped
// banker construction's 70%+; maxLegs null/0 = uncapped, kept for the
// simulation harness). Combined ODDS stay uncapped (decision 2): a strong
// day's card compounds as high as its top-N legs carry it. Fewer than
// minLegs qualifiers = null = the honest no-slip day. Mood reads the WHOLE
// qualifying pool, not the capped card - depth is what makes a day green.
export function constructSlip(legs, opts = DEFAULT_DAILY_SLIP) {
    const o = { ...DEFAULT_DAILY_SLIP, ...opts };
    const taken = o.maxLegs > 0 ? legs.slice(0, o.maxLegs) : legs;
    if (taken.length < o.minLegs) return null;
    const combinedOdds = taken.reduce((p, l) => p * l.price, 1);
    return { legs: taken, pool: legs.length, combinedOdds, mood: dayMood(legs, o) };
}

// legOutcomes: array of 'hit' | 'miss' | 'void' | null (unsettled).
// Any miss settles the slip early as lost. Voids survive (stake-returned
// legs, DNB pushes) but do not count as hits; an all-void slip is void.
export function slipOutcomeRollup(legOutcomes) {
    const legsHit = legOutcomes.filter(x => x === 'hit').length;
    if (legOutcomes.some(x => x === 'miss')) return { outcome: 'lost', legsHit };
    if (legOutcomes.some(x => x == null)) return { outcome: null, legsHit };
    return { outcome: legsHit > 0 ? 'won' : 'void', legsHit };
}

// slips: [{ status, outcome }] in date ASC order. no_slip days and pending
// (unsettled) days are skipped entirely; void days count as played but are
// streak-neutral (neither green nor a break). greenRate excludes voids from
// the denominator: it answers "of the days a result was possible, how many
// were green", the day-level survival number the owner's bar asks for.
export function slipStreaks(slips) {
    let best = 0, cur = 0, wins = 0, losses = 0, played = 0;
    for (const s of slips) {
        if (s.status !== 'published' || s.outcome == null) continue;
        played++;
        if (s.outcome === 'void') continue;
        if (s.outcome === 'won') { wins++; cur++; if (cur > best) best = cur; }
        else { losses++; cur = 0; }
    }
    let current = 0;
    for (let i = slips.length - 1; i >= 0; i--) {
        const s = slips[i];
        if (s.status !== 'published' || s.outcome == null || s.outcome === 'void') continue;
        if (s.outcome !== 'won') break;
        current++;
    }
    const denom = wins + losses;
    return { current, best, greenRate: denom ? wins / denom : 0, played };
}

// ---------------------------------------------------------------------------
// GEN-2 VALUE LADDER (2026-08-08 owner directive; scripts/evolve-gen2.js,
// 313 evaluated generations, deterministic coordinate descent + per-tier
// refinement, train 25 / test 13 days, both-windows rule enforced).
// Four tier cards per day: 1.5x anchor / 2x double / top-3 legs at >= 1.5
// odds / EV-gated 5x grand. Replay verdict (guarded, full 38-day window):
// any-green 83.8% of published days, best streak 13, anchor 64.9% @ 1.61x
// (+1.7u), top3 33-53% @ 3.47x (positive every window), double 39.4% @ 2.07x,
// grand publishes ONLY when the calibrated card EV clears grandEvFloor
// (zero days on current cells - the 5x arm is below break-even at every
// tried configuration; the gate keeps it honest and revivable as data grows).
// Coherence by construction: one leg per fixture per card, a fixture reused
// across cards may never contradict an already-taken leg, and no leg may
// contradict the fixture's published TIP (the owner's O 1.5-vs-U 1.5 rule).
// Selection universe: TIP-ELIGIBLE fixtures only (population parity with the
// replay harness - the 2026-08-06 live misses were evidence-less fixtures
// the harness never saw). Error feedback: production calibration cells plus
// errorBoost x2 re-observation of published-leg misses.
import { contradicts } from './ladder-rules.js';

export const DEFAULT_GEN2 = {
    rankBy: 'streak',
    probFloorSafe: 0.80,
    t1MinPrice: 1.1, t1MaxPrice: 1.35,
    t2MinPrice: 1.2, t2MaxPrice: 1.35,
    top3MaxPrice: 2.0, probFloorTop3: 0.65,
    t5MinPrice: 1.5, t5MaxLegs: 6, probFloorGrand: 0.55, grandEvFloor: 1.25,
    maxPerLeague: 99,
    fixtureReuse: 0,
    errorBoost: 2,
    minCellN: 0,
};

export const GEN2_TIERS = (c = DEFAULT_GEN2) => ([
    { name: 'anchor', label: 'Anchor 1.5x', target: 1.5, minPrice: c.t1MinPrice, maxPrice: c.t1MaxPrice, probFloor: c.probFloorSafe, maxLegs: 5, exact: 0, evFloor: 0 },
    { name: 'double', label: 'Double 2x', target: 2.0, minPrice: c.t2MinPrice, maxPrice: c.t2MaxPrice, probFloor: c.probFloorSafe, maxLegs: 5, exact: 0, evFloor: 0 },
    { name: 'top3', label: 'Top-3 value', target: 0, minPrice: 1.5, maxPrice: c.top3MaxPrice, probFloor: c.probFloorTop3, maxLegs: 3, exact: 3, evFloor: 0 },
    { name: 'grand', label: 'Grand 5x', target: 5.0, minPrice: c.t5MinPrice, maxPrice: 99, probFloor: c.probFloorGrand, maxLegs: c.t5MaxLegs, exact: 0, evFloor: c.grandEvFloor },
]);

// rows: [{ id, league, menuLegs: [{market, price, prob}], eligible, tipMarket }]
// cal: a leg-calibration calibrator (prob/cell). Returns tier cards:
// [{ tier, label, target, legs: [{market, price, prob, calProb, cell, fixture, league}], product }]
export function selectLadderCards(rows, cal, c = DEFAULT_GEN2) {
    const cards = [];
    const usedFixtures = new Set();
    const takenByFixture = new Map();
    const safeContradicts = (a, b) => { try { return contradicts(a, b); } catch { return true; } };
    for (const tier of GEN2_TIERS(c)) {
        const cands = [];
        for (const r of rows) {
            if (!r.eligible) continue;
            let best = null;
            for (const l of r.menuLegs) {
                const price = Number(l.price);
                if (!(price > 1) || price < tier.minPrice || price > tier.maxPrice) continue;
                const cell = cal.cell(l);
                if (c.minCellN > 0 && !(cell && cell.n >= c.minCellN)) continue;
                const calProb = cal.prob(l);
                if (calProb < tier.probFloor) continue;
                const prior = takenByFixture.get(r.id);
                if (prior && prior.some(m => safeContradicts(m, l.market))) continue;
                if (r.tipMarket && safeContradicts(r.tipMarket, l.market) && r.tipMarket !== l.market) continue;
                const cand = { market: l.market, price, prob: l.prob, calProb, cell, fixture: r.id, league: r.league ?? '' };
                if (!best) { best = cand; continue; }
                if (c.rankBy === 'eff') {
                    if (_eff(cand) < _eff(best)) best = cand;
                } else if (c.rankBy === 'streak') {
                    const u = x => x.cell && x.cell.hit === x.cell.n ? x.cell.n : -1;
                    if (u(cand) > u(best) || (u(cand) === u(best) && cand.calProb > best.calProb)) best = cand;
                } else if (cand.calProb > best.calProb || (cand.calProb === best.calProb && cand.price < best.price)) best = cand;
            }
            if (best) cands.push(best);
        }
        cands.sort((a, b) => {
            if (c.rankBy === 'streak') {
                const u = x => x.cell && x.cell.hit === x.cell.n ? x.cell.n : -1;
                if (u(b) !== u(a)) return u(b) - u(a);
            }
            if (c.rankBy === 'eff' && _eff(a) !== _eff(b)) return _eff(a) - _eff(b);
            return (b.calProb - a.calProb) || (a.price - b.price) || (a.fixture - b.fixture);
        });
        const legs = [];
        const perLeague = new Map();
        let product = 1;
        for (const l of cands) {
            if (!c.fixtureReuse && usedFixtures.has(l.fixture)) continue;
            if (legs.some(t => t.fixture === l.fixture)) continue;
            const n = perLeague.get(l.league) ?? 0;
            if (n >= c.maxPerLeague) continue;
            legs.push(l); perLeague.set(l.league, n + 1); product *= l.price;
            if (tier.exact ? legs.length >= tier.exact : (product >= tier.target && legs.length >= 2)) break;
            if (legs.length >= tier.maxLegs) break;
        }
        let complete = tier.exact ? legs.length === tier.exact
            : (product >= tier.target && legs.length >= 2);
        if (complete && tier.evFloor > 0) {
            const cardProb = legs.reduce((p, l) => p * l.calProb, 1);
            if (cardProb * product < tier.evFloor) complete = false;
        }
        if (!complete) continue;
        for (const l of legs) {
            usedFixtures.add(l.fixture);
            let list = takenByFixture.get(l.fixture); if (!list) takenByFixture.set(l.fixture, list = []);
            list.push(l.market);
        }
        cards.push({ tier: tier.name, label: tier.label, target: tier.target, legs, product });
    }
    return cards;
}
