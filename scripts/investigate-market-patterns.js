// Independent wide-net investigation (2026-08-08 owner directive): odds
// markets vs fixture outcomes over the immutable warehouse record. Every
// settled menu leg of every fixture with PRE-KICKOFF odds becomes a feature
// vector; every dimension is scored for real information content; unbroken-
// streak cells are validated FORWARD from first detection (selection-bias
// free: a streak spotted on day d is judged only on days > d).
//
// Read-only. Deterministic. Usage:
//   node scripts/investigate-market-patterns.js [--json tmp/patterns.json]
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

// ------------------------------------------------------------------ features
const dirOf = m => /^U |^NG$|^TT:.:U /.test(m) ? 'UNDER' : /^O |^GG$|^TT:.:O /.test(m) ? 'OVER' : 'RESULT';
const probBand = p => (Math.floor(p * 20) / 20).toFixed(2);            // 0.05 steps
const favBand = p => p == null ? 'na' : p <= 1.3 ? 'strong' : p <= 1.7 ? 'medium' : p <= 2.4 ? 'mild' : 'level';
const ouBand = p => p == null ? 'na' : p >= 0.62 ? 'goals-heavy' : p >= 0.5 ? 'goals-lean' : p >= 0.38 ? 'tight' : 'defensive';
const divBand = d => d == null ? 'na' : d < 0.02 ? 'agree' : d < 0.06 ? 'close' : 'split';
const hourBand = h => h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';

// The wide net: each entry maps a leg+fixture context to ONE categorical value.
export const DIMENSIONS = {
    group: (l) => groupOf(l.market),
    market: (l) => l.market,
    band: (l) => bandOf(l.price),
    'group|band': (l) => `${groupOf(l.market)}|${bandOf(l.price)}`,
    'market|band': (l) => `${l.market}|${bandOf(l.price)}`,
    direction: (l) => dirOf(l.market),
    'dir|band': (l) => `${dirOf(l.market)}|${bandOf(l.price)}`,
    devig: (l) => probBand(l.prob),
    'group|devig': (l) => `${groupOf(l.market)}|${probBand(l.prob)}`,
    fav: (l, f) => favBand(f.favPrice),
    'group|fav': (l, f) => `${groupOf(l.market)}|${favBand(f.favPrice)}`,
    'dir|ou': (l, f) => `${dirOf(l.market)}|${ouBand(f.impliedOver)}`,
    'group|ou': (l, f) => `${groupOf(l.market)}|${ouBand(f.impliedOver)}`,
    country: (l, f) => f.country || 'na',
    'group|country': (l, f) => `${groupOf(l.market)}|${f.country || 'na'}`,
    dow: (l, f) => String(f.dow),
    'group|dow': (l, f) => `${groupOf(l.market)}|${f.dow}`,
    hour: (l, f) => hourBand(f.hour),
    'div|band': (l, f) => `${divBand(f.divergence)}|${bandOf(l.price)}`,
    'group|div': (l, f) => `${groupOf(l.market)}|${divBand(f.divergence)}`,
    'tipagree': (l, f) => f.tipDir == null ? 'no-tip' : (f.tipDir === dirOf(l.market) ? 'with-tip' : 'cross-tip'),
    'group|tipagree': (l, f) => `${groupOf(l.market)}|${f.tipDir == null ? 'no-tip' : (f.tipDir === dirOf(l.market) ? 'with' : 'cross')}`,
};

// ------------------------------------------------------------------ data prep
const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[patterns] loading...');
const raw = await load();
const ix = index(raw);
const tipDirByFixture = new Map();
for (const f of raw.fixtures) {
    const d = derive(f, ix, cfg, null);
    if (d?.tip) tipDirByFixture.set(d.id, dirOf(d.tip.market));
}
const universe = [];   // [{ day, fx: {features}, legs: [{market, price, prob, outcome}] }]
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
    // Fixture-context features from the same pre-kickoff snapshot.
    const one = menu['1']?.price, x = menu['X']?.price, two = menu['2']?.price;
    const favPrice = [one, two].filter(p => p != null).sort((a, b) => a - b)[0] ?? null;
    const over25 = menu['O 2.5']?.prob ?? null;
    // Cross-provider divergence on the favourite: relative price gap.
    let divergence = null;
    const byProv = new Map();
    for (const r of rows) {
        if (r.type_name !== '1X2' && !/^1x2$/i.test(r.type_name ?? '')) continue;
        const p = Number(r.price);
        if (!(p > 1)) continue;
        const k = `${r.provider}|${r.name}`;
        if (!byProv.has(k) || p < byProv.get(k)) byProv.set(k, p);
    }
    const provs = [...new Set(rows.map(r => r.provider))];
    if (provs.length >= 2 && favPrice != null) {
        const perProv = provs.map(pr => {
            const c = [byProv.get(`${pr}|1`), byProv.get(`${pr}|2`)].filter(p => p != null).sort((a, b) => a - b)[0];
            return c ?? null;
        }).filter(p => p != null);
        if (perProv.length >= 2) divergence = Math.abs(perProv[0] - perProv[1]) / Math.min(...perProv);
    }
    const ko = new Date(f.kickoff);
    universe.push({
        day: f.day,
        fx: {
            favPrice, impliedOver: over25, divergence,
            country: f.country ?? '', dow: ko.getUTCDay(), hour: (ko.getUTCHours() + 3) % 24,
            tipDir: tipDirByFixture.get(f.id) ?? null,
        },
        legs,
    });
}
universe.sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
const days = [...new Set(universe.map(u => u.day))].sort();
const totalLegs = universe.reduce((s, u) => s + u.legs.length, 0);
console.error(`[patterns] ${universe.length} fixtures, ${totalLegs} settled legs, ${days.length} days`);

// -------------------------------------- dimension information content (full)
// Per dimension: weighted mean absolute deviation of cell hit-rate from the
// cell's mean devig expectation (n>=30 cells only) = how much the dimension
// KNOWS beyond the market's own pricing. Also a shuffle-free significance
// proxy: deviation in units of the binomial SE.
const report = {};
for (const [dim, fn] of Object.entries(DIMENSIONS)) {
    const cells = new Map();
    for (const u of universe) for (const l of u.legs) {
        const v = fn(l, u.fx);
        let c = cells.get(v); if (!c) cells.set(v, c = { n: 0, hit: 0, devig: 0, pnl: 0, px: 0 });
        c.n++; c.devig += l.prob; c.px += l.price;
        if (l.outcome === 'hit') { c.hit++; c.pnl += l.price - 1; } else c.pnl -= 1;
    }
    let wDev = 0, wN = 0, sig = 0, sigCells = [];
    for (const [v, c] of cells) {
        if (c.n < 30) continue;
        const rate = c.hit / c.n, exp = c.devig / c.n;
        const se = Math.sqrt(Math.max(exp * (1 - exp), 1e-9) / c.n);
        const z = (rate - exp) / se;
        wDev += Math.abs(rate - exp) * c.n; wN += c.n;
        if (Math.abs(z) >= 2.5) sigCells.push({ v, n: c.n, rate: +rate.toFixed(3), expected: +exp.toFixed(3), z: +z.toFixed(1), roi: +(c.pnl / c.n).toFixed(3), avg_px: +(c.px / c.n).toFixed(2) });
        sig = Math.max(sig, Math.abs(z));
    }
    sigCells.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
    report[dim] = {
        cells: cells.size, weighted_dev: wN ? +(wDev / wN).toFixed(4) : null,
        max_z: +sig.toFixed(1), significant: sigCells.slice(0, 6),
    };
}

// ------------------------------- POSITIVE-ROI cells (the profitable+safe hunt)
const roiFinds = [];
for (const [dim, fn] of Object.entries(DIMENSIONS)) {
    const cells = new Map();
    for (const u of universe) for (const l of u.legs) {
        const v = fn(l, u.fx);
        let c = cells.get(v); if (!c) cells.set(v, c = { n: 0, hit: 0, pnl: 0, px: 0 });
        c.n++; c.px += l.price;
        if (l.outcome === 'hit') { c.hit++; c.pnl += l.price - 1; } else c.pnl -= 1;
    }
    for (const [v, c] of cells) {
        if (c.n < 100 || c.pnl / c.n <= 0.01) continue;
        roiFinds.push({ dim, value: v, n: c.n, rate: +(c.hit / c.n).toFixed(3), avg_px: +(c.px / c.n).toFixed(2), roi: +(c.pnl / c.n).toFixed(3) });
    }
}
roiFinds.sort((a, b) => b.roi - a.roi);

// ------------------------------- unbroken streaks, validated FORWARD only
// Walk days in order; when a (dim,value) cell FIRST reaches an unbroken run
// of >= S legs, freeze the detection day and measure that cell's hit rate on
// STRICTLY LATER days. No selection on the future = honest streak value.
const STREAK_MIN = 25;
const streakFinds = [];
for (const [dim, fn] of Object.entries(DIMENSIONS)) {
    const state = new Map();   // v -> {tail, detectedDay, fwdN, fwdHit, n}
    for (const u of universe) {
        for (const l of u.legs) {
            const v = fn(l, u.fx);
            let s = state.get(v); if (!s) state.set(v, s = { tail: 0, detectedDay: null, fwdN: 0, fwdHit: 0, n: 0 });
            s.n++;
            if (s.detectedDay != null && u.day > s.detectedDay) { s.fwdN++; if (l.outcome === 'hit') s.fwdHit++; }
            if (l.outcome === 'hit') {
                s.tail++;
                if (s.tail >= STREAK_MIN && s.detectedDay == null) s.detectedDay = u.day;
            } else s.tail = 0;
        }
    }
    for (const [v, s] of state) {
        if (s.detectedDay == null || s.fwdN < 20) continue;
        streakFinds.push({
            dim, value: v, detected: s.detectedDay, total_n: s.n,
            forward_n: s.fwdN, forward_rate: +(s.fwdHit / s.fwdN).toFixed(3),
        });
    }
}
streakFinds.sort((a, b) => b.forward_rate - a.forward_rate);

// ----------------------------------------------------------------- output
const ranked = Object.entries(report).sort((a, b) => (b[1].weighted_dev ?? 0) - (a[1].weighted_dev ?? 0));
console.log(`\n[patterns] DIMENSION INFORMATION CONTENT (weighted |rate - devig| over n>=30 cells; max |z|):`);
for (const [dim, r] of ranked) {
    console.log(`  ${dim.padEnd(15)} cells ${String(r.cells).padStart(4)}  dev ${r.weighted_dev ?? '-'}  max|z| ${r.max_z}`);
    for (const c of r.significant.slice(0, 3)) {
        console.log(`      ${String(c.v).padEnd(28)} n ${String(c.n).padStart(5)}  rate ${c.rate}  devig-exp ${c.expected}  z ${c.z}`);
    }
}
console.log(`\n[patterns] FORWARD-VALIDATED UNBROKEN STREAKS (run >= ${STREAK_MIN} at detection; judged on later days only):`);
for (const s of streakFinds.slice(0, 20)) {
    console.log(`  ${s.dim.padEnd(15)} ${String(s.value).padEnd(28)} detected ${s.detected}  forward ${s.forward_rate} over n=${s.forward_n}`);
}
const jsonPath = opt('json', null);
if (jsonPath) { writeFileSync(jsonPath, JSON.stringify({ days: days.length, fixtures: universe.length, legs: totalLegs, dimensions: report, roi_cells: roiFinds, streaks: streakFinds }, null, 2)); console.log(`\n[patterns] wrote ${jsonPath}`); }
await db.destroy();
