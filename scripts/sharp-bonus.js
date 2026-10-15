// Sharp-bets research (2026-10-15): BetPawa slips priced WITH its Win Bonus.
// Read-only over tmp/sharp/fx.ndjson (needs the `bpq` field: BetPawa's own
// per-price win probability, the exact input of its bonus calculator).
//
// Part A - is BetPawa's own probability calibrated? Realized hit rate vs q by
//          market group x price band, per chronological half.
// Part B - walk-forward slips: for each day D, a residual model fit ONLY on
//          days < D estimates P = q + shrunk(mean(hit - q)) per cell; a group
//          knapsack picks exactly N legs (one per fixture, price band
//          [MIN_PRICE, MAX_PRICE]) whose slip odds reach TARGET, maximizing
//          either survival (sum ln P) or value (sum ln P*price). The slip is then
//          priced with betpawaWinBonus and settled on the canonical FT score.
//
// Usage: node scripts/sharp-bonus.js [--target 4] [--min-price 1.3] [--max-price 3]
//        [--legs 3,4,5,6,8,10] [--k 300] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { tipOutcome } from '../src/db/tip-rules.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';
import { betpawaWinBonus } from '../src/db/betpawa-bonus-rules.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = Number(arg('target', 4));
const MIN_PRICE = Number(arg('min-price', 1.3));
const MAX_PRICE = Number(arg('max-price', 3));
const LEGS = String(arg('legs', '3,4,5,6,8,10')).split(',').map(Number);
const K = Number(arg('k', 300));
const WARMUP = Number(arg('warmup', 21));
const WHT = 0.20;
const OUT = arg('json', null);
const ONLY_A = process.argv.includes('--calibration-only');

const fx = readFileSync('tmp/sharp/fx.ndjson', 'utf8').trim().split('\n').map(l => JSON.parse(l));
fx.sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : a.id - b.id));
const days = [...new Set(fx.map(f => f.day))].sort();
const mid = days[Math.floor(days.length / 2)];
const byDay = new Map(days.map(d => [d, []]));
for (const f of fx) byDay.get(f.day).push(f);

// BetPawa legs carrying its own probability.
for (const f of fx) {
    f.legs = [];
    const bag = f.prov.betpawa ?? {};
    for (const [m, price] of Object.entries(bag)) {
        const q = f.bpq?.[m];
        if (!(q > 0 && q < 1) || !(price > 1)) continue;
        // DNB: BetPawa's winProbability excludes the draw refund, which its
        // calculator adds back via voidProbability - not stored here, so a DNB
        // leg would get an overstated bonus. Excluded.
        if (/^DNB/.test(m)) continue;
        let outcome; try { outcome = tipOutcome(m, f.ft[0], f.ft[1]); } catch { continue; }
        f.legs.push({ fid: f.id, m, g: groupOf(m), b: bandOf(price), price, q, outcome, margin: 1 / (q * price) });
    }
}

// ---------------- Part A: calibration of BetPawa's own probability --------
const cal = new Map();
for (const f of fx) {
    const h = f.day < mid ? 1 : 2;
    for (const l of f.legs) {
        if (l.outcome === 'void') continue;
        for (const key of [`ALL|${l.b}`, `${l.g}|${l.b}`]) {
            const c = cal.get(key) ?? { n: 0, hit: 0, q: 0, ev: 0, n1: 0, h1: 0, q1: 0, n2: 0, h2: 0, q2: 0 };
            const hit = l.outcome === 'hit' ? 1 : 0;
            c.n++; c.hit += hit; c.q += l.q; c.ev += hit * l.price - 1;
            if (h === 1) { c.n1++; c.h1 += hit; c.q1 += l.q; } else { c.n2++; c.h2 += hit; c.q2 += l.q; }
            cal.set(key, c);
        }
    }
}
const calRows = [...cal].filter(([, c]) => c.n >= 300).map(([k, c]) => ({
    cell: k, n: c.n, q: +(c.q / c.n).toFixed(4), real: +(c.hit / c.n).toFixed(4),
    lift: +((c.hit - c.q) / c.n).toFixed(4),
    lift1: c.n1 ? +((c.h1 - c.q1) / c.n1).toFixed(4) : null,
    lift2: c.n2 ? +((c.h2 - c.q2) / c.n2).toFixed(4) : null,
    roi: +(c.ev / c.n).toFixed(3),
}));
console.log(`fixtures=${fx.length} days=${days.length} split=${mid}`);
console.log('\n== A. BetPawa own probability vs realized (lift = realized - q; positive in BOTH halves = they under-rate it) ==');
console.table(calRows.filter(r => r.cell.startsWith('ALL|')).sort((a, b) => a.cell < b.cell ? -1 : 1));
console.table(calRows.filter(r => !r.cell.startsWith('ALL|') && r.lift1 > 0 && r.lift2 > 0).sort((a, b) => b.lift - a.lift).slice(0, 30));
if (ONLY_A) process.exit(0);

// ---------------- Part B: walk-forward bonus slips --------------------------
const cellKeyOf = l => `${l.g}|${l.b}`;
function makeModel() {
    const cells = new Map();
    return {
        observe(l) {
            if (l.outcome === 'void') return;
            const c = cells.get(cellKeyOf(l)) ?? { n: 0, r: 0 };
            c.n++; c.r += (l.outcome === 'hit' ? 1 : 0) - l.q;
            cells.set(cellKeyOf(l), c);
        },
        prob(l) {
            const c = cells.get(cellKeyOf(l));
            return Math.min(0.995, Math.max(0.005, l.q + (c ? c.r / (c.n + K) : 0)));
        },
    };
}

const STEP = 0.01, NEED = Math.ceil(Math.log(TARGET) / STEP);
// Exactly-n group knapsack; score(l) is the per-leg log objective to maximize.
function pickSlip(cands, n, score) {
    const byFix = new Map();
    for (const c of cands) { const a = byFix.get(c.fid) ?? []; a.push(c); byFix.set(c.fid, a); }
    let dp = Array.from({ length: n + 1 }, () => new Map());
    dp[0].set(0, { s: 0, legs: [] });
    for (const legs of byFix.values()) {
        const nxt = dp.map(m => new Map(m));
        for (let k = 0; k < n; k++) {
            for (const [v, st] of dp[k]) {
                for (const l of legs) {
                    const nv = Math.min(NEED, v + Math.floor(Math.log(l.price) / STEP));
                    const s = st.s + score(l);
                    const cur = nxt[k + 1].get(nv);
                    if (!cur || s > cur.s) nxt[k + 1].set(nv, { s, legs: [...st.legs, l] });
                }
            }
        }
        dp = nxt;
    }
    return dp[n].get(NEED)?.legs ?? null;
}

const OBJECTIVES = {
    survival: l => Math.log(l.P),
    value: l => Math.log(l.P * l.price),
};
const runs = [];
for (const n of LEGS) {
    for (const [oname, score] of Object.entries(OBJECTIVES)) {
        const model = makeModel();
        const slips = [];
        for (let i = 0; i < days.length; i++) {
            const d = days[i], dayFx = byDay.get(d);
            if (i >= WARMUP) {
                const cands = [];
                for (const f of dayFx) {
                    const ls = f.legs.filter(l => l.price >= MIN_PRICE && l.price <= MAX_PRICE)
                        .map(l => ({ ...l, P: model.prob(l) }))
                        .sort((a, b) => score(b) / Math.log(b.price) - score(a) / Math.log(a.price))
                        .slice(0, 3);
                    cands.push(...ls);
                }
                // Pool by efficiency (objective per unit of log-odds), never by raw
                // score: a raw-survival pool fills with 1.3x legs that can never
                // reach the target (the 2026-08-08 silent zero-publish trap).
                cands.sort((a, b) => score(b) / Math.log(b.price) - score(a) / Math.log(a.price));
                const legs = pickSlip(cands.slice(0, 150), n, score);
                if (legs) {
                    const bonus = betpawaWinBonus(legs.map(l => ({ price: l.price, winProbability: l.q })));
                    const voided = legs.some(l => l.outcome === 'void');
                    const won = legs.every(l => l.outcome === 'hit' || l.outcome === 'void');
                    // A voided leg drops out at price 1; re-price the bonus on the rest.
                    const live = legs.filter(l => l.outcome !== 'void');
                    const paid = voided ? betpawaWinBonus(live.map(l => ({ price: l.price, winProbability: l.q }))).totalOdds : bonus.totalOdds;
                    slips.push({
                        day: d, legs: legs.map(l => ({ fid: l.fid, m: l.m, price: l.price, q: l.q, P: +l.P.toFixed(4), outcome: l.outcome })),
                        odds: bonus.slipOdds, totalOdds: bonus.totalOdds, mult: bonus.multiplier,
                        predP: legs.reduce((a, l) => a * l.P, 1), bookQ: legs.reduce((a, l) => a * l.q, 1),
                        won, ret: won ? paid : 0,
                    });
                }
            }
            for (const f of dayFx) for (const l of f.legs) model.observe(l);
        }
        const N = slips.length, W = slips.filter(s => s.won).length;
        const half = Math.floor(N / 2);
        const roi = a => (a.length ? a.reduce((x, s) => x + s.ret - 1, 0) / a.length : null);
        const roiNet = a => (a.length ? a.reduce((x, s) => x + (s.won ? 1 + (1 - WHT) * (s.ret - 1) : 0) - 1, 0) / a.length : null);
        let run = 0, worst = 0; for (const s of slips) { run = s.won ? 0 : run + 1; worst = Math.max(worst, run); }
        runs.push({
            legs: n, obj: oname, slips: N, wins: W, rate: N ? W / N : null,
            predRate: N ? slips.reduce((a, s) => a + s.predP, 0) / N : null,
            bookRate: N ? slips.reduce((a, s) => a + s.bookQ, 0) / N : null,
            avgOdds: N ? slips.reduce((a, s) => a + s.totalOdds, 0) / N : null,
            avgMult: N ? slips.reduce((a, s) => a + s.mult, 0) / N : null,
            roiGross: roi(slips), roiNetWHT: roiNet(slips), roiH1: roi(slips.slice(0, half)), roiH2: roi(slips.slice(half)),
            worstLosingRun: worst, slipsData: slips,
        });
    }
}
console.log(`\n== B. walk-forward BetPawa slips, target >= ${TARGET}x, legs priced ${MIN_PRICE}-${MAX_PRICE}, bonus applied, k=${K} ==`);
console.table(runs.map(({ slipsData, ...r }) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(3) : v]))));
if (OUT) writeFileSync(OUT, JSON.stringify({ params: { TARGET, MIN_PRICE, MAX_PRICE, LEGS, K, WARMUP }, calRows, runs }, null, 1));
