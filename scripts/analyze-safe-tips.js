// Safe-tips analysis: replay the Safe-only selection (magic-rules
// safeQualifies/safeSelection) against every settled tip with leave-one-day-
// out calibration, grid the gates to measure leg hit rate + slip survival vs
// volume, and re-test the runner-up hypotheses (swap / cover / direction)
// that were rejected on 2026-07-09 - verdicts may flip as data grows. Run it
// weekly BEFORE touching DEFAULT_SAFE; read-only, no writes.
//
//   node scripts/analyze-safe-tips.js
import { closeDb } from '../src/db/connection.js';
import { settledTipRows } from '../src/magic.js';
import {
    DEFAULT_SAFE, safeSelection, computeCalibration, simulateStrategies, tipView,
} from '../src/db/magic-rules.js';
import { tipHit } from '../src/db/tip-rules.js';

const STRATEGY_GRID = ['sure', 'market', 'agreement', 'bucket', 'cal_market'];
const AGREEMENT_GRID = [0.65, 0.7, 0.72, 0.75];
const PARTS_GRID = [2, 3];
const PRICE_GRID = [1.4, 1.6, Infinity];
const CAP_GRID = [2, 3, 5];
const SLIP_LEGS = [2, 3, 4];
const MIN_PICKS = 15; // volume floor - thinner pools don't rank

const _pct = v => (v == null ? '  n/a' : `${(v * 100).toFixed(1)}%`);

try {
    const rows = await settledTipRows();
    const days = [...new Set(rows.map(r => r.day))].sort();
    const settledViews = rows.map(r => tipView(r)).filter(t => t?.outcome === 'hit' || t?.outcome === 'miss');
    const hits = settledViews.filter(t => t.outcome === 'hit').length;
    console.log(`Settled tips: ${settledViews.length} over ${days.length} days, `
        + `overall hit rate ${_pct(hits / (settledViews.length || 1))}`);

    // Leave-one-day-out calibrations (same idiom as simulateStrategies):
    // grading day D must never use day D's own outcomes.
    const byDay = new Map(days.map(day => [day, rows.filter(r => r.day === day)]));
    const lodo = new Map(days.map(day => [
        day,
        computeCalibration(rows.filter(r => r.day !== day).map(r => tipView(r)).filter(Boolean)),
    ]));

    // --- gate grid ---
    const results = [];
    for (const strategy of STRATEGY_GRID) {
        for (const minAgreement of AGREEMENT_GRID) {
            for (const minParts of PARTS_GRID) {
                for (const maxPrice of PRICE_GRID) {
                    for (const maxPerDay of CAP_GRID) {
                        const opts = { strategy, minAgreement, minParts, maxPrice, maxPerDay };
                        let picks = 0, legHits = 0;
                        const slips = new Map(SLIP_LEGS.map(l => [l, { days: 0, survived: 0 }]));
                        for (const day of days) {
                            const dayPicks = safeSelection(byDay.get(day), lodo.get(day), opts);
                            picks += dayPicks.length;
                            legHits += dayPicks.filter(r => r.tip_outcome === 'hit').length;
                            for (const legs of SLIP_LEGS) {
                                if (dayPicks.length < legs) continue;
                                const s = slips.get(legs);
                                s.days++;
                                if (dayPicks.slice(0, legs).every(r => r.tip_outcome === 'hit')) s.survived++;
                            }
                        }
                        results.push({
                            ...opts, picks, legHits,
                            legRate: picks ? legHits / picks : null,
                            slips,
                        });
                    }
                }
            }
        }
    }

    const isDefault = r => r.strategy === DEFAULT_SAFE.strategy
        && r.minAgreement === DEFAULT_SAFE.minAgreement
        && r.minParts === DEFAULT_SAFE.minParts
        && r.maxPrice === DEFAULT_SAFE.maxPrice
        && r.maxPerDay === DEFAULT_SAFE.maxPerDay;
    const _slip = (r, legs) => {
        const s = r.slips.get(legs);
        return s.days ? `${s.survived}/${s.days}` : '-';
    };
    const _row = r =>
        `${isDefault(r) ? '*' : ' '} ${r.strategy.padEnd(10)} agree>=${r.minAgreement.toFixed(2)}`
        + ` parts>=${r.minParts} price<=${r.maxPrice === Infinity ? ' any' : r.maxPrice.toFixed(1)} cap=${r.maxPerDay}`
        + `  picks=${String(r.picks).padStart(4)} (${(r.picks / (days.length || 1)).toFixed(1)}/day)`
        + `  legs=${_pct(r.legRate)}`
        + `  slips 2:${_slip(r, 2)} 3:${_slip(r, 3)} 4:${_slip(r, 4)}`;

    console.log(`\nTop gate combinations by leg hit rate (min ${MIN_PICKS} picks), * = shipped DEFAULT_SAFE:`);
    const ranked = results
        .filter(r => r.picks >= MIN_PICKS)
        .sort((a, b) => (b.legRate - a.legRate) || (b.picks - a.picks));
    ranked.slice(0, 20).forEach(r => console.log(_row(r)));

    const def = results.find(isDefault);
    console.log('\nShipped DEFAULT_SAFE:');
    console.log(_row(def));
    if (ranked.length && ranked[0].legRate > (def.legRate ?? 0)) {
        console.log('Best qualifying combo above - consider it for DEFAULT_SAFE only if it also');
        console.log('holds picks/day and slip survival (leg rate alone overfits small samples).');
    }

    // --- runner-up hypothesis re-test (rejected 2026-07-09; re-tried as data grows) ---
    const OU = m => { const x = /^([OU]) (\d\.5)$/.exec(m ?? ''); return x ? { side: x[1], line: Number(x[2]) } : null; };
    const SETS = { 1: ['1'], X: ['X'], 2: ['2'], '1X': ['1', 'X'], X2: ['X', '2'], 12: ['1', '2'] };
    const covers = (a, b) => { // a hits whenever b hits
        if (a === b) return true;
        const A = OU(a), B = OU(b);
        if (A && B) return A.side === B.side && (A.side === 'O' ? A.line < B.line : A.line > B.line);
        if (A || B) return false;
        const sa = SETS[a], sb = SETS[b];
        return !!(sa && sb) && sb.every(o => sa.includes(o));
    };
    const relation = (top, ru) => {
        const to = OU(top), ro = OU(ru);
        if (to && ro) return to.side === ro.side ? 'aligned' : 'opposed';
        if (to || ro) return 'neutral';
        const st = SETS[top], sr = SETS[ru];
        if (!st || !sr) return 'neutral';
        const sub = (a, b) => a.every(o => b.includes(o));
        if (sub(st, sr) || sub(sr, st)) return 'aligned';
        return st.some(o => sr.includes(o)) ? 'partial' : 'opposed';
    };
    const _hit = (market, r) => { try { return tipHit(market, r.fh, r.fa); } catch { return null; } };

    let swapW = 0, swapL = 0, closeW = 0, closeL = 0, coverCount = 0;
    const rel = {};
    for (const r of rows) {
        const tip = tipView(r);
        if (!tip || (tip.outcome !== 'hit' && tip.outcome !== 'miss') || r.fh == null) continue;
        const ru = tip.breakdown?.runners_up?.[0];
        if (!ru?.market) continue;
        if (covers(ru.market, tip.market)) coverCount++;
        const ruHit = _hit(ru.market, r);
        if (ruHit == null) continue;
        const topHit = tip.outcome === 'hit';
        if (ruHit && !topHit) swapW++;
        if (!ruHit && topHit) swapL++;
        const gap = (tip.confidence ?? 0) - (Number(ru.confidence) || 0);
        if (gap <= 0.05) { if (ruHit && !topHit) closeW++; if (!ruHit && topHit) closeL++; }
        const k = relation(tip.market, ru.market);
        rel[k] ??= { n: 0, h: 0 };
        rel[k].n++;
        if (topHit) rel[k].h++;
    }
    console.log('\nRunner-up hypotheses (swap the tip for runner-up 1):');
    console.log(`  global swap: +${swapW} rescued misses / -${swapL} broken hits `
        + `(${swapW > swapL ? 'POSITIVE - consider a swap rule' : 'negative - keep selection-only'})`);
    console.log(`  close-gap (<=0.05) swap: +${closeW} / -${closeL}`);
    console.log(`  covering runners-up: ${coverCount} (bestTip's confidence sort makes covers the pick itself)`);
    console.log('  tip hit rate by runner-up direction relation:');
    for (const [k, v] of Object.entries(rel).sort((a, b) => b[1].n - a[1].n)) {
        console.log(`    ${k.padEnd(8)} n=${String(v.n).padStart(4)}  ${_pct(v.h / v.n)}`);
    }

    // --- strategy recap (what the ✨ menu ranks on, streak included) ---
    const sim = simulateStrategies(rows, { topN: 10 });
    console.log(`\nStrategy replay recap (${sim.sample.settled} settled, ${sim.sample.days} days):`);
    for (const s of sim.strategies) {
        console.log(`  ${s.id.padEnd(11)} slips ${s.stats.survived}/${s.stats.days}`
            + `  top-quarter ${_pct(s.stats.quartile.rate)}`
            + `  streak avg ${s.stats.streak.avg ?? '-'} best ${s.stats.streak.best}`
            + `  roi ${s.stats.roi == null ? 'n/a' : s.stats.roi.toFixed(2)}`
            + `${s.low_sample ? '  (small sample)' : ''}`);
    }
    console.log('\nProtocol reminder: change DEFAULT_SAFE (src/db/magic-rules.js) only on a');
    console.log('combo that beats the shipped row on leg rate AND volume AND slip survival.');
} finally {
    await closeDb();
}
