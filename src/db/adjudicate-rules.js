// Pure AI-adjudication reuse/budget rules (zero imports so tests skip
// config/.env). These decide when a stored hot-pick/tip verdict is still
// fresh and how the per-EAT-day billed budget is spent - shared by the
// background AI-review worker (src/ai-worker.js), the sweep's read-only
// veto re-apply and the pending counts (src/hotpicks.js).
//
// Verdict-time context: once the verdict columns became worker-owned, a
// fixture_predictions row only carries the CURRENT score/tip - "what did the
// verdict actually judge?" travels inside the review JSON as `judged`
// ({ score } for hot, { tip_market, tip_price } for tips). A legacy review
// without `judged` compares not-reusable and re-bills exactly once, bounded
// by the day budget.

// Relative price-drift check. tol 0 (the config default) is exact numeric
// equality - byte-compatible with the pre-worker `Number(a) === Number(b)`
// reuse key; tol 0.05 admits ~5% drift around the price the verdict judged.
// mysql2 returns DECIMAL columns as strings, so both sides coerce.
export function priceWithinTolerance(prev, cur, tol = 0) {
    if (prev == null && cur == null) return true;
    if (prev == null || cur == null) return false;
    const a = Number(prev), b = Number(cur);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    if (a === b) return true;
    const t = Number(tol) > 0 ? Number(tol) : 0;
    if (t === 0 || a === 0) return false; // zero base cannot admit relative drift
    return Math.abs(b - a) / Math.abs(a) <= t;
}

// Tolerant review-JSON reader: the column arrives as an object (JSON column)
// or a string (older TEXT writes / _jsonCol round-trips) - both accepted,
// anything unusable is null, never a throw (external data).
function _review(value) {
    if (value == null) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try { return JSON.parse(value); } catch { return null; }
    }
    return null;
}

// Verdict-time context of a hot-pick adjudication: { score } or null.
export function hotVerdictContext(review) {
    const judged = _review(review)?.judged;
    const score = Number(judged?.score);
    return judged && Number.isFinite(score) ? { score } : null;
}

// Verdict-time context of a tip review: { tip_market, tip_price } or null.
// tip_price stays as stored (string or number) - comparisons go through
// priceWithinTolerance, which coerces.
export function tipVerdictContext(review) {
    const judged = _review(review)?.judged;
    if (!judged || typeof judged.tip_market !== 'string' || judged.tip_price == null) return null;
    return { tip_market: judged.tip_market, tip_price: judged.tip_price };
}

const _decided = v => v === 'confirm' || v === 'veto';

// A stored hot verdict is reusable when it is decided, billed under the same
// model tag, and judged the same (rounded) score the row carries now.
export function canReuseHotVerdict(prev, currentScore, modelTag) {
    if (!prev || !_decided(prev.ai_verdict) || prev.ai_model !== modelTag) return false;
    const ctx = hotVerdictContext(prev.ai_review);
    return ctx != null && Number(ctx.score) === Number(currentScore);
}

// A stored tip verdict is reusable when it is decided, billed under the same
// model tag, judged the SAME market (a re-pick always re-fires) and a price
// within the relative tolerance of the one it judged.
export function canReuseTipVerdict(prev, current, modelTag, priceTol = 0) {
    if (!prev || !_decided(prev.tip_ai_verdict) || prev.tip_ai_model !== modelTag) return false;
    const ctx = tipVerdictContext(prev.tip_ai_review);
    if (!ctx || ctx.tip_market !== current?.tip_market) return false;
    return priceWithinTolerance(ctx.tip_price, current?.tip_price, priceTol);
}

// Pending predicates - ONE definition shared by the worker's queue and the
// pending_reviews counts, so the two can never drift.
export function hotReviewPending(row, modelTag) {
    if (!row || !row.hot) return false;
    return !canReuseHotVerdict(row, row.score, modelTag);
}

export function tipReviewPending(row, modelTag, { minConfidence = 0, priceTol = 0 } = {}) {
    if (!row || row.tip_market == null) return false;
    if (Number(row.tip_confidence ?? 0) < Number(minConfidence)) return false;
    return !canReuseTipVerdict(row, { tip_market: row.tip_market, tip_price: row.tip_price }, modelTag, priceTol);
}

// Budget selector: reusable candidates are free (never consume a slot);
// non-reusable ones bill in the caller's priority order up to `cap`.
// Fixes the pre-worker bug where cached verdicts consumed cap slots.
export function selectTipReviews(candidates, cap) {
    const reused = [], billable = [], skipped = [];
    const budget = Number.isFinite(Number(cap)) ? Math.max(0, Math.trunc(Number(cap))) : 0;
    for (const c of candidates ?? []) {
        if (c.reusable) reused.push(c);
        else if (billable.length < budget) billable.push(c);
        else skipped.push(c);
    }
    return { reused, billable, skipped };
}

// Per-batch AI call latency summary for the DEBUG timing lines.
export function latencyStats(ms) {
    const xs = (Array.isArray(ms) ? ms : []).filter(v => v != null).map(Number).filter(Number.isFinite);
    if (!xs.length) return { n: 0, min: null, avg: null, max: null };
    const sum = xs.reduce((a, b) => a + b, 0);
    return { n: xs.length, min: Math.min(...xs), avg: sum / xs.length, max: Math.max(...xs) };
}

// 'O 2.5' / 'U 3.5' -> 2.5 / 3.5; anything that is not a bare fixture O/U
// key (team totals, result markets, junk) -> null.
export function marketLine(market) {
    const m = /^[OU] (\d+(?:\.\d+)?)$/.exec(String(market ?? ''));
    return m ? Number(m[1]) : null;
}
