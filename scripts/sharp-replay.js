// Sharp-bets research, step 2 of 2 (2026-10-15): hindsight-free walk-forward
// replay of daily >= TARGET-odds slips over tmp/sharp/fx.ndjson.
//
// Walk-forward contract: every probability used to pick day D's legs is fit
// ONLY on fixtures whose EAT kickoff day is strictly before D. Settlement uses
// the canonical full-time score. Each slip is placed at ONE bookmaker (an
// accumulator cannot span books), one leg per fixture, no Over 0.5-type
// shorts below MIN_PRICE (owner direction 2026-10-15: fewer games, more yield).
//
// Usage: node scripts/sharp-replay.js [--target 4] [--min-price 1.3] [--max-legs 4]
//        [--cards 1] [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { tipOutcome } from '../src/db/tip-rules.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = Number(arg('target', 4));
const MIN_PRICE = Number(arg('min-price', 1.3));
const MAX_LEGS = Number(arg('max-legs', 4));
const CARDS = Number(arg('cards', 1));
const WARMUP_DAYS = Number(arg('warmup', 21));
const WHT = 0.20;                       // Finance Act 2026: 20% withholding on net winnings
const OUT = arg('json', null);

// ---------------------------------------------------------------- data ----
const fx = readFileSync(arg('file', 'tmp/sharp/fx.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
fx.sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : a.id - b.id));
const days = [...new Set(fx.map(f => f.day))].sort();
const byDay = new Map(days.map(d => [d, []]));
for (const f of fx) byDay.get(f.day).push(f);

// Per-provider devig over complete families; returns { key: {price, p0} }.
const FAMILIES = [['1', 'X', '2'], ['1X', 'X2', '12'], ['GG', 'NG'], ['DNB1', 'DNB2'], ['ODD', 'EVEN']];
for (const l of ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5']) {
    FAMILIES.push([`O ${l}`, `U ${l}`]);
    for (const s of ['H', 'A']) FAMILIES.push([`TT:${s}:O ${l}`, `TT:${s}:U ${l}`]);
}
function devigBag(bag) {
    const out = {};
    if (!bag) return out;
    for (const fam of FAMILIES) {
        const prices = fam.map(k => bag[k]);
        if (prices.some(p => !(p > 1))) continue;
        const inv = prices.map(p => 1 / p), s = inv.reduce((a, b) => a + b, 0);
        if (s < 1.0 || s > 1.30) continue;           // book integrity band (tip-rules DEFAULT_TIP)
        if (fam.length === 3 && fam[0] === '1X') continue; // DC: derive from 1X2 below
        fam.forEach((k, i) => { out[k] = { price: prices[i], p0: inv[i] / s, over: s }; });
    }
    // Double chance priced by its own book but probability from the 1X2 devig
    // (the marketMenu idiom: one consistent book).
    if (out['1'] && out.X && out['2']) {
        const d = { '1X': out['1'].p0 + out.X.p0, X2: out.X.p0 + out['2'].p0, '12': out['1'].p0 + out['2'].p0 };
        for (const k of ['1X', 'X2', '12']) if (bag[k] > 1) out[k] = { price: bag[k], p0: d[k], over: out['1'].over };
    }
    return out;
}

const PROVIDERS = ['betpawa', 'betika'];
// Pre-compute leg candidates per fixture: one row per (provider, market).
for (const f of fx) {
    f.legs = [];
    const dv = Object.fromEntries(PROVIDERS.map(p => [p, devigBag(f.prov[p])]));
    for (const p of PROVIDERS) {
        for (const [m, l] of Object.entries(dv[p])) {
            const other = dv[p === 'betpawa' ? 'betika' : 'betpawa'][m];
            let outcome;
            try { outcome = tipOutcome(m, f.ft[0], f.ft[1]); } catch { continue; }
            f.legs.push({
                fid: f.id, prov: p, m, g: groupOf(m), price: l.price, p0: l.p0, over: l.over,
                pOther: other?.p0 ?? null, priceOther: other?.price ?? null, outcome,
            });
        }
    }
}

// ------------------------------------------------------------ models ----
// Each model: { name, fit(legsBeforeDay), prob(leg) }. Fit is incremental:
// observe() is called with every settled leg of a day AFTER that day is
// scored, so prob() never sees its own day.
function residualModel(name, keyFn, k = 300, pFn = l => l.p0) {
    const cells = new Map();
    return {
        name,
        observe(l) {
            if (l.outcome !== 'hit' && l.outcome !== 'miss') return;
            const key = keyFn(l), c = cells.get(key) ?? { n: 0, r: 0 };
            c.n++; c.r += (l.outcome === 'hit' ? 1 : 0) - pFn(l);
            cells.set(key, c);
        },
        prob(l) {
            const c = cells.get(keyFn(l));
            const base = pFn(l);
            if (!c) return base;
            return Math.min(0.995, Math.max(0.005, base + c.r / (c.n + k)));
        },
    };
}
const consensus = l => (l.pOther != null ? (l.p0 + l.pOther) / 2 : l.p0);
const MODELS = [
    { name: 'market', observe() {}, prob: l => l.p0 },
    residualModel('resid:group|band', l => `${l.g}|${bandOf(l.price)}`),
    residualModel('resid:group|band|prov', l => `${l.g}|${bandOf(l.price)}|${l.prov}`),
    residualModel('resid:market|band|prov', l => `${l.m}|${bandOf(l.price)}|${l.prov}`),
    residualModel('consensus+resid', l => `${l.g}|${bandOf(l.price)}|${l.prov}`, 300, consensus),
];

// --------------------------------------------------------- selection ----
// Group knapsack: at most one leg per fixture, maximize sum ln(p) subject to
// sum ln(price) >= ln(TARGET), legs <= MAX_LEGS. Log-price discretized to 0.01.
const STEP = 0.01, NEED = Math.ceil(Math.log(TARGET) / STEP);
function bestCard(cands) {
    // dp[k][v] = { cost, legs } with v capped at NEED.
    const byFix = new Map();
    for (const c of cands) { const a = byFix.get(c.fid) ?? []; a.push(c); byFix.set(c.fid, a); }
    let dp = Array.from({ length: MAX_LEGS + 1 }, () => new Map());
    dp[0].set(0, { cost: 0, legs: [] });
    for (const legs of byFix.values()) {
        const nxt = dp.map(m => new Map(m));
        for (let k = 0; k < MAX_LEGS; k++) {
            for (const [v, st] of dp[k]) {
                for (const l of legs) {
                    const nv = Math.min(NEED, v + Math.floor(Math.log(l.price) / STEP));
                    const cost = st.cost - Math.log(l.q);
                    const cur = nxt[k + 1].get(nv);
                    if (!cur || cost < cur.cost) nxt[k + 1].set(nv, { cost, legs: [...st.legs, l] });
                }
            }
        }
        dp = nxt;
    }
    let best = null;
    for (let k = 1; k <= MAX_LEGS; k++) {
        const st = dp[k].get(NEED);
        if (st && (!best || st.cost < best.cost)) best = st;
    }
    return best ? best.legs : null;
}

// Candidate pre-filter keeps the knapsack small: per fixture and provider,
// the 3 legs with the best ln(q)/ln(price) efficiency.
function candidates(dayFx, model, prov) {
    const out = [];
    for (const f of dayFx) {
        const ls = f.legs.filter(l => l.prov === prov && l.price >= MIN_PRICE)
            .map(l => ({ ...l, q: model.prob(l) }))
            .filter(l => l.q > 0.05)
            .sort((a, b) => (Math.log(a.q) / Math.log(a.price)) - (Math.log(b.q) / Math.log(b.price)))
            .reverse()
            .slice(0, 3);
        out.push(...ls);
    }
    // Keep the 120 most efficient overall (knapsack is O(F * legs * NEED * K)).
    out.sort((a, b) => (Math.log(b.q) / Math.log(b.price)) - (Math.log(a.q) / Math.log(a.price)));
    return out.slice(0, 120);
}

function settleCard(legs) {
    let odds = 1, won = true, voided = 0;
    for (const l of legs) {
        if (l.outcome === 'void') { voided++; continue; }
        odds *= l.price;
        if (l.outcome !== 'hit') won = false;
    }
    return { odds, won, voided };
}

// -------------------------------------------------------------- replay ----
const results = [];
for (const model of MODELS) {
    const perDay = [];
    for (let i = 0; i < days.length; i++) {
        const d = days[i], dayFx = byDay.get(d);
        if (i >= WARMUP_DAYS) {
            const row = { day: d, cards: [] };
            for (const prov of PROVIDERS) {
                let pool = candidates(dayFx, model, prov);
                for (let c = 0; c < CARDS; c++) {
                    const legs = bestCard(pool);
                    if (!legs) break;
                    const s = settleCard(legs);
                    const pred = legs.reduce((a, l) => a * l.q, 1);
                    row.cards.push({ prov, legs: legs.map(l => ({ fid: l.fid, m: l.m, price: l.price, q: +l.q.toFixed(4), outcome: l.outcome })), pred, ...s });
                    const used = new Set(legs.map(l => l.fid));
                    pool = pool.filter(l => !used.has(l.fid));
                }
            }
            perDay.push(row);
        }
        for (const f of dayFx) for (const l of f.legs) model.observe(l);
    }
    results.push({ model: model.name, perDay });
}

function summarize(perDay, prov) {
    const cards = perDay.flatMap(d => d.cards.filter(c => c.prov === prov).map(c => ({ ...c, day: d.day })));
    const n = cards.length, wins = cards.filter(c => c.won).length;
    const gross = cards.reduce((a, c) => a + (c.won ? c.odds : 0) - 1, 0);
    const net = cards.reduce((a, c) => a + (c.won ? 1 + (1 - WHT) * (c.odds - 1) : 0) - 1, 0);
    const pred = cards.reduce((a, c) => a + c.pred, 0);
    let streak = 0, worst = 0;
    for (const c of cards) { streak = c.won ? 0 : streak + 1; worst = Math.max(worst, streak); }
    const half = Math.floor(n / 2);
    const roi = arr => arr.length ? arr.reduce((a, c) => a + (c.won ? c.odds : 0) - 1, 0) / arr.length : null;
    return {
        prov, cards: n, wins, rate: n ? wins / n : null, predRate: n ? pred / n : null,
        avgOdds: n ? cards.reduce((a, c) => a + c.odds, 0) / n : null,
        avgLegs: n ? cards.reduce((a, c) => a + c.legs.length, 0) / n : null,
        roiGross: n ? gross / n : null, roiNet: n ? net / n : null,
        roiH1: roi(cards.slice(0, half)), roiH2: roi(cards.slice(half)), worstLosingRun: worst,
    };
}

console.log(`days=${days.length} (${days[0]}..${days.at(-1)}) warmup=${WARMUP_DAYS} target=${TARGET}x minPrice=${MIN_PRICE} maxLegs=${MAX_LEGS} cards/prov=${CARDS}`);
const table = [];
for (const r of results) for (const p of PROVIDERS) table.push({ model: r.model, ...summarize(r.perDay, p) });
console.table(table.map(t => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, typeof v === 'number' && !Number.isInteger(v) ? +v.toFixed(3) : v]))));
if (OUT) writeFileSync(OUT, JSON.stringify({ params: { TARGET, MIN_PRICE, MAX_LEGS, CARDS, WARMUP_DAYS }, table, results }, null, 1));
