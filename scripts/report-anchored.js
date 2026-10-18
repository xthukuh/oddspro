// Forward report of the Sharp-anchored Pick shadow (2026-10-18): per-day
// legs, hit rate against Pinnacle's claim, flat ROI with its standard error,
// and the pass bar (30 forward days, >= 400 legs, ROI > 0 with the lower 95%
// bound > -2%, hit within 2 points of Pinnacle's claim). Read-only.
//
// Two populations, both from anchored_picks (src/reference-odds.js):
//   pool - every eligible leg (one per game, ratio >= 1.02): the pass bar
//          applies here, it is the only population large enough for 400 legs;
//   card - the day's top 3 (strong first), scored as singles.
// The strong subset (ratio >= 1.04) is reported alongside.
//
// Usage: node scripts/report-anchored.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days] [--json out.json]
import fs from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { anchorSummary, anchorPassBar, legUnits } from '../src/db/anchor-rules.js';

const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const FROM = opt('--from'), TO = opt('--to'), JSON_OUT = opt('--json'), SHOW_DAYS = argv.includes('--days');

const pct = v => (v == null ? '-' : `${(100 * v).toFixed(1)}%`);
const line = (name, s) => `${name.padEnd(7)} n=${String(s.n).padStart(4)}  hit ${pct(s.hitRate)} vs Pinnacle ${pct(s.claim)}  `
    + `units ${s.units >= 0 ? '+' : ''}${s.units.toFixed(2)}  ROI ${pct(s.roi)} +- ${pct(s.se)}  lower95 ${pct(s.lo95)}`;

try {
    const q = db('anchored_picks as a')
        .join('fixtures as f', 'f.id', 'a.fixture_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .select(db.raw("DATE_FORMAT(a.pick_date, '%Y-%m-%d') AS day"), 'a.fixture_id', 'a.market', 'a.price', 'a.provider',
            'a.ref_price', 'a.fair_prob', 'a.ratio', 'a.strong', 'a.on_card', 'a.outcome', 'a.score',
            'th.name as home', 'ta.name as away')
        .orderBy([{ column: 'a.pick_date' }, { column: 'a.on_card', order: 'desc' }, { column: 'a.ratio', order: 'desc' }]);
    if (FROM) q.where('a.pick_date', '>=', FROM);
    if (TO) q.where('a.pick_date', '<=', TO);
    const rows = (await q).map(r => ({
        ...r, price: Number(r.price), ref_price: Number(r.ref_price), fair: Number(r.fair_prob),
        ratio: Number(r.ratio), strong: !!r.strong, on_card: !!r.on_card,
    }));

    const settled = rows.filter(r => r.outcome === 'hit' || r.outcome === 'miss');
    const pending = rows.filter(r => r.outcome == null).length;
    const days = [...new Set(settled.map(r => r.day))];
    const perDay = days.map(day => {
        const d = settled.filter(r => r.day === day);
        return { day, pool: anchorSummary(d), card: anchorSummary(d.filter(r => r.on_card)), cardLegs: d.filter(r => r.on_card) };
    });

    console.log(`Sharp-anchored Pick shadow: ${rows.length} legs stored, ${settled.length} settled over ${days.length} day(s), ${pending} pending`
        + `${FROM || TO ? ` (window ${FROM ?? '..'} .. ${TO ?? '..'})` : ''}\n`);
    console.log('day          pool n  hit   units  | card (singles)');
    for (const d of perDay) {
        const card = d.cardLegs.map(l => `${l.market}@${l.price.toFixed(2)} x${l.ratio.toFixed(3)}${l.strong ? '*' : ''} ${l.outcome === 'hit' ? 'W' : 'L'}`).join(', ');
        const cu = d.cardLegs.reduce((s, l) => s + legUnits(l), 0);
        console.log(`${d.day}  ${String(d.pool.n).padStart(6)}  ${String(d.pool.hits).padStart(3)}  ${d.pool.units >= 0 ? '+' : ''}${d.pool.units.toFixed(2).padStart(5)}  | `
            + `${cu >= 0 ? '+' : ''}${cu.toFixed(2)}  ${card || '-'}`);
        if (SHOW_DAYS) {
            for (const l of settled.filter(r => r.day === d.day)) {
                console.log(`    ${l.on_card ? 'C' : ' '} ${l.home} v ${l.away}: ${l.market} @ ${l.price.toFixed(2)} (${l.provider}) Pinnacle ${l.ref_price.toFixed(2)} fair ${pct(l.fair)} x${l.ratio.toFixed(4)} -> ${l.outcome} ${l.score ?? ''}`);
            }
        }
    }

    const pool = anchorSummary(settled);
    const card = anchorSummary(settled.filter(r => r.on_card));
    const strong = anchorSummary(settled.filter(r => r.strong));
    console.log('\nTotals (flat 1 unit per leg, singles)');
    console.log(`  ${line('pool', pool)}`);
    console.log(`  ${line('strong', strong)}`);
    console.log(`  ${line('card', card)}`);

    const bar = anchorPassBar(pool, days.length);
    console.log(`\nPass bar (pool): ${bar.pass ? 'PASS' : 'NOT YET'}`);
    for (const c of bar.checks) {
        const v = c.value == null ? '-' : (Math.abs(c.value) < 1 && c.name !== 'legs' && c.name !== 'forward days') ? pct(c.value) : c.value;
        console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(22)} ${String(v).padStart(8)}   need ${c.need}`);
    }

    if (JSON_OUT) {
        fs.writeFileSync(JSON_OUT, JSON.stringify({ window: { from: FROM, to: TO }, days: perDay.map(({ cardLegs, ...d }) => d), pool, strong, card, bar }, null, 2));
        console.log(`\nwrote ${JSON_OUT}`);
    }
} finally {
    await closeDb();
}
