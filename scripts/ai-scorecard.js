// AI SCORECARD — per-model-tag health + calibration over the settled ledgers.
// READ-ONLY: no writes, no AI calls, no API-Football calls. Run any time.
//
//   node scripts/ai-scorecard.js
//
// B3 (Detour B): creator bias is an EMPIRICAL property - measured against
// settled outcomes per persisted model tag (ai_model / tip_ai_model /
// fixture_ai_insights.model_tag), never assumed from vendor claims. Routing
// and weighting decisions follow this scorecard. Sections:
//
//   S1 HOT adjudicator per tag: confirm/veto counts + hit-rates + what
//      following the vetoes was worth (perf-rules 'saved' semantics: the
//      flat-stake profit NOT made on vetoed picks).
//   S2 TIP reviewer per tag: same, plus PRICE DRIFT - |current tip_price -
//      the price the verdict judged| off the review JSON's verdict-time
//      context (PR-4c honesty: reuse tolerance must stay measurable).
//   S3 BLIND reasoner per tag: Brier score + reliability bins over the
//      BLIND_MARKETS menu against settled results.
//   S4 ERROR RATE per day: 'error' verdicts (transport/parse/guard) - the
//      provider-health trend the run-guard breaker acts on.
//   S5 VERDICT COVERAGE per day: share of settled hot/tip rows that reached
//      kickoff WITHOUT a verdict - the direct measure of the background
//      worker's best-effort pre-kickoff coverage (freeze discipline means a
//      missed row stays NULL forever; that is a scheduling gap, not a bug).
//
// Honesty contract as everywhere: this ships NO ranking change; power floors
// are labelled (mine-rules MIN_TEST reference).
import { db, closeDb } from '../src/db/connection.js';
import { config } from '../src/config.js';
import { FINAL_STATUSES } from '../src/apisports.js';
import { BLIND_MARKETS } from '../src/db/ai-rules.js';
import { MIN_TEST } from '../src/db/mine-rules.js';

const pct = v => (v == null ? '  n/a' : (100 * v).toFixed(1) + '%');
const num = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2));
const _mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const _max = a => (a.length ? Math.max(...a) : null);
const _json = v => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };
const _rate = list => (list.length ? list.filter(b => b.hit).length / list.length : null);
const _profit = list => list.reduce((s, b) => s + (b.hit ? Number(b.price) - 1 : -1), 0);
const _group = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r) ?? '(none)'; (m.get(k) ?? m.set(k, []).get(k)).push(r); }
    return m;
};
const _power = n => (n < MIN_TEST ? `  [UNDERPOWERED < ${MIN_TEST}]` : '');

// settle a BLIND_MARKET from a final score (same table as edge-sentinel.js).
function settle(market, h, a) {
    const tot = h + a;
    switch (market) {
        case '1': return h > a; case 'X': return h === a; case '2': return h < a;
        case 'O 2.5': return tot > 2.5; case 'U 2.5': return tot < 2.5;
        case 'GG': return h > 0 && a > 0; case 'NG': return !(h > 0 && a > 0);
        default: return null;
    }
}

try {
    // ---------- the adjudication ledger (one scan; settled + pending) ----------
    const picks = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .select('p.fixture_id', 'p.hot', 'p.outcome', 'p.over_price',
            'p.ai_verdict', 'p.ai_model', 'p.ai_review',
            'p.tip_market', 'p.tip_price', 'p.tip_confidence', 'p.tip_outcome',
            'p.tip_ai_verdict', 'p.tip_ai_model', 'p.tip_ai_review',
            db.raw("DATE_FORMAT(f.kickoff,'%Y-%m-%d') as day"));

    // ============ S1 — hot adjudicator, per model tag ============
    console.log('############ S1 — hot-pick adjudicator (settled, per model tag) ############');
    // A vetoed row has hot=0 (the veto cleared it) but keeps its verdict, so
    // the adjudicated universe is hot=1 OR any stored verdict.
    const hotSettled = picks.filter(r => r.outcome != null && (Number(r.hot) === 1 || r.ai_verdict != null));
    for (const [tag, rows] of _group(hotSettled.filter(r => r.ai_verdict != null), r => r.ai_model)) {
        const settled = rows.map(r => ({ ...r, hit: r.outcome === 'hit', price: Number(r.over_price) }));
        const confirms = settled.filter(r => r.ai_verdict === 'confirm');
        const vetoes = settled.filter(r => r.ai_verdict === 'veto');
        const errors = settled.filter(r => r.ai_verdict === 'error');
        const saved = -_profit(vetoes.filter(r => Number.isFinite(r.price)));
        console.log(`  ${tag}${_power(settled.length)}`);
        console.log(`    confirm ${confirms.length} hit ${pct(_rate(confirms))} | veto ${vetoes.length} hit ${pct(_rate(vetoes))}`
            + ` (following vetoes saved ${num(saved)}u) | error ${errors.length}`);
    }
    const hotNoVerdict = hotSettled.filter(r => r.ai_verdict == null);
    console.log(`  settled hot rows without any verdict: ${hotNoVerdict.length} of ${hotSettled.length} (coverage detail in S5)`);

    // ============ S2 — tip reviewer, per model tag ============
    console.log('\n############ S2 — tip reviewer (settled, per model tag) ############');
    // Rates exclude DNB voids (stake returned - neither hit nor miss), the
    // perf-rules idiom; the review floor scopes which tips EXPECT a verdict.
    const tipSettled = picks.filter(r => r.tip_market != null && r.tip_outcome != null);
    for (const [tag, rows] of _group(tipSettled.filter(r => r.tip_ai_verdict != null), r => r.tip_ai_model)) {
        const decided = rows.filter(r => r.tip_outcome !== 'void')
            .map(r => ({ ...r, hit: r.tip_outcome === 'hit', price: Number(r.tip_price) }));
        const confirms = decided.filter(r => r.tip_ai_verdict === 'confirm');
        const vetoes = decided.filter(r => r.tip_ai_verdict === 'veto');
        const errors = rows.filter(r => r.tip_ai_verdict === 'error');
        const saved = -_profit(vetoes.filter(r => Number.isFinite(r.price)));
        // Price drift: verdict-time context (review.judged) vs the price the
        // row settled at - how far the reuse tolerance let reality move.
        const drifts = rows.map(r => {
            const judged = _json(r.tip_ai_review)?.judged;
            if (judged?.tip_price == null || r.tip_price == null) return null;
            const a = Number(judged.tip_price), b = Number(r.tip_price);
            return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? Math.abs(b - a) / a : null;
        }).filter(v => v != null);
        console.log(`  ${tag}${_power(decided.length)}`);
        console.log(`    confirm ${confirms.length} hit ${pct(_rate(confirms))} | veto ${vetoes.length} hit ${pct(_rate(vetoes))}`
            + ` (following vetoes saved ${num(saved)}u) | error ${errors.length}`);
        console.log(`    price drift vs judged: n=${drifts.length} mean ${pct(_mean(drifts))} max ${pct(_max(drifts))}`
            + ` (tol ${pct(Number(config.TIP_AI_REUSE_PRICE_TOL))}; legacy verdicts carry no judged context)`);
    }

    // ============ S3 — blind reasoner Brier / reliability, per model tag ============
    console.log('\n############ S3 — blind reasoner calibration (settled, per model tag) ############');
    const insights = await db('fixture_ai_insights as i')
        .join('fixtures as f', 'f.id', 'i.fixture_id')
        .where('i.kind', 'blind')
        .whereIn('f.status', FINAL_STATUSES)
        .whereNotNull('f.ft_home').whereNotNull('f.ft_away')
        .select('i.model_tag', 'i.payload', 'f.ft_home', 'f.ft_away');
    const terms = []; // { tag, p, hit }
    for (const r of insights) {
        const probs = _json(r.payload)?.probabilities;
        if (!probs) continue;
        for (const m of BLIND_MARKETS) {
            const p = probs[m];
            if (p == null || !Number.isFinite(Number(p))) continue;
            const res = settle(m, Number(r.ft_home), Number(r.ft_away));
            if (res == null) continue;
            terms.push({ tag: r.model_tag, p: Number(p), hit: res });
        }
    }
    if (!terms.length) console.log('  no settled blind insights yet (AI_ENRICH_ENABLED accumulates them).');
    for (const [tag, rows] of _group(terms, r => r.tag)) {
        const brier = _mean(rows.map(r => (r.p - (r.hit ? 1 : 0)) ** 2));
        console.log(`  ${tag}: ${rows.length} (fixture,market) terms${_power(rows.length)}`);
        console.log(`    Brier ${brier.toFixed(4)} (0.25 = coin-flip on a balanced menu; lower is better)`);
        console.log('    bin        n   mean(p)  realized   (aligned columns = well calibrated)');
        for (let lo = 0; lo < 1; lo += 0.2) {
            const hi = lo + 0.2;
            const bin = rows.filter(r => r.p >= lo && (hi === 1 ? r.p <= 1 : r.p < hi));
            if (!bin.length) continue;
            console.log(`    [${lo.toFixed(1)},${hi.toFixed(1)})  ${String(bin.length).padStart(4)}   ${pct(_mean(bin.map(r => r.p))).padStart(6)}   ${pct(_rate(bin)).padStart(6)}`);
        }
    }

    // ============ S4 — error verdicts per day (provider health) ============
    console.log('\n############ S4 — error verdicts per day (transport/parse/guard health) ############');
    const errRows = picks.filter(r => r.ai_verdict === 'error' || r.tip_ai_verdict === 'error');
    if (!errRows.length) console.log('  no error verdicts on the ledger.');
    else {
        for (const [day, rows] of [..._group(errRows, r => r.day)].sort()) {
            const hot = rows.filter(r => r.ai_verdict === 'error').length;
            const tip = rows.filter(r => r.tip_ai_verdict === 'error').length;
            console.log(`  ${day}: hot ${hot}, tip ${tip} (errors re-fire next drain; sustained runs trip the breaker)`);
        }
    }

    // ============ S5 — verdict coverage per day (worker pre-kickoff reach) ============
    console.log('\n############ S5 — verdict coverage per day (settled rows; NULL = missed the kickoff freeze) ############');
    console.log(`  tips scoped to confidence >= TIP_AI_MIN_CONFIDENCE (${config.TIP_AI_MIN_CONFIDENCE}); hot = hot pick or stored verdict.`);
    console.log('  day          hot covered      tips covered');
    const tipExpected = tipSettled.filter(r => Number(r.tip_confidence ?? 0) >= Number(config.TIP_AI_MIN_CONFIDENCE));
    const days = [...new Set([...hotSettled, ...tipExpected].map(r => r.day))].sort();
    for (const day of days) {
        const h = hotSettled.filter(r => r.day === day);
        const t = tipExpected.filter(r => r.day === day);
        const hc = h.length ? `${h.filter(r => r.ai_verdict != null).length}/${h.length} (${pct(h.filter(r => r.ai_verdict != null).length / h.length)})` : '-';
        const tc = t.length ? `${t.filter(r => r.tip_ai_verdict != null).length}/${t.length} (${pct(t.filter(r => r.tip_ai_verdict != null).length / t.length)})` : '-';
        console.log(`  ${day}   ${hc.padEnd(16)} ${tc}`);
    }
    if (!days.length) console.log('  nothing settled yet.');
    console.log('\n  READ: coverage < 100% = rows that kicked off before the worker reached them (the');
    console.log('  freeze forbids post-kickoff adjudication - leakage would resemble brilliance).');
    console.log('  Pre-worker history (before 2026-07-17) settled largely uncovered by design.');
} finally {
    await closeDb();
}
