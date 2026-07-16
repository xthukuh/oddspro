// PR-1 closure — the laddered-EV economic claim. READ-ONLY: no writes, no API.
//
//   node scripts/close-pr1-ladder-ev.js
//
// PR-1 (pre-registered in src/db/mine-rules.js) was the ONE M4.2 hypothesis
// whose descriptive claim HELD: fixtures we tipped O 2.5 cleared the lower
// line O 1.5 85.1% vs the tip itself landing 70.3% (n=101). The economic
// claim stayed OPEN because nobody attached O 1.5's REAL price at those
// fixtures — and O 1.5 is a live −5.4% loser overall, so the expectation was
// a sub-1.20 trap. At 85.1% the break-even price is 1/0.851 = 1.175: the
// whole question is whether the offered O 1.5 price at THESE fixtures sits
// above or below that.
//
// Method: every settled O 2.5 tip → the fixture's best fresh O 1.5 price
// across linked books (max across books = optimistic, so a negative verdict
// is conservative; same convention as the precursor mine's Tier B) → flat-
// stake EV of betting O 1.5 instead of the tip, day-clustered CI, vs the
// baseline EV of the O 2.5 tip itself at tip_price on the SAME fixtures.
// Regime split reported (TIP_MIN_PRICE 1.20→1.35 on 07-10 changes WHICH
// fixtures get an O 2.5 tip, so the recent regime is the decision-relevant
// population).
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { marketKey } from '../src/markets.js';
import { dayClusteredBootstrap, flatEv, hitRate } from '../src/db/mine-rules.js';

const pct = v => (v == null ? ' n/a' : (100 * v).toFixed(1) + '%');
const ev = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + (100 * v).toFixed(1) + '%');
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

try {
    // settled O 2.5 tips + final scores
    const tips = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .where('p.tip_market', 'O 2.5').whereNotNull('p.tip_outcome')
        .whereIn('f.status', FINAL_STATUSES).whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select(db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"),
            'p.fixture_id', 'p.tip_price', 'p.tip_outcome',
            db.raw('f.ft_home + f.ft_away as total'));

    // best fresh O 1.5 price per fixture across linked books
    const om = await db('matches as m')
        .join('odds_markets as om', 'om.match_id', 'm.id')
        .whereIn('m.fixture_id', tips.map(t => t.fixture_id))
        .where('om.is_stale', 0)
        .select('m.fixture_id', 'om.type_name', 'om.name', 'om.handicap', 'om.price');
    const o15 = new Map();
    for (const r of om) {
        if (marketKey(r) !== 'O 1.5') continue;
        const p = Number(r.price);
        if (p > 1 && p > (o15.get(r.fixture_id) ?? 0)) o15.set(r.fixture_id, p);
    }

    // build the ladder rows: bet O 1.5 at real price wherever it was offered
    const ladder = [], base = [];
    for (const t of tips) {
        base.push({ day: t.day, hit: t.tip_outcome === 'hit', price: Number(t.tip_price) });
        const p = o15.get(t.fixture_id);
        if (!p) continue;
        ladder.push({ day: t.day, hit: Number(t.total) > 1.5, price: p, tipHit: t.tip_outcome === 'hit' });
    }

    const report = (label, lRows, bRows) => {
        if (!lRows.length) { console.log(`\n### ${label}: no priced rows`); return; }
        const prices = lRows.map(r => r.price);
        const evCi = dayClusteredBootstrap(lRows, flatEv, { draws: 2000, seed: 5 });
        const beMedian = 1 / (med(prices) ?? Infinity);
        console.log(`\n### ${label}`);
        console.log(`  O 2.5 tips settled here: ${bRows.length} (tip hit ${pct(hitRate(bRows))}, tip flatEV ${ev(flatEv(bRows))})`);
        console.log(`  O 1.5 priced at ${lRows.length} of them: clear rate ${pct(hitRate(lRows))}  median price ${med(prices)?.toFixed(2)} (break-even ${pct(beMedian)})`);
        console.log(`  LADDER flat EV (bet O 1.5 at real price): ${ev(flatEv(lRows))}  CI[${ev(evCi.lo)},${ev(evCi.hi)}]`);
        const bett = lRows.filter(r => r.price >= 1.20);
        console.log(`  bettable slice (>=1.20): n=${bett.length}  clear ${pct(hitRate(bett))}  EV ${ev(flatEv(bett))}`);
        const sub = lRows.filter(r => r.price < 1.20);
        console.log(`  sub-1.20 slice:          n=${sub.length}  clear ${pct(hitRate(sub))}  EV ${ev(flatEv(sub))}`);
    };

    // regime split on the tip ledger (same detector as the other probes)
    const dayMin = new Map();
    const allTipDays = await db('fixture_predictions as p').join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.tip_outcome')
        .select(db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"), 'p.tip_price');
    for (const r of allTipDays) dayMin.set(r.day, Math.min(dayMin.get(r.day) ?? Infinity, Number(r.tip_price)));
    const days = [...dayMin.keys()].sort();
    let breakDay = null; const floor0 = dayMin.get(days[0]);
    for (const d of days) if (dayMin.get(d) >= floor0 + 0.10) { breakDay = d; break; }
    console.log(`PR-1 laddered EV — settled O 2.5 tips: ${tips.length}; O 1.5 priced: ${ladder.length}. Regime break: ${breakDay ?? 'none'}.`);

    report('FULL window', ladder, base);
    if (breakDay) {
        report(`RECENT regime (>= ${breakDay})`,
            ladder.filter(r => r.day >= breakDay), base.filter(r => r.day >= breakDay));
    }

    // the joint view: what does laddering DO relative to holding the tip?
    const both = ladder.filter(r => r.tipHit), saved = ladder.filter(r => !r.tipHit && r.hit);
    console.log(`\n### What the ladder buys: of ${ladder.length} priced fixtures, tip hit ${both.length}; ladder SAVED ${saved.length} tip-misses (O 1.5 cleared where O 2.5 did not).`);
} finally {
    await closeDb();
}
