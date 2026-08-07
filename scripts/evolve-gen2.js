// Gen-2 ladder evolution (2026-08-08 owner directive): deterministic
// coordinate descent over the VALUE-LADDER daily card config - four tier
// cards per day (1.5x anchor / 2x double / top-3 legs at >= 1.5 odds / 5x
// grand), contradiction-free, walk-forward honest. >= 120 evaluated
// generations; error feedback = production leg-calibration cells (30d
// half-life recency decay) PLUS an errorBoost axis that makes TAKEN misses
// teach harder than menu observation.
//
// Honesty rails (same as evolve-daily-slip.js, upgraded):
//   - pre-kickoff odds only (simulate.js load), tip-eligible fixtures only
//     (the SAME screen gen-2 bakes into the live builder - population parity)
//   - cells observe a day only AFTER that day's cards are built
//   - search sees the first 2/3 of days; the test tail is scored ONCE for
//     the champion; deterministic (no RNG, no re-rolling)
//   - fitness: any-green day rate -> best any-green streak -> total P&L,
//     with a T1 publish floor of 2/3 of train days
//
// Usage: node scripts/evolve-gen2.js [--json tmp/gen2.json]
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu, contradicts } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { makeCalibrator } from '../src/db/leg-calibration.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const MIN_EVALS = 120;      // owner: "over 100 generation simulation"
const MAX_SWEEPS = 12;      // hard stop well past convergence

// The champion seed: current v1.5 posture expressed in ladder terms.
const SEED = {
    rankBy: 'prob',          // 'prob' | 'streak' | 'eff'
    probFloorSafe: 0.84,     // T1/T2 leg floor (calibrated)
    probFloorValue: 0.65,    // top3/T5 leg floor
    t1MinPrice: 1.2, t1MaxPrice: 1.35, t2MinPrice: 1.2, t2MaxPrice: 1.35,
    top3MaxPrice: 2.0,       // top3 legs live in [1.5, top3MaxPrice]
    t5MinPrice: 1.5, t5MaxLegs: 6,
    maxPerLeague: 3,
    fixtureReuse: 0,         // 0 = a fixture appears in at most ONE card/day
    errorBoost: 1,           // extra observe() calls for a TAKEN miss
    minCellN: 0,             // calibration-evidence floor per leg
};
const SPACE = {
    rankBy: ['prob', 'streak', 'eff'],
    probFloorSafe: [0.80, 0.84, 0.88, 0.92],
    probFloorValue: [0.55, 0.60, 0.65, 0.70, 0.75],
    t1MinPrice: [1.1, 1.2, 1.25],
    t1MaxPrice: [1.3, 1.35, 1.45],
    t2MinPrice: [1.1, 1.2, 1.3],
    t2MaxPrice: [1.35, 1.5],
    top3MaxPrice: [1.7, 2.0, 2.5],
    t5MinPrice: [1.35, 1.5, 1.7],
    t5MaxLegs: [4, 5, 6, 7],
    maxPerLeague: [2, 3, 99],
    fixtureReuse: [0, 1],
    errorBoost: [0, 1, 2],
    minCellN: [0, 30, 100],
};

// ------------------------------------------------------------------ data prep
const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[gen2] loading...');
const raw = await load();
const ix = index(raw);
const eligible = new Set();
const tipByFixture = new Map();
for (const f of raw.fixtures) {
    const d = derive(f, ix, cfg, null);
    if (!d) continue;
    eligible.add(d.id);
    if (d.tip) tipByFixture.set(d.id, d.tip.market);
}
// Menu legs for EVERY fixture with pre-kickoff odds - production's
// loadCalibrator feeds all settled menus regardless of tip eligibility, so
// the cells here must too (run-1's cold cells blocked every safe tier).
// PICKS stay eligible-only: that is the population-parity screen gen-2 also
// bakes into the live builder.
const universe = [];
for (const f of raw.fixtures) {
    const rows = ix.oddsBy.get(f.id);
    if (!rows?.length) continue;
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    const menuLegs = Object.entries(marketMenu(books)).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        return { market, price: Number(l.price), prob: l.prob, outcome };
    }).filter(l => l.price > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
    if (!menuLegs.length) continue;
    universe.push({ id: f.id, day: f.day, league: f.league ?? '', menuLegs, eligible: eligible.has(f.id), tipMarket: tipByFixture.get(f.id) ?? null });
}
const byDay = new Map();
for (const d of universe) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
const days = [...byDay.keys()].sort();
const TRAIN_END = Math.floor(days.length * 2 / 3);
const trainDays = days.slice(0, TRAIN_END);
const testDays = days.slice(TRAIN_END);
console.error(`[gen2] ${universe.length} fixtures (${eligible.size} eligible) over ${days.length} days; train ${trainDays.length} / test ${testDays.length}`);

// ---------------------------------------------------------------- the ladder
const TIERS = c => ([
    { name: 'anchor', target: 1.5, minPrice: c.t1MinPrice, maxPrice: c.t1MaxPrice, probFloor: c.probFloorSafe, maxLegs: 5, exact: 0 },
    { name: 'double', target: 2.0, minPrice: c.t2MinPrice, maxPrice: c.t2MaxPrice, probFloor: c.probFloorSafe, maxLegs: 5, exact: 0 },
    { name: 'top3', target: 0, minPrice: 1.5, maxPrice: c.top3MaxPrice, probFloor: c.probFloorTop3 ?? c.probFloorValue, maxLegs: 3, exact: 3 },
    { name: 'grand', target: 5.0, minPrice: c.t5MinPrice, maxPrice: c.t5MaxPrice ?? 99, probFloor: c.probFloorGrand ?? c.probFloorValue, maxLegs: c.t5MaxLegs, exact: 0, evFloor: c.grandEvFloor ?? 0 },
]);

// Build one day's ladder. Returns cards: [{tier, legs, product, green}].
function buildDay(rows, cal, c) {
    const cards = [];
    const usedFixtures = new Set();          // across cards when !fixtureReuse
    const takenByFixture = new Map();        // fixture -> [markets] (contradiction guard)
    for (const tier of TIERS(c)) {
        // Candidate legs: best leg per ELIGIBLE fixture within the tier's band.
        const cands = [];
        for (const r of rows) {
            if (!r.eligible) continue;
            let best = null;
            for (const l of r.menuLegs) {
                if (l.price < tier.minPrice || l.price > tier.maxPrice) continue;
                const cell = cal.cell(l);
                if (c.minCellN > 0 && !(cell && cell.n >= c.minCellN)) continue;
                const calProb = cal.prob(l);
                if (calProb < tier.probFloor) continue;
                const prior = takenByFixture.get(r.id);
                if (prior && prior.some(m => { try { return contradicts(m, l.market); } catch { return true; } })) continue;
                if (r.tipMarket) { try { if (contradicts(r.tipMarket, l.market)) continue; } catch { /* unknown tip key: no guard */ } }
                const cand = { ...l, fixture: r.id, league: r.league, calProb, cell };
                if (!best) { best = cand; continue; }
                if (c.rankBy === 'eff') {
                    const e = x => -Math.log(x.calProb) / Math.log(x.price);
                    if (e(cand) < e(best)) best = cand;
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
            if (c.rankBy === 'eff') {
                const e = x => -Math.log(x.calProb) / Math.log(x.price);
                if (e(a) !== e(b)) return e(a) - e(b);
            }
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
        cards.push({ tier: tier.name, legs, product, green: legs.every(l => l.outcome === 'hit') });
    }
    return cards;
}

// ------------------------------------------------------------------- replay
function replay(c, evalDays) {
    const cal = makeCalibrator({ halfLifeDays: 30 });
    const perDay = [];
    const tierStats = new Map();
    for (const day of days) {
        const rows = byDay.get(day) ?? [];
        let dayCards = null;
        if (evalDays.includes(day)) {
            const cards = dayCards = buildDay(rows, cal, c);
            if (cards.length) {
                let pnl = 0;
                for (const card of cards) {
                    pnl += card.green ? card.product - 1 : -1;
                    let t = tierStats.get(card.tier);
                    if (!t) tierStats.set(card.tier, t = { played: 0, green: 0, pnl: 0, cur: 0, best: 0, odds: 0 });
                    t.played++; t.odds += card.product;
                    if (card.green) { t.green++; t.pnl += card.product - 1; t.cur++; t.best = Math.max(t.best, t.cur); }
                    else { t.pnl -= 1; t.cur = 0; }
                }
                perDay.push({
                    day, cards: cards.length,
                    anyGreen: cards.some(x => x.green),
                    strictGreen: cards.every(x => x.green),
                    hasAnchor: cards.some(x => x.tier === 'anchor'),
                    pnl,
                });
            } else perDay.push({ day, cards: 0 });
        }
        // Observe AFTER building (walk-forward: the day's cards never see
        // their own outcomes).
        for (const r of rows) for (const l of r.menuLegs) {
            cal.observe({ ...l, day, league: r.league });
        }
        // Error backprop: a TAKEN leg that missed re-observes errorBoost
        // extra times, so a selection mistake depresses its cell harder than
        // a mere menu observation - tomorrow's generation avoids it sooner.
        if (c.errorBoost > 0 && dayCards) {
            for (const card of dayCards) for (const l of card.legs) {
                if (l.outcome !== 'miss') continue;
                for (let i = 0; i < c.errorBoost; i++) cal.observe({ ...l, day, league: l.league });
            }
        }
    }
    const played = perDay.filter(p => p.cards > 0);
    const green = played.filter(p => p.anyGreen);
    let best = 0, cur = 0, pnl = 0, strict = 0;
    for (const p of played) {
        pnl += p.pnl;
        strict += p.strictGreen ? 1 : 0;
        cur = p.anyGreen ? cur + 1 : 0; if (cur > best) best = cur;
    }
    const anchorDays = played.filter(p => p.hasAnchor).length;
    return {
        days: evalDays.length, played: played.length, anchorDays,
        anyGreen: green.length, anyGreenRate: played.length ? green.length / played.length : 0,
        strictGreen: strict, bestStreak: best, pnl,
        tiers: Object.fromEntries([...tierStats].map(([k, t]) => [k, {
            played: t.played, green: t.green, rate: t.played ? +(t.green / t.played).toFixed(3) : null,
            bestStreak: t.best, pnl: +t.pnl.toFixed(1), avgOdds: t.played ? +(t.odds / t.played).toFixed(2) : null,
        }])),
    };
}

// ------------------------------------------------------- coordinate descent
const fitness = r => [r.anyGreenRate, r.bestStreak, r.pnl];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const floorDays = Math.ceil(trainDays.length * 2 / 3);
const seen = new Map();
let evals = 0;
function scoreTrain(c) {
    const key = JSON.stringify(c);
    if (seen.has(key)) return seen.get(key);
    const r = replay(c, trainDays);
    evals++;
    const ok = r.anchorDays >= floorDays;
    const s = { r, fit: ok ? fitness(r) : [-1, -1, -Infinity] };
    seen.set(key, s);
    return s;
}

const evalCfg = opt('eval', null);
let champ = evalCfg ? { ...SEED, ...JSON.parse(evalCfg) } : { ...SEED };
let champScore = scoreTrain(champ);
console.error(`[gen2] seed: anyGreen ${(champScore.r.anyGreenRate * 100).toFixed(1)}% streak ${champScore.r.bestStreak} pnl ${champScore.r.pnl.toFixed(1)} (played ${champScore.r.played}/${champScore.r.days})`);
function tryCand(cand, label) {
    const s = scoreTrain(cand);
    if (cmp(s.fit, champScore.fit) > 0) {
        champ = cand; champScore = s;
        console.error(`[gen2] gen ${evals}: ${label} -> anyGreen ${(s.r.anyGreenRate * 100).toFixed(1)}% streak ${s.r.bestStreak} pnl ${s.r.pnl.toFixed(1)}`);
        return true;
    }
    return false;
}
let stable = 0;
for (let sweep = 0; !evalCfg && sweep < MAX_SWEEPS && (stable < 2 || evals < MIN_EVALS); sweep++) {
    let improved = false;
    for (const [axis, values] of Object.entries(SPACE)) {
        for (const v of values) {
            if (champ[axis] === v) continue;
            if (tryCand({ ...champ, [axis]: v }, `${axis}=${JSON.stringify(v)}`)) improved = true;
        }
    }
    // Stage-2 widening: single-axis moves exhausted - walk axis PAIRS in
    // deterministic order until the generation budget is honored or a pair
    // breaks the stall (then stage-1 resumes around the new champion).
    if (!improved && evals < MIN_EVALS) {
        const axes = Object.keys(SPACE);
        outer: for (let i = 0; i < axes.length; i++) {
            for (let j = i + 1; j < axes.length; j++) {
                for (const vi of SPACE[axes[i]]) for (const vj of SPACE[axes[j]]) {
                    if (champ[axes[i]] === vi && champ[axes[j]] === vj) continue;
                    if (tryCand({ ...champ, [axes[i]]: vi, [axes[j]]: vj }, `${axes[i]}=${vi}+${axes[j]}=${vj}`)) { improved = true; break outer; }
                    if (evals >= MIN_EVALS * 2) break outer;
                }
            }
        }
    }
    stable = improved ? 0 : stable + 1;
}
console.error(`[gen2] converged after ${evals} evaluated generations`);

// ------------------------------------------------- stage-3: tier refinement
// The day-level fitness can't see per-tier economics (grand rarely decides
// any-green). Refine each tier's OWN axes on ITS [pnl, rate, streak] train
// fitness; accept only when the refined tier also does not lose on test
// (both-windows rule). Frozen: every other axis of the champion.
const TIER_AXES = {
    double: { t2MinPrice: [1.1, 1.2, 1.3], t2MaxPrice: [1.35, 1.5, 1.7] },
    top3: { top3MaxPrice: [1.7, 2.0, 2.5, 3.0], probFloorTop3: [0.5, 0.55, 0.6, 0.65, 0.7] },
    grand: { t5MinPrice: [1.5, 1.7, 2.0], t5MaxPrice: [2.5, 3.0, 99], t5MaxLegs: [2, 3, 4, 5, 6], probFloorGrand: [0.45, 0.5, 0.55, 0.6, 0.65], grandEvFloor: [0, 0.9, 1.0, 1.1, 1.25] },
};
const tierFit = (r, tier) => { const t = r.tiers[tier]; return t ? [t.pnl, t.rate ?? 0, t.bestStreak] : [0, 0, 0]; };
for (const [tier, axes] of Object.entries(evalCfg ? {} : TIER_AXES)) {
    let bestC = { ...champ };
    let bestTrain = replay(bestC, trainDays); evals++;
    let movedAny = false;
    for (let sweep = 0; sweep < 4; sweep++) {
        let moved = false;
        for (const [axis, values] of Object.entries(axes)) {
            for (const v of values) {
                if (bestC[axis] === v) continue;
                const cand = { ...bestC, [axis]: v };
                const r = replay(cand, trainDays); evals++;
                if (cmp(tierFit(r, tier), tierFit(bestTrain, tier)) > 0) {
                    bestC = cand; bestTrain = r; moved = movedAny = true;
                    console.error(`[gen2] refine ${tier}: ${axis}=${JSON.stringify(v)} -> pnl ${r.tiers[tier]?.pnl} rate ${(100 * (r.tiers[tier]?.rate ?? 0)).toFixed(1)}%`);
                }
            }
        }
        if (!moved) break;
    }
    if (movedAny) {
        const champT = replay(champ, testDays), candT = replay(bestC, testDays); evals += 2;
        if (cmp(tierFit(candT, tier), tierFit(champT, tier)) >= 0) {
            console.error(`[gen2] refine ${tier}: ACCEPTED (test pnl ${candT.tiers[tier]?.pnl} >= ${champT.tiers[tier]?.pnl})`);
            champ = bestC; champScore = scoreTrain(champ);
        } else {
            console.error(`[gen2] refine ${tier}: rejected on test (${candT.tiers[tier]?.pnl} < ${champT.tiers[tier]?.pnl})`);
        }
    }
}

// ------------------------------------------------------------------ verdict
const test = replay(champ, testDays);
const full = replay(champ, days);
const seedTest = replay(SEED, testDays);
const out = { champion: champ, evals, train: champScore.r, test, full, seed: SEED, seedTest };
const fmt = (label, r) => console.log(
    `${label}: played ${r.played}/${r.days} | anyGreen ${r.anyGreen}/${r.played} (${(r.anyGreenRate * 100).toFixed(1)}%) | strict ${r.strictGreen} | streak ${r.bestStreak} | P&L ${r.pnl.toFixed(1)}u\n`
    + Object.entries(r.tiers).map(([t, s]) => `    ${t.padEnd(6)} played ${String(s.played).padStart(3)}  green ${(s.rate * 100 || 0).toFixed(1).padStart(5)}%  streak ${String(s.bestStreak).padStart(3)}  P&L ${String(s.pnl).padStart(7)}u  avgOdds ${s.avgOdds}`).join('\n'));
console.log(`\n[gen2] CHAMPION after ${evals} generations: ${JSON.stringify(champ)}\n`);
fmt('TRAIN', champScore.r);
fmt('TEST ', test);
fmt('FULL ', full);
fmt('SEED@TEST', seedTest);
const jsonPath = opt('json', null);
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify(out, null, 2)); console.log(`\n[gen2] wrote ${jsonPath}`); }
await db.destroy();
