// Hindsight-free replay of daily multi-leg slips built from 1.50+ tips
// (2026-10-16 owner directive: fewest legs, at least 2.5x, ideally 4x; reduce
// lost cards). Same data and walk-forward calibrator as scripts/replay-picks.js
// (tmp/sharp/fx.ndjson, pick-rules.js residual calibrator, 90-day window).
//
// Per day and per construction: choose exactly LEGS legs, one per game, each
// priced 1.50..MAXP, maximizing the product of our calibrated chances subject
// to combined odds >= TARGET, through the PRODUCTION selector pick-rules.js
// selectSlip (exhaustive over the day's POOL most efficient legs). `pick` = only each game's Pick; `any` = any
// qualifying market of the game.
// Usage: node scripts/replay-slips.js [file=tmp/sharp/fx.ndjson]
import fs from 'node:fs';
import { makePickCalibrator, fixturePick, selectSlip } from '../src/db/pick-rules.js';
import { tipOutcome } from '../src/db/tip-rules.js';

const FILE = process.argv[2] ?? 'tmp/sharp/fx.ndjson';
const WINDOW = 90, WARM = 14, TEST_SHARE = 0.3, POOL = 40;
const VARIANTS = [
    { legs: 2, target: 2.5, maxP: 2.2, src: 'pick' },
    { legs: 2, target: 2.5, maxP: 2.2, src: 'any' },
    { legs: 2, target: 3.0, maxP: 2.2, src: 'any' },
    { legs: 2, target: 4.0, maxP: 3.0, src: 'any' },
    { legs: 3, target: 3.0, maxP: 2.2, src: 'pick' },
    { legs: 3, target: 4.0, maxP: 2.2, src: 'pick' },
    { legs: 3, target: 4.0, maxP: 2.2, src: 'any' },
];

const fx = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(f => Array.isArray(f.ft) && f.ft[0] != null && f.ft[1] != null)
    .sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : 0));
const legsOf = f => Object.entries(f.menu ?? {}).map(([market, [price, prob]]) => ({ market, price, prob }));
const days = [...new Set(fx.map(f => f.day))];
const byDay = new Map(days.map(d => [d, fx.filter(f => f.day === d)]));
const dayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
const cut = days[Math.floor(days.length * (1 - TEST_SHARE))];

const res = VARIANTS.map(() => []);
for (const day of days.slice(WARM)) {
    const cal = makePickCalibrator();
    for (const d of days) {
        if (d >= day || dayNum(day) - dayNum(d) > WINDOW) continue;
        for (const f of byDay.get(d)) for (const leg of legsOf(f)) cal.observe({ ...leg, outcome: tipOutcome(leg.market, f.ft[0], f.ft[1]) });
    }
    VARIANTS.forEach((v, vi) => {
        const cands = [];
        for (const f of byDay.get(day)) {
            const src = v.src === 'pick'
                ? [fixturePick(legsOf(f), cal, { maxPrice: v.maxP })].filter(Boolean)
                : legsOf(f).filter(l => l.price >= 1.5 && l.price <= v.maxP && !/^DNB/.test(l.market) && l.prob > 0 && l.prob < 1)
                    .map(l => ({ ...l, calProb: cal.prob(l) }));
            for (const l of src) {
                const o = tipOutcome(l.market, f.ft[0], f.ft[1]);
                if (o === 'void') continue;
                cands.push({ fid: f.id, market: l.market, price: l.price, P: l.calProb, hit: o === 'hit' });
            }
        }
        const s = selectSlip(cands.map(x => ({ ...x, fixture: x.fid, calProb: x.P })), { legs: v.legs, minOdds: v.target, maxPrice: v.maxP, pool: POOL });
        if (!s) { res[vi].push({ day, none: true }); return; }
        res[vi].push({ day, odds: s.odds, pred: s.chance, won: s.legs.every(l => l.hit), hits: s.legs.filter(l => l.hit).length });
    });
}

if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, JSON.stringify({ cut, variants: VARIANTS, res }));
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
VARIANTS.forEach((v, vi) => {
    const line = [`${v.legs} legs >= ${v.target}x (${v.src}, <= ${v.maxP})`.padEnd(32)];
    for (const [name, rows] of [['train', res[vi].filter(r => r.day < cut)], ['test', res[vi].filter(r => r.day >= cut)]]) {
        const pub = rows.filter(r => !r.none);
        const won = pub.filter(r => r.won).length;
        const pnl = pub.reduce((s, r) => s + (r.won ? r.odds - 1 : -1), 0);
        const odds = pub.reduce((s, r) => s + r.odds, 0) / (pub.length || 1);
        const pred = pub.reduce((s, r) => s + r.pred, 0) / (pub.length || 1);
        let cur = 0, bestRun = 0; for (const r of pub) { if (r.won) { cur++; bestRun = Math.max(bestRun, cur); } else cur = 0; }
        line.push(`${name}: won ${won}/${pub.length} ${pct(won, pub.length)} (pred ${(100 * pred).toFixed(1)}%) avg ${odds.toFixed(2)}x roi ${pct(pnl, pub.length)} run ${bestRun}`);
    }
    console.log(line.join(' | '));
});
