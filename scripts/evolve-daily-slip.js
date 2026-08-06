#!/usr/bin/env node
// Iterative battle-test optimization of the daily-slip selection algorithm
// (owner directive 2026-08-06: "test and tweak until the most optimal
// algorithm emerges; use past errors; prefer features with unbroken hit
// streaks"). Deterministic coordinate-descent generations - no RNG anywhere,
// so a run cannot be re-rolled until it looks good.
//
// Method:
// - Fitness = the committed winner rule (green-day rate > best streak > flat
//   P&L) on a WALK-FORWARD replay (cell stats from strictly prior days).
// - Overfitting guard: the search sees only the TRAIN days (first 2/3); the
//   emerging champion is then validated on the untouched TEST tail. Bake only
//   if it beats the incumbent on BOTH.
// - Error-feedback dimensions searched: unbroken-record cell gates
//   (perfectMinN), current-tail-streak gates (tailStreak), miss cooldown
//   (a cell that missed within D days is benched), cell taxonomy granularity
//   (group|band vs market|band), streak-first ranking.
//
// Usage: node scripts/evolve-daily-slip.js --db oddspro [--json tmp/evo.json]
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SHRINK_K = 50;
const MAX_GENERATIONS = 10;

// The incumbent (v1.1 baked) expressed in this script's config space.
const INCUMBENT = {
    probFloor: 0.96, maxLegs: 6, maxPerLeague: 3, maxLegPrice: 1.35,
    rankBy: 'prob',            // 'prob' | 'streak' (unbroken cells first, by evidence depth)
    taxonomy: 'group',         // 'group' (group|band) | 'market' (market|band) for the GATES
    perfectMinN: 0,            // >0: only legs whose gate-cell is unbroken (hit === n) with n >= this
    tailStreak: 0,             // >0: gate-cell's current consecutive-hit run must be >= this
    missCooldownDays: 0,       // >0: bench a gate-cell for D days after any miss
};

// Deterministic neighborhoods per knob (coordinate descent explores every
// single-knob mutation of the champion each generation).
const SPACE = {
    probFloor: [0.94, 0.95, 0.96, 0.97],
    maxLegs: [4, 5, 6, 7, 8],
    rankBy: ['prob', 'streak'],
    taxonomy: ['group', 'market'],
    perfectMinN: [0, 20, 50, 100],
    tailStreak: [0, 20, 50, 100],
    missCooldownDays: [0, 3, 7],
};

const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[evolve] loading...');
const raw = await load();
const ix = index(raw);
const fxById = new Map(raw.fixtures.map(f => [f.id, f]));
const derived = [];
for (const f of raw.fixtures) { const d = derive(f, ix, cfg, null); if (d) derived.push(d); }
for (const d of derived) {
    const f = fxById.get(d.id);
    const rows = ix.oddsBy.get(d.id) ?? [];
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    d.menuLegs = Object.entries(marketMenu(books)).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        return { market, price: l.price, prob: l.prob, outcome };
    }).filter(l => Number(l.price) > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
}
const byDay = new Map();
for (const d of derived) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
const days = [...byDay.keys()].sort();
const TRAIN_END = Math.floor(days.length * 2 / 3);
const trainDays = days.slice(0, TRAIN_END);
const testDays = days.slice(TRAIN_END);
console.error(`[evolve] ${derived.length} fixtures over ${days.length} days; train ${trainDays.length} / test ${testDays.length}`);

const dayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
const gateKey = (tax, l) => tax === 'market' ? `${l.market}|${bandOf(Number(l.price))}` : `${groupOf(l.market)}|${bandOf(Number(l.price))}`;
const calKey = l => `${groupOf(l.market)}|${bandOf(Number(l.price))}`;

// One walk-forward replay of a config over `evalDays`. Cell state: the
// calibration cells (group taxonomy, the baked layer) plus gate cells in the
// config's taxonomy carrying {n, hit, tail, lastMissDay}.
function replay(config, evalDays) {
    const cal = new Map();    // calKey -> {n, hit}
    const gate = new Map();   // gateKey -> {n, hit, tail, lastMissDay}
    const perDay = [];
    for (const day of days) {
        const dn = dayNum(day);
        const inEval = evalDays.includes(day);
        const rows = byDay.get(day) ?? [];
        if (inEval) {
            const picked = [];
            for (const r of rows) {
                let best = null;
                for (const l of r.menuLegs) {
                    const price = Number(l.price);
                    if (!(price > 1) || price > config.maxLegPrice) continue;
                    const c = cal.get(calKey(l));
                    const calProb = c ? (c.hit + SHRINK_K * l.prob) / (c.n + SHRINK_K) : l.prob;
                    if (calProb < config.probFloor) continue;
                    const g = gate.get(gateKey(config.taxonomy, l));
                    if (config.perfectMinN > 0 && !(g && g.n >= config.perfectMinN && g.hit === g.n)) continue;
                    if (config.tailStreak > 0 && !(g && g.tail >= config.tailStreak)) continue;
                    if (config.missCooldownDays > 0 && g?.lastMissDay != null
                        && dn - g.lastMissDay <= config.missCooldownDays) continue;
                    const cand = { ...l, league: r.league, calProb, gcell: g ?? null };
                    if (!best) { best = cand; continue; }
                    if (config.rankBy === 'streak') {
                        const bu = best.gcell && best.gcell.hit === best.gcell.n ? best.gcell.n : -1;
                        const cu = cand.gcell && cand.gcell.hit === cand.gcell.n ? cand.gcell.n : -1;
                        if (cu > bu || (cu === bu && cand.calProb > best.calProb)) best = cand;
                    } else if (cand.calProb > best.calProb
                        || (cand.calProb === best.calProb && cand.price < best.price)) best = cand;
                }
                if (best) picked.push(best);
            }
            picked.sort((a, b) => {
                if (config.rankBy === 'streak') {
                    const au = a.gcell && a.gcell.hit === a.gcell.n ? a.gcell.n : -1;
                    const bu = b.gcell && b.gcell.hit === b.gcell.n ? b.gcell.n : -1;
                    if (bu !== au) return bu - au;
                }
                return (b.calProb - a.calProb) || (a.price - b.price);
            });
            const taken = [];
            const perLeague = new Map();
            for (const l of picked) {
                const n = perLeague.get(l.league) ?? 0;
                if (n >= config.maxPerLeague) continue;
                perLeague.set(l.league, n + 1);
                taken.push(l);
                if (taken.length >= config.maxLegs) break;
            }
            if (taken.length >= 2) {
                const green = taken.every(l => l.outcome === 'hit');
                const product = taken.reduce((p, l) => p * Number(l.price), 1);
                perDay.push({ day, green, product, legs: taken.length });
            } else {
                perDay.push({ day, green: null });
            }
        }
        // Observe AFTER the day's card (strictly-prior-days information).
        for (const r of rows) for (const l of r.menuLegs) {
            const hit = l.outcome === 'hit';
            let c = cal.get(calKey(l)); if (!c) cal.set(calKey(l), c = { n: 0, hit: 0 });
            c.n++; if (hit) c.hit++;
            const gk = gateKey(config.taxonomy, l);
            let g = gate.get(gk); if (!g) gate.set(gk, g = { n: 0, hit: 0, tail: 0, lastMissDay: null });
            g.n++;
            if (hit) { g.hit++; g.tail++; } else { g.tail = 0; g.lastMissDay = dayNum(day); }
        }
    }
    const played = perDay.filter(p => p.green != null);
    const green = played.filter(p => p.green);
    let pnl = 0, best = 0, cur = 0;
    for (const p of played) {
        pnl += p.green ? p.product - 1 : -1;
        cur = p.green ? cur + 1 : 0; if (cur > best) best = cur;
    }
    return {
        played: played.length, green: green.length,
        greenRate: played.length ? green.length / played.length : 0,
        best, pnl,
        avgLegs: played.length ? played.reduce((s, p) => s + p.legs, 0) / played.length : 0,
        avgOdds: played.length ? played.reduce((s, p) => s + p.product, 0) / played.length : 0,
    };
}

const fitnessCmp = (a, b) => (b.greenRate - a.greenRate) || (b.best - a.best) || (b.pnl - a.pnl);
const cfgKey = c => JSON.stringify(c);
const fmt = r => `${r.green}/${r.played}=${(100 * r.greenRate).toFixed(1)}% stk${r.best} ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}u ${r.avgLegs.toFixed(1)}legs@${r.avgOdds.toFixed(2)}x`;

// Coordinate-descent generations over TRAIN.
const minPlayed = Math.ceil(trainDays.length * 2 / 3);
const seen = new Map();
const evalTrain = c => {
    const k = cfgKey(c);
    if (!seen.has(k)) seen.set(k, replay(c, trainDays));
    return seen.get(k);
};
let champion = { ...INCUMBENT };
let champFit = evalTrain(champion);
console.log(`gen 0 (incumbent): ${fmt(champFit)}`);
let stable = 0;
for (let gen = 1; gen <= MAX_GENERATIONS && stable < 2; gen++) {
    let bestCfg = champion, bestFit = champFit, evals = 0;
    for (const [knob, values] of Object.entries(SPACE)) {
        for (const v of values) {
            if (champion[knob] === v) continue;
            const cand = { ...champion, [knob]: v };
            const fit = evalTrain(cand); evals++;
            if (fit.played < minPlayed) continue;   // a daily product must publish
            if (fitnessCmp(fit, bestFit) < 0) { bestCfg = cand; bestFit = fit; }
        }
    }
    if (cfgKey(bestCfg) === cfgKey(champion)) {
        stable++;
        console.log(`gen ${gen}: no improvement (${evals} candidates) - stability ${stable}/2`);
    } else {
        stable = 0;
        const diff = Object.keys(bestCfg).filter(k => bestCfg[k] !== champion[k])
            .map(k => `${k}: ${champion[k]} -> ${bestCfg[k]}`).join(', ');
        champion = bestCfg; champFit = bestFit;
        console.log(`gen ${gen}: ${diff}  =>  ${fmt(champFit)}  (${evals} candidates)`);
    }
}

console.log(`\nchampion config: ${cfgKey(champion)}`);
console.log(`TRAIN  incumbent ${fmt(replay(INCUMBENT, trainDays))}`);
console.log(`TRAIN  champion  ${fmt(champFit)}`);
console.log(`TEST   incumbent ${fmt(replay(INCUMBENT, testDays))}`);
console.log(`TEST   champion  ${fmt(replay(champion, testDays))}`);
console.log(`FULL   incumbent ${fmt(replay(INCUMBENT, days))}`);
console.log(`FULL   champion  ${fmt(replay(champion, days))}`);

const out = opt('json', null);
if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify({ champion, evaluated: seen.size,
        train: champFit, test: replay(champion, testDays) }, null, 1));
    console.error(`[evolve] wrote ${out}`);
}
await db.destroy();
