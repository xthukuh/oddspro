// Sharp-bets research (2026-10-15): where, if anywhere, do settled pre-kickoff
// prices pay more than they cost? Read-only over tmp/sharp/fx.ndjson.
//
// For every (fixture, provider, market) price: ROI of a flat 1u bet at that
// price. Cells are reported with BOTH chronological halves so an edge that
// lives in one half only is visible as the mirage it is. Also scans for
// cross-book arbitrage (best price per outcome across the two books with
// sum(1/price) < 1 on a complete family).
//
// Usage: node scripts/sharp-edges.js [--min-n 400]
import { readFileSync } from 'node:fs';
import { tipOutcome } from '../src/db/tip-rules.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MIN_N = Number(arg('min-n', 400));
const fx = readFileSync('tmp/sharp/fx.ndjson', 'utf8').trim().split('\n').map(l => JSON.parse(l));
fx.sort((a, b) => (a.ko < b.ko ? -1 : 1));
const days = [...new Set(fx.map(f => f.day))].sort();
const mid = days[Math.floor(days.length / 2)];

const FAMILIES = [['1', 'X', '2'], ['GG', 'NG'], ['DNB1', 'DNB2'], ['ODD', 'EVEN'], ['1X', '2'], ['X2', '1'], ['12', 'X']];
for (const l of ['0.5', '1.5', '2.5', '3.5', '4.5', '5.5', '6.5']) {
    FAMILIES.push([`O ${l}`, `U ${l}`]);
    for (const s of ['H', 'A']) FAMILIES.push([`TT:${s}:O ${l}`, `TT:${s}:U ${l}`]);
}
const fam2 = new Map();
for (const fam of FAMILIES.filter(f => !(f.length === 2 && ['1X', 'X2', '12'].includes(f[0])))) for (const k of fam) fam2.set(k, fam);

const cells = new Map();
const bump = (key, half, ret) => {
    const c = cells.get(key) ?? { n: 0, ret: 0, n1: 0, r1: 0, n2: 0, r2: 0 };
    c.n++; c.ret += ret;
    if (half === 1) { c.n1++; c.r1 += ret; } else { c.n2++; c.r2 += ret; }
    cells.set(key, c);
};
const arbs = [];
for (const f of fx) {
    const half = f.day < mid ? 1 : 2;
    const bags = f.prov;
    for (const [prov, bag] of Object.entries(bags)) {
        const other = bags[prov === 'betpawa' ? 'betika' : 'betpawa'];
        for (const [m, price] of Object.entries(bag)) {
            let o; try { o = tipOutcome(m, f.ft[0], f.ft[1]); } catch { continue; }
            const ret = o === 'void' ? 0 : o === 'hit' ? price - 1 : -1;
            const g = groupOf(m), b = bandOf(price);
            bump(`A|${prov}|${g}|${b}`, half, ret);
            bump(`M|${prov}|${m}|${b}`, half, ret);
            // Line shopping: is this book's price the strictly better one?
            const op = other?.[m];
            if (op > 1) {
                const rel = price / op;
                const rb = rel >= 1.10 ? '>=+10%' : rel >= 1.05 ? '+5..10%' : rel >= 1.02 ? '+2..5%' : rel > 0.98 ? 'same' : 'worse';
                bump(`S|${prov}|${rb}`, half, ret);
                bump(`SB|${prov}|${rb}|${b}`, half, ret);
            }
        }
    }
    // Arbitrage over complete families using the best price per outcome.
    for (const fam of FAMILIES) {
        const best = fam.map(k => {
            const ps = Object.entries(bags).map(([p, bag]) => [p, bag[k]]).filter(([, v]) => v > 1);
            if (!ps.length) return null;
            return ps.reduce((a, b) => (b[1] > a[1] ? b : a));
        });
        if (best.some(b => !b)) continue;
        const s = best.reduce((a, [, p]) => a + 1 / p, 0);
        if (s < 1) arbs.push({ day: f.day, fid: f.id, fam: fam.join('/'), margin: 1 / s - 1, legs: best.map(([p, v], i) => `${fam[i]}@${v}(${p})`).join(' ') });
    }
}

const fmt = c => ({ n: c.n, roi: +(c.ret / c.n).toFixed(3), n1: c.n1, roi1: c.n1 ? +(c.r1 / c.n1).toFixed(3) : null, n2: c.n2, roi2: c.n2 ? +(c.r2 / c.n2).toFixed(3) : null });
const show = (prefix, title, filter = () => true) => {
    const rows = [...cells].filter(([k, c]) => k.startsWith(prefix + '|') && c.n >= MIN_N && filter(c))
        .map(([k, c]) => ({ cell: k.slice(prefix.length + 1), ...fmt(c) }))
        .sort((a, b) => b.roi - a.roi);
    console.log(`\n== ${title} (split at ${mid}) ==`);
    console.table(rows.slice(0, 40));
};
console.log(`fixtures=${fx.length} days=${days.length} ${days[0]}..${days.at(-1)}`);
show('S', 'line shopping: ROI by this-book price vs other book');
show('SB', 'line shopping x price band (both halves positive only)', c => c.r1 > 0 && c.r2 > 0);
show('A', 'group x band x provider, both halves positive', c => c.r1 > 0 && c.r2 > 0);
show('M', 'market x band x provider, both halves positive', c => c.r1 > 0 && c.r2 > 0);
const bigArbs = arbs.filter(a => a.margin > 0.15).length;
const real = arbs.filter(a => a.margin <= 0.15);
console.log(`\n== arbitrage: ${arbs.length} families with sum(1/best) < 1 (${bigArbs} above 15% margin = likely mislinks/errors, excluded) ==`);
const byDay = {};
for (const a of real) (byDay[a.day] ??= []).push(a);
const perDay = Object.values(byDay).map(v => v.length);
console.log(`days with >=1 arb: ${Object.keys(byDay).length}/${days.length}; arbs/day median ${perDay.sort((a, b) => a - b)[Math.floor(perDay.length / 2)] ?? 0}; mean margin ${(real.reduce((a, b) => a + b.margin, 0) / Math.max(1, real.length) * 100).toFixed(2)}%`);
const byFam = {};
for (const a of real) { const k = a.fam.replace(/\d\.5/g, 'N.5'); (byFam[k] ??= { n: 0, m: 0 }); byFam[k].n++; byFam[k].m += a.margin; }
console.table(Object.entries(byFam).map(([k, v]) => ({ fam: k, n: v.n, avgMarginPct: +(100 * v.m / v.n).toFixed(2) })).sort((a, b) => b.n - a.n));
console.log(real.sort((a, b) => b.margin - a.margin).slice(0, 8));
