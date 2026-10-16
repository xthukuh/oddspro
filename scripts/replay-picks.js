// Hindsight-free replay of the Pick and the Top-3 picks card (2026-10-16)
// through the PRODUCTION pure module pick-rules.js (its residual calibrator,
// the same 90-day window as src/daily-slip.js; WINDOW=<days> env overrides).
//
// Input: tmp/sharp/fx.ndjson (scripts/sharp-prep.js output: settled, linked
// fixtures with pre-kickoff menus { market: [price, devigProb] } and the
// canonical final score). Read-only; writes nothing.
//
// Walk-forward: day D's calibrator observes only fixtures of days in
// [D - WINDOW, D). The first WARM days only warm it up; the last 30% of days
// are the untouched test tail, reported apart from train.
// Not modelled: the live errorBoost (re-observing missed published legs),
// which needs the live daily_slips ledger.
//
// Usage: node scripts/replay-picks.js [file=tmp/sharp/fx.ndjson]
import fs from 'node:fs';
import { fixturePick, selectTopPicks, picksDayScore, makePickCalibrator, DEFAULT_PICK } from '../src/db/pick-rules.js';
import { tipOutcome } from '../src/db/tip-rules.js';

const FILE = process.argv[2] ?? 'tmp/sharp/fx.ndjson';
const WINDOW = Number(process.env.WINDOW ?? 90), WARM = 14, TEST_SHARE = 0.3;

const fx = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    .filter(f => Array.isArray(f.ft) && f.ft[0] != null && f.ft[1] != null)
    .sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : 0));
const legsOf = f => Object.entries(f.menu ?? {}).map(([market, [price, prob]]) => ({ market, price, prob }));
const days = [...new Set(fx.map(f => f.day))];
const byDay = new Map(days.map(d => [d, fx.filter(f => f.day === d)]));
const dayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
const cut = days[Math.floor(days.length * (1 - TEST_SHARE))];

const perDay = [];
for (const day of days.slice(WARM)) {
    const cal = makePickCalibrator();
    for (const d of days) {
        if (d >= day || dayNum(day) - dayNum(d) > WINDOW) continue;
        for (const f of byDay.get(d)) for (const leg of legsOf(f)) {
            cal.observe({ ...leg, outcome: tipOutcome(leg.market, f.ft[0], f.ft[1]), day: d });
        }
    }
    const games = byDay.get(day).map(f => ({ id: f.id, kickoff: f.ko.replace(' ', 'T') + '+03:00', f, pick: fixturePick(legsOf(f), cal) }));
    const settle = g => ({ ...g.pick, outcome: tipOutcome(g.pick.market, g.f.ft[0], g.f.ft[1]) });
    perDay.push({
        day,
        all: games.filter(g => g.pick).map(settle),
        top: selectTopPicks(games).map(settle),
    });
}

const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
for (const [name, rows] of [['train', perDay.filter(r => r.day < cut)], ['test', perDay.filter(r => r.day >= cut)]]) {
    const all = rows.flatMap(r => r.all).filter(l => l.outcome !== 'void');
    const hit = all.filter(l => l.outcome === 'hit').length;
    const claim = all.reduce((s, l) => s + l.calProb, 0);
    const units = all.reduce((s, l) => s + (l.outcome === 'hit' ? l.price - 1 : -1), 0);
    const filler = all.filter(l => l.price < DEFAULT_PICK.minPrice).length;
    console.log(`${name} (${rows[0]?.day}..${rows.at(-1)?.day}, ${rows.length} days)`);
    console.log(`  every game's Pick : n=${all.length} hit ${pct(hit, all.length)} (claimed ${pct(claim, all.length)}) `
        + `avg price ${(all.reduce((s, l) => s + l.price, 0) / all.length).toFixed(2)} flat ROI ${pct(units, all.length)} | below 1.50: ${filler}`);
    const full = rows.filter(r => r.top.length === DEFAULT_PICK.cardSize);
    const dist = {};
    let profit = 0, two = 0, cur = 0, best = 0, units3 = 0;
    for (const r of full) {
        const s = picksDayScore(r.top);
        dist[s.won] = (dist[s.won] ?? 0) + 1;
        units3 += s.units;
        if (s.won >= 2) two++;
        if (s.outcome === 'won') { profit++; cur++; best = Math.max(best, cur); } else if (s.outcome === 'lost') cur = 0;
    }
    const legs = full.flatMap(r => r.top);
    console.log(`  Top-3 card        : ${full.length} days, picks hit ${pct(legs.filter(l => l.outcome === 'hit').length, legs.length)}, `
        + `2+ of 3 won ${pct(two, full.length)}, profit days ${pct(profit, full.length)} (best run ${best}), `
        + `units ${units3.toFixed(2)} over ${legs.length} stakes, wins-per-day ${JSON.stringify(dist)}`);
}
