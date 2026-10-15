// Sharp-bets research (2026-10-15): combinatorial walk-forward replay.
// One slip per day is too few to measure (ROI SE ~19 points over 85 days at
// 4x). Here each day's top-M walk-forward legs are expanded into EVERY n-leg
// combination whose slip odds land in [MIN_ODDS, MAX_ODDS]; each combination
// is priced with the exact BetPawa Win Bonus and settled on the canonical FT
// score. The per-day average return is "what a randomly chosen qualifying
// slip from today's shortlist pays", and day-averages are then averaged so
// busy days do not dominate. Also reports the single max-survival slip.
//
// Usage: node scripts/sharp-combos.js [--top 10] [--legs 3] [--min-odds 4] [--max-odds 8]
//        [--min-price 1.3] [--max-price 2.5] [--key group|band] [--k 300]
import { readFileSync } from 'node:fs';
import { tipOutcome } from '../src/db/tip-rules.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';
import { betpawaWinBonus } from '../src/db/betpawa-bonus-rules.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const TOP = Number(arg('top', 10));
const N = Number(arg('legs', 3));
const MIN_ODDS = Number(arg('min-odds', 4));
const MAX_ODDS = Number(arg('max-odds', 8));
const MIN_PRICE = Number(arg('min-price', 1.3));
const MAX_PRICE = Number(arg('max-price', 2.5));
const KEY = arg('key', 'group|band');
const K = Number(arg('k', 300));
const WHT = 0.20;
const WARMUP = 21;

const keyFns = {
    'group|band': l => `${l.g}|${l.b}`,
    'market|band': l => `${l.m}|${l.b}`,
    'group': l => l.g,
    'none': () => 'all',
};
const keyFn = keyFns[KEY];

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
        f.legs.push({ fid: f.id, m, g: groupOf(m), b: bandOf(price), price, q, outcome });
    }
}

const cells = new Map();
const lift = l => { const c = cells.get(keyFn(l)); return c ? c.r / (c.n + K) : 0; };
const P = l => Math.min(0.995, l.q + lift(l));

function* combos(arr, n, start = 0, acc = []) {
    if (acc.length === n) { yield acc; return; }
    for (let i = start; i < arr.length; i++) yield* combos(arr, n, i + 1, [...acc, arr[i]]);
}

const day = [];
for (let i = 0; i < days.length; i++) {
    const d = days[i], dayFx = byDay.get(d);
    if (i >= WARMUP) {
        const best = [];
        for (const f of dayFx) {
            const ls = f.legs.filter(l => l.price >= MIN_PRICE && l.price <= MAX_PRICE);
            if (!ls.length) continue;
            best.push(ls.reduce((a, b) => (Math.log(P(b)) / Math.log(b.price) > Math.log(P(a)) / Math.log(a.price) ? b : a)));
        }
        best.sort((a, b) => Math.log(P(b)) / Math.log(b.price) - Math.log(P(a)) / Math.log(a.price));
        const pool = best.slice(0, TOP);
        let n = 0, ret = 0, net = 0, wins = 0, top = null;
        for (const c of combos(pool, N)) {
            const odds = c.reduce((a, l) => a * l.price, 1);
            if (odds < MIN_ODDS || odds > MAX_ODDS) continue;
            const live = c.filter(l => l.outcome !== 'void');
            const won = c.every(l => l.outcome !== 'miss');
            const paid = won ? betpawaWinBonus(live.map(l => ({ price: l.price, winProbability: l.q }))).totalOdds : 0;
            n++; ret += paid; net += won ? 1 + (1 - WHT) * (paid - 1) : 0; wins += won ? 1 : 0;
            const pp = c.reduce((a, l) => a * P(l), 1);
            if (!top || pp > top.pp) top = { pp, won, paid };
        }
        if (n) day.push({ d, n, roi: ret / n - 1, roiNet: net / n - 1, rate: wins / n, top });
    }
    for (const f of dayFx) for (const l of f.legs) {
        if (l.outcome === 'void') continue;
        const k = keyFn(l), c = cells.get(k) ?? { n: 0, r: 0 };
        c.n++; c.r += (l.outcome === 'hit' ? 1 : 0) - l.q; cells.set(k, c);
    }
}

const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
const part = sel => {
    const r = day.filter(sel).map(x => x.roi);
    return { days: r.length, roi: +mean(r).toFixed(4), se: +(sd(r) / Math.sqrt(r.length)).toFixed(4) };
};
const tops = day.map(x => x.top);
const topRoi = tops.reduce((a, t) => a + (t.won ? t.paid : 0) - 1, 0) / tops.length;
const half = Math.floor(tops.length / 2);
const topH = arr => +(arr.reduce((a, t) => a + (t.won ? t.paid : 0) - 1, 0) / arr.length).toFixed(3);
console.log(JSON.stringify({
    params: { TOP, N, MIN_ODDS, MAX_ODDS, MIN_PRICE, MAX_PRICE, KEY, K },
    combosPerDay: Math.round(mean(day.map(x => x.n))),
    winRate: +mean(day.map(x => x.rate)).toFixed(4),
    all: part(() => true), h1: part(x => x.d < mid), h2: part(x => x.d >= mid),
    roiNetWHT: +mean(day.map(x => x.roiNet)).toFixed(4),
    daysPositive: day.filter(x => x.roi > 0).length,
    singleTopSlip: { days: tops.length, wins: tops.filter(t => t.won).length, roi: +topRoi.toFixed(3), h1: topH(tops.slice(0, half)), h2: topH(tops.slice(half)) },
}));
