// Phase 3 - live cross-validation (read-only). The warehouse proved which
// stats patterns are precise; this checks they hold on the LIVE settled tips
// where the market+stats+API blend and real prices exist, and empirically
// picks the ranking for the new `sure` default sort. No writes.
//
//   node scripts/analyze-sure-live.js
import { closeDb } from '../src/db/connection.js';
import { settledTipRows } from '../src/magic.js';
import { tipView, tipAgreement } from '../src/db/magic-rules.js';

const pct = (h, n) => (n ? (100 * h / n).toFixed(1) + '%' : ' n/a');
const samplesOf = t => t.breakdown?.samples ?? {};
const suffOk = t => { const s = samplesOf(t); return Math.min(s.home_n ?? 0, s.away_n ?? 0) >= 6 && (s.h2h_n ?? 0) >= 3; };
const partsN = t => [t.breakdown?.market_prob, t.breakdown?.stats_prob, t.breakdown?.api_prob].filter(v => v != null).length;

// Warehouse-proven safety prior per market (from backtest-sure-tips.js OOS wLo;
// double-chance/high-Under/team-total-Under are the safe zone). Higher = safer.
const SAFE_PRIOR = {
    'AU 2.5': 0.86, 'U 4.5': 0.84, 'O 1.5': 0.81, '1X': 0.80, 'HU 2.5': 0.78,
    '12': 0.77, 'U 3.5': 0.72, 'DNB1': 0.75, 'X2': 0.70, 'O 2.5': 0.68,
    'AU 1.5': 0.70, 'U 5.5': 0.85, 'U 6.5': 0.85,
};
const prior = m => SAFE_PRIOR[m] ?? 0.6;

try {
    const rows = await settledTipRows();
    const settled = rows.map(r => ({ day: r.day, t: tipView(r) })).filter(e => e.t && (e.t.outcome === 'hit' || e.t.outcome === 'miss'));
    const N = settled.length, H = settled.filter(e => e.t.outcome === 'hit').length;
    console.log(`Live settled tips: ${N}, overall ${pct(H, N)}\n`);

    // 1) Sufficiency-gate lift on LIVE data (the "exclude risky" test)
    const g = settled.filter(e => suffOk(e.t)), b = settled.filter(e => !suffOk(e.t));
    console.log('=== SUFFICIENCY GATE (minN>=6 AND h2h>=3) on live tips ===');
    console.log(`  sufficient : ${pct(g.filter(e => e.t.outcome === 'hit').length, g.length)}  (${g.filter(e => e.t.outcome === 'hit').length}/${g.length})`);
    console.log(`  thin/risky : ${pct(b.filter(e => e.t.outcome === 'hit').length, b.length)}  (${b.filter(e => e.t.outcome === 'hit').length}/${b.length})`);

    // 2) Live hit rate by blend-component count (agreement breadth)
    console.log('\n=== by number of blend components present ===');
    for (const k of [1, 2, 3]) {
        const s = settled.filter(e => partsN(e.t) === k);
        console.log(`  ${k} component(s): ${pct(s.filter(e => e.t.outcome === 'hit').length, s.length)}  (${s.filter(e => e.t.outcome === 'hit').length}/${s.length})`);
    }

    // 3) Live hit rate by agreement floor (weakest present component)
    console.log('\n=== by agreement floor (weakest present component) ===');
    for (const thr of [0.5, 0.6, 0.65, 0.7, 0.75, 0.8]) {
        const s = settled.filter(e => (tipAgreement(e.t) ?? 0) >= thr);
        console.log(`  agree>=${thr}: ${pct(s.filter(e => e.t.outcome === 'hit').length, s.length)}  (${s.filter(e => e.t.outcome === 'hit').length}/${s.length})`);
    }

    // 4) Ranking bake-off: for each day rank tips by a candidate score, then
    //    measure top-1 / top-3 precision and the mean/best streak-before-miss.
    //    This picks the `sure` default sort empirically.
    const byDay = new Map();
    for (const e of settled) { let l = byDay.get(e.day); if (!l) byDay.set(e.day, l = []); l.push(e.t); }
    const SCORERS = {
        'confidence (current)': t => t.confidence ?? 0,
        'agreement': t => tipAgreement(t) ?? t.confidence ?? 0,
        'market_prob': t => t.breakdown?.market_prob ?? t.confidence ?? 0,
        'safePrior x agreement': t => prior(t.market) * (tipAgreement(t) ?? t.confidence ?? 0),
        'safePrior x conf': t => prior(t.market) * (t.confidence ?? 0),
        'suff? prior x agree': t => (suffOk(t) ? 1 : 0.85) * prior(t.market) * (tipAgreement(t) ?? t.confidence ?? 0),
    };
    console.log('\n=== RANKING BAKE-OFF (per-day, non-vetoed) - top-of-table quality ===');
    console.log('  scorer                       top1     top3      streak(avg/best)');
    for (const [name, score] of Object.entries(SCORERS)) {
        let t1h = 0, t1n = 0, t3h = 0, t3n = 0, sSum = 0, sBest = 0, sDays = 0;
        for (const tips of byDay.values()) {
            const pool = tips.filter(t => !t.vetoed).sort((a, b) => score(b) - score(a)
                || (b.confidence ?? 0) - (a.confidence ?? 0) || (a.price ?? 0) - (b.price ?? 0));
            if (!pool.length) continue;
            if (pool[0].outcome === 'hit') t1h++; t1n++;
            for (const t of pool.slice(0, 3)) { t3n++; if (t.outcome === 'hit') t3h++; }
            let run = 0; for (const t of pool) { if (t.outcome !== 'hit') break; run++; }
            sSum += run; if (run > sBest) sBest = run; sDays++;
        }
        console.log(`  ${name.padEnd(28)} ${pct(t1h, t1n).padStart(6)}  ${pct(t3h, t3n).padStart(6)}   ${(sSum / sDays).toFixed(1)} / ${sBest}`);
    }
    console.log('\n(top1 = the single highest-ranked tip each day; streak = consecutive hits from the top before the first miss)');
} finally {
    await closeDb();
}
