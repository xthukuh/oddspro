// Phase 0 recon (read-only): warehouse baselines + market menu + data
// completeness. Grounds the sure-win analysis with honest base rates so any
// gate's precision is judged against the marginal it must beat. No writes.
//
//   node scripts/recon-warehouse.js
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES } from '../src/apisports.js';

const pct = (h, n) => (n ? (100 * h / n).toFixed(1) + '%' : '  n/a');
// Wilson score lower bound (95%) - the honest "at least this good" precision,
// which resists thin-cell overfitting. Reused across the analysis.
export function wilsonLower(hits, n, z = 1.96) {
    if (!n) return 0;
    const p = hits / n, z2 = z * z;
    const centre = p + z2 / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
    return Math.max(0, (centre - margin) / (1 + z2 / n));
}

try {
    // --- 1. Baseline realized rates per settle-able market -------------------
    const fx = await db('fixtures')
        .whereIn('status', FINAL_STATUSES)
        .whereNotNull('ft_home').whereNotNull('ft_away')
        .select('ft_home', 'ft_away', 'league_id', 'season', 'kickoff');
    const N = fx.length;

    const tally = {};
    const bump = (k, hit) => { const b = tally[k] ?? (tally[k] = { n: 0, h: 0 }); b.n++; if (hit) b.h++; };
    for (const f of fx) {
        const h = f.ft_home, a = f.ft_away, tot = h + a;
        bump('1 (home win)', h > a); bump('X (draw)', h === a); bump('2 (away win)', h < a);
        bump('1X', h >= a); bump('X2', h <= a); bump('12', h !== a);
        bump('DNB home (push=void)', h > a); // draws excluded below
        for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
            bump(`O ${line}`, tot > line); bump(`U ${line}`, tot < line);
        }
        bump('BTTS / GG', h > 0 && a > 0); bump('NG (no both score)', !(h > 0 && a > 0));
        bump('Home O 1.5', h > 1.5); bump('Home U 1.5', h < 1.5);
        bump('Away O 1.5', a > 1.5); bump('Away U 1.5', a < 1.5);
        bump('Home U 2.5', h < 2.5); bump('Away U 2.5', a < 2.5);
        bump('Total even', tot % 2 === 0); bump('Total odd', tot % 2 === 1);
    }
    // DNB home excluding draws (the void leg): recompute cleanly.
    let dnbN = 0, dnbH = 0;
    for (const f of fx) { if (f.ft_home === f.ft_away) continue; dnbN++; if (f.ft_home > f.ft_away) dnbH++; }

    console.log(`\n=== BASELINE MARKET RATES over ${N} finished fixtures ===`);
    console.log('(marginal rate a blind bet on this outcome would realize - the bar any gate must clear)\n');
    const order = Object.keys(tally).sort((x, y) => tally[y].h / tally[y].n - tally[x].h / tally[x].n);
    for (const k of order) {
        const b = tally[k];
        console.log(`  ${k.padEnd(22)} ${pct(b.h, b.n).padStart(6)}  (${b.h}/${b.n}, wilsonLo ${pct(wilsonLower(b.h, b.n) * b.n, b.n)})`);
    }
    console.log(`  ${'DNB home (no draws)'.padEnd(22)} ${pct(dnbH, dnbN).padStart(6)}  (${dnbH}/${dnbN})`);

    // --- 2. Live settled tips + hot picks, per date -------------------------
    const tipRows = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.tip_outcome')
        .select(db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"), 'p.tip_outcome', 'p.tip_market', 'p.tip_price');
    const hpRows = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.outcome').where('p.hot', true)
        .select(db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"), 'p.outcome');

    const byDay = {};
    for (const r of tipRows) { const d = byDay[r.day] ?? (byDay[r.day] = { tipN: 0, tipH: 0, hpN: 0, hpH: 0 }); d.tipN++; if (r.tip_outcome === 'hit') d.tipH++; }
    for (const r of hpRows) { const d = byDay[r.day] ?? (byDay[r.day] = { tipN: 0, tipH: 0, hpN: 0, hpH: 0 }); d.hpN++; if (r.outcome === 'hit') d.hpH++; }

    console.log(`\n=== LIVE SETTLED RESULTS per date (${tipRows.length} tips, ${hpRows.length} hot picks) ===`);
    let tN = 0, tH = 0, hN = 0, hH = 0;
    for (const day of Object.keys(byDay).sort()) {
        const d = byDay[day];
        tN += d.tipN; tH += d.tipH; hN += d.hpN; hH += d.hpH;
        console.log(`  ${day}  tips ${String(d.tipH).padStart(3)}/${String(d.tipN).padStart(3)} ${pct(d.tipH, d.tipN).padStart(6)}   hot ${String(d.hpH).padStart(3)}/${String(d.hpN).padStart(3)} ${pct(d.hpH, d.hpN).padStart(6)}`);
    }
    console.log(`  ${'TOTAL'.padEnd(10)} tips ${tH}/${tN} ${pct(tH, tN)}   hot ${hH}/${hN} ${pct(hH, hN)}`);

    // Tip hit-rate by market group and exact market (live)
    const mk = {};
    for (const r of tipRows) { const b = mk[r.tip_market] ?? (mk[r.tip_market] = { n: 0, h: 0 }); b.n++; if (r.tip_outcome === 'hit') b.h++; }
    console.log('\n  Live tip hit-rate by market:');
    for (const m of Object.keys(mk).sort((a, b) => mk[b].n - mk[a].n)) {
        console.log(`    ${m.padEnd(8)} ${pct(mk[m].h, mk[m].n).padStart(6)}  (${mk[m].h}/${mk[m].n})`);
    }

    // --- 3. odds_markets menu per provider ----------------------------------
    const menu = await db('odds_markets as om')
        .join('matches as m', 'm.id', 'om.match_id')
        .groupBy('m.provider', 'om.type_name')
        .select('m.provider', 'om.type_name')
        .count({ c: '*' })
        .orderBy('c', 'desc');
    console.log(`\n=== odds_markets MENU (distinct type_name per provider, top 40) ===`);
    for (const r of menu.slice(0, 40)) {
        console.log(`  ${String(r.provider).padEnd(8)} ${String(r.type_name).padEnd(34)} ${r.c}`);
    }
    console.log(`  ... ${menu.length} total (provider,type_name) combos`);

    // --- 4. Data completeness / the "risky" population ----------------------
    const [snap] = await db('fixture_prematch').count({ c: '*' });
    const [skip] = await db('fixture_predictions').whereNotNull('tip_skip_reason').count({ c: '*' });
    const skipReasons = await db('fixture_predictions').whereNotNull('tip_skip_reason')
        .groupBy('tip_skip_reason').select('tip_skip_reason').count({ c: '*' }).orderBy('c', 'desc');
    const [thinH2H] = await db('fixture_prematch').where('h2h_count', 0).orWhereNull('h2h_count').count({ c: '*' });
    const [emitted] = await db('fixture_predictions').whereNotNull('tip_market').whereNull('tip_skip_reason').count({ c: '*' });
    console.log(`\n=== DATA COMPLETENESS ===`);
    console.log(`  prematch snapshots: ${snap.c}`);
    console.log(`  tips emitted (tip_market set, no skip): ${emitted.c}`);
    console.log(`  fixtures with tip_skip_reason (the 'risky/thin' population): ${skip.c}`);
    for (const r of skipReasons) console.log(`    ${String(r.tip_skip_reason).padEnd(24)} ${r.c}`);
    console.log(`  prematch rows with no H2H history (h2h_count 0/null): ${thinH2H.c}`);

    // Sample-size distribution on live tips (from tip_breakdown.samples)
    const bd = await db('fixture_predictions').whereNotNull('tip_outcome').whereNotNull('tip_breakdown').select('tip_breakdown');
    const sampHist = { '<5': 0, '5-6': 0, '7+': 0 }; const h2hHist = { '0': 0, '1-2': 0, '3+': 0 };
    for (const r of bd) {
        let b = r.tip_breakdown; if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = null; } }
        const s = b?.samples; if (!s) continue;
        const mn = Math.min(s.home_n ?? 0, s.away_n ?? 0);
        sampHist[mn < 5 ? '<5' : mn < 7 ? '5-6' : '7+']++;
        const hh = s.h2h_n ?? 0;
        h2hHist[hh === 0 ? '0' : hh < 3 ? '1-2' : '3+']++;
    }
    console.log(`  settled-tip min(home_n,away_n) sample sizes: <5=${sampHist['<5']} 5-6=${sampHist['5-6']} 7+=${sampHist['7+']}`);
    console.log(`  settled-tip h2h_n: 0=${h2hHist['0']} 1-2=${h2hHist['1-2']} 3+=${h2hHist['3+']}`);
} finally {
    await closeDb();
}
