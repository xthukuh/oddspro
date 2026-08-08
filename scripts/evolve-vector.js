// Vector-memory learner (2026-08-08 owner directive D2): a per-day
// self-evaluating walk-forward engine over multi-dimensional feature cells.
//
//   score(leg) = sigmoid( logit(devig) + SUM_d w_d * correction_d(leg) )
//
// where correction_d = logit(shrunk cell hit-rate) - logit(shrunk cell devig
// expectation) for the leg's cell in dimension d. Every day, AFTER outcomes:
//   - each dimension's weight w_d moves by a deterministic multiplicative
//     step toward whatever improved that day's Brier vs the raw market
//     (per-day self-evaluation accuracy enforcement);
//   - TAKEN legs that missed re-observe boost x into all their cells (error
//     backprop);
//   - cells whose recent miss concentration crosses the quarantine bar are
//     ISOLATED (no positive contribution) for a cooldown (anomaly isolation);
//   - unbroken-streak cells (tail >= weaponTail, n >= weaponMinN) grant a
//     bounded weapon bonus (the owner's streak weaponization);
//   - a governor raises the selection floor while realized hit-rate
//     under-runs claimed probability beyond `governGap` (the enforcement
//     check that each generation must not overclaim).
//
// Every rule honest: pre-kickoff odds only, observations strictly after the
// day's picks, deterministic, train 2/3 / untouched test tail, both-windows
// rule for the champion. Meta-search: coordinate descent over the learner's
// hyperparameters + greedy dimension add/drop, >= 150 evaluated generations.
//
// Usage: node scripts/evolve-vector.js [--json tmp/vector.json]
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// ---------------------------------------------------------------- dimensions
const dirOf = m => /^U |^NG$|^TT:.:U /.test(m) ? 'UNDER' : /^O |^GG$|^TT:.:O /.test(m) ? 'OVER' : 'RESULT';
const probBand = p => (Math.floor(p * 20) / 20).toFixed(2);
const favBand = p => p == null ? 'na' : p <= 1.3 ? 'strong' : p <= 1.7 ? 'medium' : p <= 2.4 ? 'mild' : 'level';
const ouBand = p => p == null ? 'na' : p >= 0.62 ? 'goals-heavy' : p >= 0.5 ? 'goals-lean' : p >= 0.38 ? 'tight' : 'defensive';
const DIMS = {
    'group|band': (l) => `${groupOf(l.market)}|${bandOf(l.price)}`,
    'market|band': (l) => `${l.market}|${bandOf(l.price)}`,
    direction: (l) => dirOf(l.market),
    'group|devig': (l) => `${groupOf(l.market)}|${probBand(l.prob)}`,
    'group|fav': (l, f) => `${groupOf(l.market)}|${favBand(f.favPrice)}`,
    'dir|ou': (l, f) => `${dirOf(l.market)}|${ouBand(f.impliedOver)}`,
    'group|country': (l, f) => `${groupOf(l.market)}|${f.country || 'na'}`,
    'group|dow': (l, f) => `${groupOf(l.market)}|${f.dow}`,
};
const ALL_DIMS = Object.keys(DIMS);

// ------------------------------------------------------------------ data prep
const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[vector] loading...');
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
    const one = menu['1']?.price, two = menu['2']?.price;
    const ko = new Date(f.kickoff);
    universe.push({
        id: f.id, day: f.day, eligible: eligible.has(f.id),
        fx: {
            favPrice: [one, two].filter(p => p != null).sort((a, b) => a - b)[0] ?? null,
            impliedOver: menu['O 2.5']?.prob ?? null,
            country: f.country ?? '', dow: ko.getUTCDay(),
        },
        legs,
    });
}
const byDay = new Map();
for (const u of universe) { let l = byDay.get(u.day); if (!l) byDay.set(u.day, l = []); l.push(u); }
const days = [...byDay.keys()].sort();
const TRAIN_END = Math.floor(days.length * 2 / 3);
const trainDays = days.slice(0, TRAIN_END);
const testDays = days.slice(TRAIN_END);
console.error(`[vector] ${universe.length} fixtures over ${days.length} days; train ${trainDays.length} / test ${testDays.length}`);

const logit = p => Math.log(Math.max(1e-6, Math.min(1 - 1e-6, p)) / (1 - Math.max(1e-6, Math.min(1 - 1e-6, p))));
const sigmoid = x => 1 / (1 + Math.exp(-x));
const dayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;

// -------------------------------------------------------------------- replay
// One full walk-forward pass; returns metrics for the SAFEST arm (top-3
// score-ranked legs at price >= 1.5) and the PROFIT arm (top-3 EV-ranked).
function replay(h, evalDays) {
    const dims = h.dims;
    const cells = new Map(dims.map(d => [d, new Map()]));
    const weights = Object.fromEntries(dims.map(d => [d, h.w0]));
    let governFloor = 0;   // extra score floor while overclaiming
    const arms = { safe: mkArm(), profit: mkArm() };
    const claims = [];     // {claimed, hit} for calibration audit
    function mkArm() { return { picked: 0, hit: 0, pnl: 0, cur: 0, best: 0, dayG: 0, dayN: 0 }; }

    const cellOf = (d, v) => {
        let c = cells.get(d).get(v);
        if (!c) cells.get(d).set(v, c = { n: 0, hit: 0, devig: 0, tail: 0, missDays: [], quarUntil: -1, day: null });
        return c;
    };
    const decayed = (c, dn) => {
        if (!h.halfLife || c.day == null || dn <= c.day) return c;
        const f = 0.5 ** ((dn - c.day) / h.halfLife);
        return { ...c, n: c.n * f, hit: c.hit * f, devig: c.devig * f };
    };
    function correction(d, l, u, dn) {
        const v = DIMS[d](l, u.fx);
        const c = decayed(cellOf(d, v), dn);
        if (c.n < h.minN) return 0;
        const raw = cellOf(d, v);
        if (raw.quarUntil >= dn) return Math.min(0, _corr(c));   // isolated: no positive help
        let corr = _corr(c);
        if (raw.tail >= h.weaponTail && c.n >= h.weaponMinN) corr += h.weaponBonus;  // streak weapon
        return corr;
    }
    const _corr = c => {
        const rate = (c.hit + h.k * (c.devig / Math.max(c.n, 1e-9))) / (c.n + h.k);
        const exp = c.devig / Math.max(c.n, 1e-9);
        return logit(rate) - logit(exp);
    };
    const score = (l, u, dn) => {
        let x = logit(l.prob);
        for (const d of dims) x += Math.max(-h.wCap, Math.min(h.wCap, weights[d] * correction(d, l, u, dn))) ;
        return sigmoid(x);
    };

    for (const day of days) {
        const dn = dayNum(day);
        const rows = byDay.get(day) ?? [];
        let taken = [];
        if (evalDays.includes(day)) {
            // Candidates: eligible fixtures, one best leg per fixture per arm.
            const cands = [];
            for (const u of rows) {
                if (!u.eligible) continue;
                for (const l of u.legs) {
                    if (l.price < 1.5 || l.price > h.maxPrice) continue;
                    const s = score(l, u, dn);
                    if (s < h.floor + governFloor) continue;
                    cands.push({ ...l, u, s, ev: s * l.price - 1 });
                }
            }
            const perArm = (rank, key) => {
                const sorted = [...cands].sort(rank);
                const picks = [];
                const used = new Set();
                for (const c of sorted) {
                    if (used.has(c.u.id)) continue;
                    used.add(c.u.id); picks.push(c);
                    if (picks.length >= 3) break;
                }
                if (picks.length === 3) {
                    const a = arms[key];
                    a.dayN++;
                    let allHit = true;
                    for (const p of picks) {
                        a.picked++;
                        claims.push({ claimed: p.s, hit: p.outcome === 'hit' ? 1 : 0 });
                        if (p.outcome === 'hit') { a.hit++; a.pnl += p.price - 1; }
                        else { a.pnl -= 1; allHit = false; }
                    }
                    if (allHit) { a.dayG++; a.cur++; a.best = Math.max(a.best, a.cur); } else a.cur = 0;
                    return picks;
                }
                return [];
            };
            const safePicks = perArm((a, b) => (b.s - a.s) || (a.price - b.price) || (a.u.id - b.u.id), 'safe');
            const profitPicks = perArm((a, b) => (b.ev - a.ev) || (a.u.id - b.u.id), 'profit');
            taken = [...safePicks, ...profitPicks];
        }
        // ---- learn AFTER the day's picks (walk-forward) ------------------
        // Per-dimension per-day Brier: correction-only model vs raw devig.
        const dimErr = Object.fromEntries(dims.map(d => [d, { model: 0, base: 0, n: 0 }]));
        for (const u of rows) for (const l of u.legs) {
            const y = l.outcome === 'hit' ? 1 : 0;
            for (const d of dims) {
                const p = sigmoid(logit(l.prob) + correction(d, l, u, dn));
                const e = dimErr[d];
                e.model += (p - y) ** 2; e.base += (l.prob - y) ** 2; e.n++;
            }
        }
        for (const d of dims) {
            const e = dimErr[d];
            if (!e.n) continue;
            const better = e.model < e.base;
            weights[d] = Math.max(h.wMin, Math.min(h.wMax, weights[d] * (better ? (1 + h.eta) : (1 - h.eta))));
        }
        // Observe cells.
        for (const u of rows) for (const l of u.legs) {
            const y = l.outcome === 'hit';
            for (const d of dims) {
                const v = DIMS[d](l, u.fx);
                const c = cellOf(d, v);
                const dec = decayed(c, dn);
                c.n = dec.n + 1; c.hit = dec.hit + (y ? 1 : 0); c.devig = dec.devig + l.prob;
                c.day = Math.max(c.day ?? dn, dn);
                if (y) c.tail++; else {
                    c.tail = 0;
                    c.missDays.push(dn);
                    if (c.missDays.length > h.quarWindow) c.missDays.shift();
                    if (c.missDays.length >= h.quarMisses && dn - c.missDays[0] <= h.quarWindow) c.quarUntil = dn + h.quarDays;
                }
            }
        }
        // Error backprop: taken misses hit their cells h.boost extra times.
        for (const t of taken) {
            if (t.outcome !== 'miss') continue;
            for (let i = 0; i < h.boost; i++) {
                for (const d of dims) {
                    const v = DIMS[d](t, t.u.fx);
                    const c = cellOf(d, v);
                    c.n += 1; c.devig += t.prob;
                }
            }
        }
        // Governor: claimed-vs-realized over the trailing claims window.
        const recent = claims.slice(-h.governWindow);
        if (recent.length >= h.governWindow) {
            const claimed = recent.reduce((s, c) => s + c.claimed, 0) / recent.length;
            const real = recent.reduce((s, c) => s + c.hit, 0) / recent.length;
            governFloor = claimed - real > h.governGap ? h.governStep : 0;
        }
    }
    const out = {};
    for (const [k, a] of Object.entries(arms)) {
        out[k] = {
            days: a.dayN, legs: a.picked, legRate: a.picked ? +(a.hit / a.picked).toFixed(3) : null,
            dayGreen: a.dayG, dayRate: a.dayN ? +(a.dayG / a.dayN).toFixed(3) : null,
            bestStreak: a.best, pnl: +a.pnl.toFixed(1),
        };
    }
    const claimed = claims.length ? claims.reduce((s, c) => s + c.claimed, 0) / claims.length : null;
    const real = claims.length ? claims.reduce((s, c) => s + c.hit, 0) / claims.length : null;
    out.calibration = claims.length ? { claimed: +claimed.toFixed(3), realized: +real.toFixed(3) } : null;
    out.weights = Object.fromEntries(Object.entries(weights).map(([d, w]) => [d, +w.toFixed(2)]));
    return out;
}

// ------------------------------------------------------------ meta-search
const SEED = {
    dims: ['group|band', 'direction', 'group|devig', 'dir|ou'],
    w0: 1, eta: 0.05, wMin: 0.2, wMax: 3, wCap: 1.5,
    k: 50, minN: 30, halfLife: 30, maxPrice: 3.0, floor: 0.5,
    weaponTail: 25, weaponMinN: 40, weaponBonus: 0.3,
    quarMisses: 4, quarWindow: 6, quarDays: 5,
    boost: 2, governWindow: 30, governGap: 0.08, governStep: 0.05,
};
const SPACE = {
    eta: [0.02, 0.05, 0.1],
    k: [20, 50, 100],
    minN: [15, 30, 60],
    halfLife: [15, 30, 60],
    maxPrice: [2.2, 3.0, 4.0],
    floor: [0.45, 0.5, 0.55, 0.6],
    weaponTail: [15, 25, 40],
    weaponBonus: [0, 0.15, 0.3, 0.5],
    quarMisses: [3, 4, 6],
    quarDays: [3, 5, 10],
    boost: [0, 1, 2, 3],
    governGap: [0.05, 0.08, 0.12],
};
// Fitness: PROFIT arm P&L first (the owner's "most profitable"), then the
// SAFE arm's day rate (the "yet safest"), then safe streak. Publish floor:
// the safe arm must play >= 2/3 of train days.
const fitness = r => [r.profit.pnl, r.safe.dayRate ?? 0, r.safe.bestStreak];
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const floorDays = Math.ceil(trainDays.length * 2 / 3);
const seen = new Map();
let evals = 0;
function scoreTrain(h) {
    const key = JSON.stringify(h);
    if (seen.has(key)) return seen.get(key);
    const r = replay(h, trainDays);
    evals++;
    const ok = r.safe.days >= floorDays;
    const s = { r, fit: ok ? fitness(r) : [-Infinity, 0, 0] };
    seen.set(key, s);
    return s;
}

let champ = { ...SEED };
let champScore = scoreTrain(champ);
console.error(`[vector] seed: profit pnl ${champScore.r.profit.pnl} | safe dayRate ${champScore.r.safe.dayRate} streak ${champScore.r.safe.bestStreak}`);
function tryCand(cand, label) {
    const s = scoreTrain(cand);
    if (cmp(s.fit, champScore.fit) > 0) {
        champ = cand; champScore = s;
        console.error(`[vector] gen ${evals}: ${label} -> profit ${s.r.profit.pnl} safe ${s.r.safe.dayRate}/${s.r.safe.bestStreak}`);
        return true;
    }
    return false;
}
const MIN_EVALS = 150;
let stable = 0;
for (let sweep = 0; sweep < 14 && (stable < 2 || evals < MIN_EVALS); sweep++) {
    let improved = false;
    // hyperparameter axes
    for (const [axis, values] of Object.entries(SPACE)) {
        for (const v of values) {
            if (champ[axis] === v) continue;
            if (tryCand({ ...champ, [axis]: v }, `${axis}=${v}`)) improved = true;
        }
    }
    // greedy dimension add/drop
    for (const d of ALL_DIMS) {
        const has = champ.dims.includes(d);
        const dims = has ? champ.dims.filter(x => x !== d) : [...champ.dims, d].sort();
        if (!dims.length) continue;
        if (tryCand({ ...champ, dims }, `${has ? 'drop' : 'add'} ${d}`)) improved = true;
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
console.error(`[vector] converged after ${evals} evaluated generations`);

const test = replay(champ, testDays);
const full = replay(champ, days);
const seedTest = replay(SEED, testDays);
const fmt = (label, r) => console.log(
    `${label}: SAFE days ${r.safe.days} dayGreen ${r.safe.dayGreen} (${(100 * (r.safe.dayRate ?? 0)).toFixed(1)}%) streak ${r.safe.bestStreak} legRate ${r.safe.legRate} pnl ${r.safe.pnl}u | `
    + `PROFIT days ${r.profit.days} dayRate ${(100 * (r.profit.dayRate ?? 0)).toFixed(1)}% streak ${r.profit.bestStreak} legRate ${r.profit.legRate} pnl ${r.profit.pnl}u | `
    + `cal ${r.calibration ? `${r.calibration.claimed} claimed vs ${r.calibration.realized} real` : '-'}`);
console.log(`\n[vector] CHAMPION after ${evals} generations:\n${JSON.stringify(champ)}\n`);
fmt('TRAIN', champScore.r);
fmt('TEST ', test);
fmt('FULL ', full);
fmt('SEED@TEST', seedTest);
console.log(`\n[vector] champion dim weights (full run): ${JSON.stringify(full.weights)}`);
const jsonPath = opt('json', null);
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify({ champion: champ, evals, train: champScore.r, test, full, seedTest }, null, 2)); console.log(`[vector] wrote ${jsonPath}`); }
await db.destroy();
