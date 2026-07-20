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
//
// M11 T6 (2026-07 scorecard split): three layers now. src/db/scorecard-
// rules.js is the PURE compute (S1-S5 as structured data, zero knex/config).
// src/scorecard.js is the thin knex loader (the performanceSummary() idiom -
// the two queries below moved there verbatim). This file is a thin printer:
// call scorecardSummary(), format with pct/num/_power, console.log once.
// formatScorecard is exported (main-module gate below) so
// tests/scorecard-rules.test.js can assert on it offline, without spawning
// this file or touching the DB - the db-export.js isMain idiom.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { closeDb } from '../src/db/connection.js';
import { scorecardSummary } from '../src/scorecard.js';
import { MIN_TEST } from '../src/db/mine-rules.js';

const pct = v => (v == null ? '  n/a' : (100 * v).toFixed(1) + '%');
const num = v => (v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(2));
const _power = n => (n < MIN_TEST ? `  [UNDERPOWERED < ${MIN_TEST}]` : '');

// summary: the structured S1-S5 data from computeScorecard(). Returns the
// exact multi-line string the pre-split script used to print (byte-for-byte,
// one console.log per original call reproduced as one joined string here -
// each original call wrote `text + '\n'`, so `lines.join('\n')` followed by
// a single console.log call reproduces the same bytes).
export function formatScorecard(summary) {
    const lines = [];

    // ============ S1 — hot adjudicator, per model tag ============
    lines.push('############ S1 — hot-pick adjudicator (settled, per model tag) ############');
    for (const g of summary.s1.groups) {
        lines.push(`  ${g.tag}${_power(g.n)}`);
        lines.push(`    confirm ${g.confirm.n} hit ${pct(g.confirm.rate)} | veto ${g.veto.n} hit ${pct(g.veto.rate)}`
            + ` (following vetoes saved ${num(g.saved)}u) | error ${g.errors}`);
    }
    lines.push(`  settled hot rows without any verdict: ${summary.s1.noVerdict} of ${summary.s1.settledTotal} (coverage detail in S5)`);

    // ============ S2 — tip reviewer, per model tag ============
    lines.push('\n############ S2 — tip reviewer (settled, per model tag) ############');
    for (const g of summary.s2.groups) {
        lines.push(`  ${g.tag}${_power(g.n)}`);
        lines.push(`    confirm ${g.confirm.n} hit ${pct(g.confirm.rate)} | veto ${g.veto.n} hit ${pct(g.veto.rate)}`
            + ` (following vetoes saved ${num(g.saved)}u) | error ${g.errors}`);
        lines.push(`    price drift vs judged: n=${g.drift.n} mean ${pct(g.drift.mean)} max ${pct(g.drift.max)}`
            + ` (tol ${pct(summary.s2.tol)}; legacy verdicts carry no judged context)`);
    }

    // ============ S3 — blind reasoner Brier / reliability, per model tag ============
    lines.push('\n############ S3 — blind reasoner calibration (settled, per model tag) ############');
    if (!summary.s3.hasTerms) lines.push('  no settled blind insights yet (AI_ENRICH_ENABLED accumulates them).');
    for (const g of summary.s3.groups) {
        lines.push(`  ${g.tag}: ${g.n} (fixture,market) terms${_power(g.n)}`);
        lines.push(`    Brier ${g.brier.toFixed(4)} (0.25 = coin-flip on a balanced menu; lower is better)`);
        lines.push('    bin        n   mean(p)  realized   (aligned columns = well calibrated)');
        for (const b of g.bins) {
            lines.push(`    [${b.lo.toFixed(1)},${b.hi.toFixed(1)})  ${String(b.n).padStart(4)}   ${pct(b.meanP).padStart(6)}   ${pct(b.realized).padStart(6)}`);
        }
    }

    // ============ S4 — error verdicts per day (provider health) ============
    lines.push('\n############ S4 — error verdicts per day (transport/parse/guard health) ############');
    if (!summary.s4.hasErrors) lines.push('  no error verdicts on the ledger.');
    else {
        for (const d of summary.s4.days) {
            lines.push(`  ${d.day}: hot ${d.hot}, tip ${d.tip} (errors re-fire next drain; sustained runs trip the breaker)`);
        }
    }

    // ============ S5 — verdict coverage per day (worker pre-kickoff reach) ============
    lines.push('\n############ S5 — verdict coverage per day (settled rows; NULL = missed the kickoff freeze) ############');
    lines.push(`  tips scoped to confidence >= TIP_AI_MIN_CONFIDENCE (${summary.s5.tipAiMinConfidence}); hot = hot pick or stored verdict.`);
    lines.push('  day          hot covered      tips covered');
    for (const d of summary.s5.days) {
        const hc = d.hot ? `${d.hot.covered}/${d.hot.total} (${pct(d.hot.covered / d.hot.total)})` : '-';
        const tc = d.tip ? `${d.tip.covered}/${d.tip.total} (${pct(d.tip.covered / d.tip.total)})` : '-';
        lines.push(`  ${d.day}   ${hc.padEnd(16)} ${tc}`);
    }
    if (!summary.s5.days.length) lines.push('  nothing settled yet.');
    lines.push('\n  READ: coverage < 100% = rows that kicked off before the worker reached them (the');
    lines.push('  freeze forbids post-kickoff adjudication - leakage would resemble brilliance).');
    lines.push('  Pre-worker history (before 2026-07-17) settled largely uncovered by design.');

    return lines.join('\n');
}

// --- CLI entry (byte-compatible with the pre-refactor script) ----------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    try {
        const summary = await scorecardSummary();
        console.log(formatScorecard(summary));
    } finally {
        await closeDb();
    }
}
