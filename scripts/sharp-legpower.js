// Sharp-bets research (2026-10-15): leg-level power check for BetPawa slips.
// A slip's realized ROI over ~85 days is noise (SE ~19 points at 4x). The
// edge lives at the leg: if the legs a strategy selects realize at ratio
// r = hits / sum(q) against BetPawa's own probability, an n-leg slip's
// expected return is ~ r^n * E_book, where E_book = prod(q) * bonusOdds is
// the book-fair EV with the Win Bonus (computed exactly per slip).
// Walk-forward: legs for day D are ranked with a model fit on days < D only.
//
// Usage: node scripts/sharp-legpower.js [--top 30] [--min-price 1.3] [--max-price 3]
import { readFileSync } from 'node:fs';
import { tipOutcome } from '../src/db/tip-rules.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';
import { betpawaWinBonus } from '../src/db/betpawa-bonus-rules.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const TOP = Number(arg('top', 30));
const MIN_PRICE = Number(arg('min-price', 1.3));
const MAX_PRICE = Number(arg('max-price', 3));
const K = Number(arg('k', 300));
const WARMUP = 21;

const fx = readFileSync('tmp/sharp/fx.ndjson', 'utf8').trim().split('\n').map(l => JSON.parse(l));
fx.sort((a, b) => (a.ko < b.ko ? -1 : 1));
const days = [...new Set(fx.map(f => f.day))].sort();
const mid = days[Math.floor(days.length / 2)];
const byDay = new Map(days.map(d => [d, []]));
for (const f of fx) byDay.get(f.day).push(f);
for (const f of fx) {
    f.legs = [];
    for (const [m, price] of Object.entries(f.prov.betpawa ?? {})) {
        const q = f.bpq?.[m];
        if (!(q > 0 && q < 1) || /^DNB/.test(m)) continue;
        let outcome; try { outcome = tipOutcome(m, f.ft[0], f.ft[1]); } catch { continue; }
        f.legs.push({ fid: f.id, m, g: groupOf(m), b: bandOf(price), price, q, outcome, lg: f.lid });
    }
}

// Candidate rankers, each walk-forward.
function residual(keyFn) {
    const cells = new Map();
    return {
        observe(l) { const k = keyFn(l), c = cells.get(k) ?? { n: 0, r: 0 }; c.n++; c.r += (l.outcome === 'hit' ? 1 : 0) - l.q; cells.set(k, c); },
        lift(l) { const c = cells.get(keyFn(l)); return c ? c.r / (c.n + K) : 0; },
    };
}
const RANKERS = {
    'book q (no model)': () => ({ observe() {}, score: l => Math.log(l.q) / Math.log(l.price) }),
    'resid group|band': () => { const r = residual(l => `${l.g}|${l.b}`); return { observe: r.observe, score: l => Math.log(Math.min(0.995, l.q + r.lift(l))) / Math.log(l.price) }; },
    'resid market|band': () => { const r = residual(l => `${l.m}|${l.b}`); return { observe: r.observe, score: l => Math.log(Math.min(0.995, l.q + r.lift(l))) / Math.log(l.price) }; },
    'max lift group|band': () => { const r = residual(l => `${l.g}|${l.b}`); return { observe: r.observe, score: l => r.lift(l) / l.q }; },
    'max lift market|band': () => { const r = residual(l => `${l.m}|${l.b}`); return { observe: r.observe, score: l => r.lift(l) / l.q }; },
    'max lift league|group': () => { const r = residual(l => `${l.lg}|${l.g}`); return { observe: r.observe, score: l => r.lift(l) / l.q }; },
};

const rows = [];
for (const [name, make] of Object.entries(RANKERS)) {
    const rk = make();
    const acc = { all: { n: 0, h: 0, q: 0, pr: 0 }, h1: { n: 0, h: 0, q: 0, pr: 0 }, h2: { n: 0, h: 0, q: 0, pr: 0 } };
    const ebook = [];
    for (let i = 0; i < days.length; i++) {
        const d = days[i], dayFx = byDay.get(d);
        if (i >= WARMUP) {
            const best = [];
            for (const f of dayFx) {
                const ls = f.legs.filter(l => l.price >= MIN_PRICE && l.price <= MAX_PRICE && l.outcome !== 'void');
                if (!ls.length) continue;
                best.push(ls.reduce((a, b) => (rk.score(b) > rk.score(a) ? b : a)));   // one leg per fixture
            }
            best.sort((a, b) => rk.score(b) - rk.score(a));
            const pick = best.slice(0, TOP);
            for (const l of pick) {
                for (const k of ['all', d < mid ? 'h1' : 'h2']) {
                    acc[k].n++; acc[k].h += l.outcome === 'hit' ? 1 : 0; acc[k].q += l.q; acc[k].pr += Math.log(l.price);
                }
            }
            // Book-fair EV with bonus of the day's top-3 and top-5 slips.
            for (const n of [3, 5]) {
                const s = pick.slice(0, n);
                if (s.length === n) {
                    const b = betpawaWinBonus(s.map(l => ({ price: l.price, winProbability: l.q })));
                    ebook.push({ n, ev: s.reduce((a, l) => a * l.q, 1) * b.totalOdds, odds: b.slipOdds, mult: b.multiplier });
                }
            }
        }
        for (const f of dayFx) for (const l of f.legs) if (l.outcome !== 'void') rk.observe(l);
    }
    const r = k => (acc[k].n ? acc[k].h / acc[k].q : null);
    const e = n => { const a = ebook.filter(x => x.n === n); return a.length ? a.reduce((s, x) => s + x.ev, 0) / a.length : null; };
    const o = n => { const a = ebook.filter(x => x.n === n); return a.length ? Math.exp(a.reduce((s, x) => s + Math.log(x.odds), 0) / a.length) : null; };
    const rAll = r('all');
    // SE of the ratio from binomial variance of hits.
    const se = acc.all.n ? Math.sqrt(acc.all.q * (1 - acc.all.q / acc.all.n)) / acc.all.q : null;
    rows.push({
        ranker: name, legs: acc.all.n, avgPrice: +Math.exp(acc.all.pr / acc.all.n).toFixed(3),
        hitRate: +(acc.all.h / acc.all.n).toFixed(4), bookQ: +(acc.all.q / acc.all.n).toFixed(4),
        r: +rAll.toFixed(4), rSE: +se.toFixed(4), r1: +r('h1').toFixed(4), r2: +r('h2').toFixed(4),
        Ebook3: +e(3).toFixed(3), odds3: +o(3).toFixed(2), slipEV3: +(rAll ** 3 * e(3)).toFixed(3),
        Ebook5: +e(5).toFixed(3), odds5: +o(5).toFixed(2), slipEV5: +(rAll ** 5 * e(5)).toFixed(3),
    });
}
console.log(`days=${days.length} split=${mid} top=${TOP}/day price ${MIN_PRICE}-${MAX_PRICE} (r = realized hits / BetPawa q; slipEV = r^n * E_book)`);
console.table(rows);
