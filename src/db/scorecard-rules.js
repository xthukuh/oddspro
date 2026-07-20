// Pure AI-scorecard computations behind `node scripts/ai-scorecard.js` and
// (M11) GET /api/admin/perf/scorecard. Takes the two already-loaded ledger
// row sets ({picks, insights} - see src/scorecard.js for the exact queries)
// and returns STRUCTURED DATA for sections S1-S5; all display formatting
// (pct/num/padding/UNDERPOWERED labels) stays in the printer
// (scripts/ai-scorecard.js's formatScorecard), so this module has no opinion
// on presentation. Imports only pure src/db/* siblings - tip-rules' canonical
// settler and ai-rules' BLIND_MARKETS menu (itself zod-only, the accepted
// "pure" exception) - zero knex/config/network, offline-testable like every
// other *-rules module.
//
// settle() dedup: the pre-refactor script carried its own local
// settle(market, h, a) duplicating the canonical settler. This module uses
// tipHitSafe from tip-rules.js instead - see tests/scorecard-rules.test.js's
// equivalence proof over the 7 BLIND_MARKETS ('void' is unreachable there,
// no DNB in the blind menu, so the hit/miss/null contract lines up exactly).
//
// B3 (Detour B) recap: creator bias is measured against settled outcomes per
// persisted model tag (ai_model / tip_ai_model / model_tag), never assumed
// from vendor claims.
//   S1 HOT adjudicator per tag: confirm/veto counts + hit-rates + what
//      following the vetoes was worth (perf-rules 'saved' semantics).
//   S2 TIP reviewer per tag: same, plus PRICE DRIFT vs the review JSON's
//      verdict-time judged context.
//   S3 BLIND reasoner per tag: Brier score + reliability bins over the
//      BLIND_MARKETS menu against settled results.
//   S4 ERROR RATE per day: 'error' verdicts (transport/parse/guard health).
//   S5 VERDICT COVERAGE per day: share of settled hot/tip rows that reached
//      kickoff WITHOUT a verdict (the worker's best-effort pre-kickoff reach).
import { tipHitSafe } from './tip-rules.js';
import { BLIND_MARKETS } from './ai-rules.js';

const _mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const _max = a => (a.length ? Math.max(...a) : null);
const _json = v => { if (v == null) return null; if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } } return v; };
const _rate = list => (list.length ? list.filter(b => b.hit).length / list.length : null);
const _profit = list => list.reduce((s, b) => s + (b.hit ? Number(b.price) - 1 : -1), 0);
const _groupBy = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r) ?? '(none)'; (m.get(k) ?? m.set(k, []).get(k)).push(r); }
    return m;
};

// A vetoed row has hot=0 (the veto cleared it) but keeps its verdict, so the
// adjudicated universe is hot=1 OR any stored verdict.
function _hotSettled(picks) {
    return picks.filter(r => r.outcome != null && (Number(r.hot) === 1 || r.ai_verdict != null));
}

// Any settled tip (outcome incl. 'void') - callers decide what to exclude.
function _tipSettled(picks) {
    return picks.filter(r => r.tip_market != null && r.tip_outcome != null);
}

// ---------------------------------------------------------------------------
// S1 - hot-pick adjudicator, per ai_model tag.
// ---------------------------------------------------------------------------
function computeS1(picks) {
    const hotSettled = _hotSettled(picks);
    const groups = [];
    for (const [tag, rows] of _groupBy(hotSettled.filter(r => r.ai_verdict != null), r => r.ai_model)) {
        const settled = rows.map(r => ({ hit: r.outcome === 'hit', price: Number(r.over_price), verdict: r.ai_verdict }));
        const confirms = settled.filter(r => r.verdict === 'confirm');
        const vetoes = settled.filter(r => r.verdict === 'veto');
        const errors = settled.filter(r => r.verdict === 'error');
        groups.push({
            tag,
            n: settled.length,
            confirm: { n: confirms.length, rate: _rate(confirms) },
            veto: { n: vetoes.length, rate: _rate(vetoes) },
            saved: -_profit(vetoes.filter(r => Number.isFinite(r.price))),
            errors: errors.length,
        });
    }
    const noVerdict = hotSettled.filter(r => r.ai_verdict == null).length;
    return { groups, noVerdict, settledTotal: hotSettled.length };
}

// ---------------------------------------------------------------------------
// S2 - tip reviewer, per tip_ai_model tag.
// ---------------------------------------------------------------------------
function computeS2(picks) {
    const tipSettled = _tipSettled(picks);
    const groups = [];
    for (const [tag, rows] of _groupBy(tipSettled.filter(r => r.tip_ai_verdict != null), r => r.tip_ai_model)) {
        // Rates exclude DNB voids (stake returned - neither hit nor miss);
        // errors/drift deliberately read the FULL group (rows, voids
        // included) - matches the pre-refactor script exactly.
        const decided = rows.filter(r => r.tip_outcome !== 'void')
            .map(r => ({ hit: r.tip_outcome === 'hit', price: Number(r.tip_price), verdict: r.tip_ai_verdict }));
        const confirms = decided.filter(r => r.verdict === 'confirm');
        const vetoes = decided.filter(r => r.verdict === 'veto');
        const errors = rows.filter(r => r.tip_ai_verdict === 'error').length;
        // Price drift: verdict-time context (review.judged) vs the price the
        // row settled at - how far the reuse tolerance let reality move.
        const drifts = rows.map(r => {
            const judged = _json(r.tip_ai_review)?.judged;
            if (judged?.tip_price == null || r.tip_price == null) return null;
            const a = Number(judged.tip_price), b = Number(r.tip_price);
            return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? Math.abs(b - a) / a : null;
        }).filter(v => v != null);
        groups.push({
            tag,
            n: decided.length,
            confirm: { n: confirms.length, rate: _rate(confirms) },
            veto: { n: vetoes.length, rate: _rate(vetoes) },
            saved: -_profit(vetoes.filter(r => Number.isFinite(r.price))),
            errors,
            drift: { n: drifts.length, mean: _mean(drifts), max: _max(drifts) },
        });
    }
    return { groups };
}

// ---------------------------------------------------------------------------
// S3 - blind reasoner Brier / reliability, per model_tag.
// ---------------------------------------------------------------------------
function computeS3(insights) {
    const terms = []; // { tag, p, hit }
    for (const r of insights) {
        const probs = _json(r.payload)?.probabilities;
        if (!probs) continue;
        for (const m of BLIND_MARKETS) {
            const p = probs[m];
            if (p == null || !Number.isFinite(Number(p))) continue;
            // tipHitSafe -> 'hit'|'miss'|'void'|null; 'void' cannot occur for
            // the BLIND_MARKETS menu (no DNB in it) - proved in the test file.
            const outcome = tipHitSafe(m, Number(r.ft_home), Number(r.ft_away));
            if (outcome == null) continue;
            terms.push({ tag: r.model_tag, p: Number(p), hit: outcome === 'hit' });
        }
    }
    const groups = [];
    for (const [tag, rows] of _groupBy(terms, r => r.tag)) {
        const brier = _mean(rows.map(r => (r.p - (r.hit ? 1 : 0)) ** 2));
        const bins = [];
        for (let lo = 0; lo < 1; lo += 0.2) {
            const hi = lo + 0.2;
            const bin = rows.filter(r => r.p >= lo && (hi === 1 ? r.p <= 1 : r.p < hi));
            if (!bin.length) continue;
            bins.push({ lo, hi, n: bin.length, meanP: _mean(bin.map(r => r.p)), realized: _rate(bin) });
        }
        groups.push({ tag, n: rows.length, brier, bins });
    }
    return { hasTerms: terms.length > 0, groups };
}

// ---------------------------------------------------------------------------
// S4 - error verdicts per day (provider health).
// ---------------------------------------------------------------------------
function computeS4(picks) {
    const errRows = picks.filter(r => r.ai_verdict === 'error' || r.tip_ai_verdict === 'error');
    const grouped = _groupBy(errRows, r => r.day);
    const days = [...grouped.keys()].sort().map(day => {
        const rows = grouped.get(day);
        return {
            day,
            hot: rows.filter(r => r.ai_verdict === 'error').length,
            tip: rows.filter(r => r.tip_ai_verdict === 'error').length,
        };
    });
    return { hasErrors: errRows.length > 0, days };
}

// ---------------------------------------------------------------------------
// S5 - verdict coverage per day (worker pre-kickoff reach).
// ---------------------------------------------------------------------------
function computeS5(picks, tipAiMinConfidence) {
    const hotSettled = _hotSettled(picks);
    const tipSettled = _tipSettled(picks);
    const tipExpected = tipSettled.filter(r => Number(r.tip_confidence ?? 0) >= Number(tipAiMinConfidence));
    const days = [...new Set([...hotSettled, ...tipExpected].map(r => r.day))].sort().map(day => {
        const h = hotSettled.filter(r => r.day === day);
        const t = tipExpected.filter(r => r.day === day);
        return {
            day,
            hot: h.length ? { covered: h.filter(r => r.ai_verdict != null).length, total: h.length } : null,
            tip: t.length ? { covered: t.filter(r => r.tip_ai_verdict != null).length, total: t.length } : null,
        };
    });
    return { tipAiMinConfidence: Number(tipAiMinConfidence), days };
}

// picks/insights: the two already-loaded ledger row sets (src/scorecard.js's
// verbatim queries). tipAiMinConfidence actually SHAPES S5's coverage
// denominator (which tips are "expected" to carry a verdict);
// tipAiReusePriceTol is display-only (S2's drift line). Both are threaded in
// explicitly rather than imported from config, so this module stays a pure
// function of its inputs - the loader (src/scorecard.js) owns reading config.
export function computeScorecard({ picks, insights, tipAiMinConfidence, tipAiReusePriceTol }) {
    return {
        s1: computeS1(picks),
        s2: { ...computeS2(picks), tol: Number(tipAiReusePriceTol) },
        s3: computeS3(insights),
        s4: computeS4(picks),
        s5: computeS5(picks, tipAiMinConfidence),
    };
}
