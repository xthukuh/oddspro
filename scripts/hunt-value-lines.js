// HIGH-VALUE line hunt (2026-08-08 owner directive): can the engine make real
// money at HIGH odds? Fresh re-verification - no prior verdict is assumed.
//
// Unorthodox scoring stack per leg (all walk-forward, deterministic):
//   p_hat = sigmoid( logit(devig)
//                    + wModel * (logit(poissonP) - logit(devig))   [Dixon-Coles
//                      goal model fitted per day at that day's cutoff]
//                    + wCells * SUM_d correction_d(leg) )          [vector cells:
//                      group|band, group|devig, dir|ou - the surviving dims]
//   EV    = p_hat * price - 1
//
// Arms per day (price-banded, EV-ranked, one leg per fixture):
//   mid   [2.0, 3.5)  top-K
//   high  [3.5, 6.0)  top-K
//   moon  [6.0, 15)   singles, only when EV >= moonFloor
// Metrics per arm: legs, hit rate, flat P&L, best streak, and the BEST-CASE
// bankroll showcase: flat 1u vs fractional-Kelly (f = edge/(price-1), capped)
// compounding - reported for train, untouched test tail, and full window.
//
// Usage: node scripts/hunt-value-lines.js [--json tmp/hunt.json]
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL, fitGoalModel, modelMarkets } from '../src/db/goal-model.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// ---------------------------------------------------------------- dimensions
const dirOf = m => /^U |^NG$|^TT:.:U /.test(m) ? 'UNDER' : /^O |^GG$|^TT:.:O /.test(m) ? 'OVER' : 'RESULT';
const probBand = p => (Math.floor(p * 20) / 20).toFixed(2);
const ouBand = p => p == null ? 'na' : p >= 0.62 ? 'goals-heavy' : p >= 0.5 ? 'goals-lean' : p >= 0.38 ? 'tight' : 'defensive';
const DIMS = {
    'group|band': (l) => `${groupOf(l.market)}|${bandOf(l.price)}`,
    'group|devig': (l) => `${groupOf(l.market)}|${probBand(l.prob)}`,
    'dir|ou': (l, f) => `${dirOf(l.market)}|${ouBand(f.impliedOver)}`,
};
const logit = p => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const dayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;

// ------------------------------------------------------------------ data prep
const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[hunt] loading...');
const raw = await load();
const ix = index(raw);
const eligible = new Set();
for (const f of raw.fixtures) { const d = derive(f, ix, cfg, null); if (d) eligible.add(d.id); }
const universe = [];
for (const f of raw.fixtures) {
    const rows = ix.oddsBy.get(f.id);
    if (!rows?.length) continue;
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    const menu = marketMenu(books);
    const legs = Object.entries(menu).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        return { market, price: Number(l.price), prob: l.prob, outcome };
    }).filter(l => l.price > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
    if (!legs.length) continue;
    universe.push({
        id: f.id, day: f.day, eligible: eligible.has(f.id),
        home_team_id: f.home_team_id, away_team_id: f.away_team_id, league_id: f.league_id,
        fx: { impliedOver: menu['O 2.5']?.prob ?? null },
        legs,
    });
}
const byDay = new Map();
for (const u of universe) { let l = byDay.get(u.day); if (!l) byDay.set(u.day, l = []); l.push(u); }
const days = [...byDay.keys()].sort();
const TRAIN_END = Math.floor(days.length * 2 / 3);
const trainDays = days.slice(0, TRAIN_END);
const testDays = days.slice(TRAIN_END);
console.error(`[hunt] ${universe.length} fixtures over ${days.length} days; train ${trainDays.length} / test ${testDays.length}`);

// Pre-fit one goal model per day (walk-forward cutoff at the day's midnight).
console.error('[hunt] fitting per-day goal models...');
const modelByDay = new Map();
for (const day of days) {
    modelByDay.set(day, fitGoalModel(raw.history, Date.parse(`${day}T00:00:00+03:00`), cfg.model));
}

// -------------------------------------------------------------------- replay
const BANDS = { mid: [2.0, 3.5], high: [3.5, 6.0], moon: [6.0, 15.0] };
function replay(h, evalDays) {
    const cells = new Map(Object.keys(DIMS).map(d => [d, new Map()]));
    const arms = Object.fromEntries(Object.keys(BANDS).map(k => [k, { legs: 0, hit: 0, pnl: 0, cur: 0, best: 0, bank: 1, kelly: 1, days: 0 }]));
    const cellOf = (d, v) => {
        let c = cells.get(d).get(v);
        if (!c) cells.get(d).set(v, c = { n: 0, hit: 0, devig: 0, day: null, tail: 0 });
        return c;
    };
    const decayed = (c, dn) => {
        if (!h.halfLife || c.day == null || dn <= c.day) return c;
        const f = 0.5 ** ((dn - c.day) / h.halfLife);
        return { ...c, n: c.n * f, hit: c.hit * f, devig: c.devig * f };
    };
    const correction = (d, l, u, dn) => {
        const rawCell = cellOf(d, DIMS[d](l, u.fx));
        const c = decayed(rawCell, dn);
        if (c.n < h.minN) return 0;
        const rate = (c.hit + h.k * (c.devig / Math.max(c.n, 1e-9))) / (c.n + h.k);
        let corr = logit(rate) - logit(c.devig / Math.max(c.n, 1e-9));
        // Streak weapon: an unbroken cell run grants a bounded bonus (owner
        // directive - unbeaten patterns are wielded, not just observed).
        if (rawCell.tail >= h.weaponTail && c.n >= h.minN) corr += h.weaponBonus;
        return corr;
    };
    for (const day of days) {
        const dn = dayNum(day);
        const rows = byDay.get(day) ?? [];
        if (evalDays.includes(day)) {
            const model = modelByDay.get(day);
            const cands = [];
            for (const u of rows) {
                if (!u.eligible) continue;
                const mp = model ? modelMarkets(model, u.home_team_id, u.away_team_id, u.league_id) : null;
                for (const l of u.legs) {
                    if (l.price < 2.0 || l.price >= 15.0) continue;
                    let x = logit(l.prob);
                    const m = mp?.[l.market];
                    if (m != null) x += h.wModel * (logit(m) - logit(l.prob));
                    let corr = 0;
                    for (const d of Object.keys(DIMS)) corr += correction(d, l, u, dn);
                    x += h.wCells * Math.max(-1.5, Math.min(1.5, corr));
                    const p = sigmoid(x);
                    cands.push({ ...l, u, p, ev: p * l.price - 1 });
                }
            }
            for (const [band, [lo, hi]] of Object.entries(BANDS)) {
                // Reliability cascade (owner): hunt CRAZY first, then admit
                // lower-but-still-high standards until the day's quota fills.
                const floors = band === 'moon' ? [h.moonFloor] : [0.25, 0.15, h.evFloor];
                const picks = [];
                const used = new Set();
                for (const fl of floors) {
                    const bandCands = cands.filter(c => c.price >= lo && c.price < hi && c.ev >= fl)
                        .sort((a, b) => (b.ev - a.ev) || (a.u.id - b.u.id));
                    for (const c of bandCands) {
                        if (used.has(c.u.id)) continue;
                        used.add(c.u.id); picks.push(c);
                        if (picks.length >= h.perDay) break;
                    }
                    if (picks.length >= h.perDay) break;
                }
                if (!picks.length) continue;
                const a = arms[band];
                a.days++;
                let allHit = true;
                for (const p of picks) {
                    a.legs++;
                    const won = p.outcome === 'hit';
                    if (won) { a.hit++; a.pnl += p.price - 1; } else { a.pnl -= 1; allHit = false; }
                    // Bankroll showcases (per-leg sequential): flat 2% and
                    // capped fractional Kelly on the CLAIMED edge.
                    const stakeFlat = 0.02;
                    a.bank *= won ? 1 + stakeFlat * (p.price - 1) : 1 - stakeFlat;
                    const f = Math.max(0, Math.min(h.kellyCap, p.ev / (p.price - 1)));
                    a.kelly *= won ? 1 + f * (p.price - 1) : 1 - f;
                }
                if (allHit) { a.cur++; a.best = Math.max(a.best, a.cur); } else a.cur = 0;
            }
        }
        for (const u of rows) for (const l of u.legs) {
            for (const d of Object.keys(DIMS)) {
                const c = cellOf(d, DIMS[d](l, u.fx));
                const dec = decayed(c, dn);
                c.n = dec.n + 1; c.hit = dec.hit + (l.outcome === 'hit' ? 1 : 0); c.devig = dec.devig + l.prob;
                c.day = Math.max(c.day ?? dn, dn);
                c.tail = l.outcome === 'hit' ? (c.tail ?? 0) + 1 : 0;
            }
        }
    }
    const out = {};
    for (const [k, a] of Object.entries(arms)) {
        out[k] = {
            days: a.days, legs: a.legs, rate: a.legs ? +(a.hit / a.legs).toFixed(3) : null,
            pnl: +a.pnl.toFixed(1), roi: a.legs ? +(a.pnl / a.legs).toFixed(3) : null,
            bestStreak: a.best,
            bank_flat2pct: +a.bank.toFixed(2), bank_kelly: +a.kelly.toFixed(2),
        };
    }
    return out;
}

// ------------------------------------------------------------ meta-search
const SEED = { wModel: 0.25, wCells: 0.5, k: 50, minN: 30, halfLife: 60, evFloor: 0, moonFloor: 0.15, perDay: 3, kellyCap: 0.05, weaponTail: 25, weaponBonus: 0.2 };
const SPACE = {
    wModel: [0, 0.25, 0.5, 0.75, 1.0],
    wCells: [0, 0.5, 1.0, 1.5],
    k: [20, 50, 100],
    minN: [15, 30, 60],
    halfLife: [15, 30, 60],
    evFloor: [0, 0.05, 0.10, 0.20],
    moonFloor: [0.15, 0.25, 0.40],
    perDay: [1, 2, 3],
    kellyCap: [0.03, 0.05, 0.10],
    weaponTail: [15, 25, 40],
    weaponBonus: [0, 0.1, 0.2, 0.4],
};
// Fitness: total P&L across arms, then mid-arm ROI, then mid streak - profit
// is the owner's stated objective for this hunt.
const fitness = r => [
    (r.mid?.pnl ?? 0) + (r.high?.pnl ?? 0) + (r.moon?.pnl ?? 0),
    r.mid?.roi ?? -1,
    r.mid?.bestStreak ?? 0,
];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const seen = new Map();
let evals = 0;
function scoreTrain(h) {
    const key = JSON.stringify(h);
    if (seen.has(key)) return seen.get(key);
    const r = replay(h, trainDays);
    evals++;
    const s = { r, fit: fitness(r) };
    seen.set(key, s);
    return s;
}
let champ = { ...SEED };
let champScore = scoreTrain(champ);
console.error(`[hunt] seed: total pnl ${champScore.fit[0].toFixed(1)}`);
function tryCand(cand, label) {
    const s = scoreTrain(cand);
    if (cmp(s.fit, champScore.fit) > 0) {
        champ = cand; champScore = s;
        console.error(`[hunt] gen ${evals}: ${label} -> total pnl ${s.fit[0].toFixed(1)} (mid roi ${s.r.mid?.roi})`);
        return true;
    }
    return false;
}
const MIN_EVALS = 120;
let stable = 0;
for (let sweep = 0; sweep < 14 && (stable < 2 || evals < MIN_EVALS); sweep++) {
    let improved = false;
    for (const [axis, values] of Object.entries(SPACE)) {
        for (const v of values) {
            if (champ[axis] === v) continue;
            if (tryCand({ ...champ, [axis]: v }, `${axis}=${v}`)) improved = true;
        }
    }
    if (!improved && evals < MIN_EVALS) {
        const axes = Object.keys(SPACE);
        outer: for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) {
            for (const vi of SPACE[axes[i]]) for (const vj of SPACE[axes[j]]) {
                if (champ[axes[i]] === vi && champ[axes[j]] === vj) continue;
                if (tryCand({ ...champ, [axes[i]]: vi, [axes[j]]: vj }, `${axes[i]}=${vi}+${axes[j]}=${vj}`)) { improved = true; break outer; }
                if (evals >= MIN_EVALS * 2) break outer;
            }
        }
    }
    stable = improved ? 0 : stable + 1;
}
console.error(`[hunt] converged after ${evals} evaluated generations`);

const test = replay(champ, testDays);
const full = replay(champ, days);
const seedTest = replay(SEED, testDays);
const fmt = (label, r) => {
    console.log(`${label}:`);
    for (const [k, a] of Object.entries(r)) {
        console.log(`  ${k.padEnd(5)} days ${String(a.days).padStart(3)}  legs ${String(a.legs).padStart(4)}  rate ${a.rate ?? '-'}  ROI ${a.roi != null ? (100 * a.roi).toFixed(1) + '%' : '-'}  P&L ${a.pnl}u  streak ${a.bestStreak}  bank(2%flat) ${a.bank_flat2pct}x  bank(kelly) ${a.bank_kelly}x`);
    }
};
console.log(`\n[hunt] CHAMPION after ${evals} generations:\n${JSON.stringify(champ)}\n`);
fmt('TRAIN', champScore.r);
fmt('TEST ', test);
fmt('FULL ', full);
fmt('SEED@TEST', seedTest);
const jsonPath = opt('json', null);
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify({ champion: champ, evals, train: champScore.r, test, full, seedTest }, null, 2)); console.log(`[hunt] wrote ${jsonPath}`); }
await db.destroy();
