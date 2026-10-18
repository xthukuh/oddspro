// Lean /api/records payload (2026-10-18 phone pass). Pure and zero-import by
// convention, offline-tested in tests/lean-rules.test.js.
//
// A busy day is 1,600 rows and 7.8 MB of JSON when every row carries every
// market price and its full reasoning. The table needs neither: it renders
// only the market columns the reader enabled, and the reasoning (the full tip
// breakdown, hot-pick gate audit, AI reviews, the meeting list behind the H2H
// tooltip) is only ever read when one row's popover or tooltip opens. So the
// SPA asks for `lean=1` plus the market keys it needs, and fetches one row's
// detail from GET /api/records/detail/:matchId on demand.
//
// What a lean row keeps is exactly what the in-table code reads, so nothing
// visible changes:
//   - the shared scorer (src/db/magic-rules.js) reads tip_breakdown's three
//     blend components and `samples`; the table, the betslip and filter
//     expressions read the first two runners-up's market/price/confidence and
//     their components. compactBreakdown keeps those and drops the rest
//     (weights, book_overround, stats_gap, rung_gap, deeper runners-up).
//   - LAZY_FIELDS are read only by TipPopover and the H2H tooltip.

export const LAZY_FIELDS = ['hot_signals', 'hot_review', 'tip_ai_review', 'h2h_meetings'];

const RUNNER_KEYS = ['market', 'price', 'confidence', 'market_prob', 'stats_prob', 'api_prob'];
const RUNNERS_KEPT = 2;

function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
    return out;
}

// The scorer's view of a tip breakdown. Null and non-object input pass
// through unchanged, so a redacted (null) breakdown stays null.
export function compactBreakdown(bd) {
    if (bd == null || typeof bd !== 'object') return bd ?? null;
    const out = pick(bd, ['market', 'price', 'confidence', 'market_prob', 'stats_prob', 'api_prob', 'samples']);
    if (Array.isArray(bd.runners_up)) {
        out.runners_up = bd.runners_up.slice(0, RUNNERS_KEPT)
            .map(r => (r && typeof r === 'object' ? pick(r, RUNNER_KEYS) : r));
    }
    return out;
}

// One hydrated row, leaned: lazy fields dropped, breakdown compacted. Runs
// AFTER the tier's redaction, so it can only ever remove data.
export function leanRecord(row) {
    if (!row) return row;
    const out = { ...row, tip_breakdown: compactBreakdown(row.tip_breakdown) };
    for (const f of LAZY_FIELDS) delete out[f];
    return out;
}

// Resolve the `markets` query parameter into the pivot allow-list plus the
// canonical string the response memo is keyed on.
//   null/''   -> legacy: the whole catalog allow-list (canonical null)
//   'all'     -> every stored market (canonical 'all', allow null)
//   CSV list  -> those keys intersected with the catalog allow-list; the
//                literal token 'default' expands to the catalog's default
//                columns. Sorted and de-duplicated, and a set equal to the
//                defaults canonicalises to 'default', so two clients asking
//                for the same columns in a different order share one slot
//                (the warm keeper warms 'default').
// `allowed` and `defaults` are the catalog's key sets (null before the
// catalog has loaded, when nothing can be validated: the list is taken as is).
export function resolveMarketSelection(param, allowed = null, defaults = null) {
    if (param == null || param === '') return { allow: allowed, canonical: null, subset: false };
    const raw = String(param);
    if (raw === 'all') return { allow: null, canonical: 'all', subset: false };
    const keys = new Set();
    for (const part of raw.split(',')) {
        const k = part.trim();
        if (!k) continue;
        if (k === 'default') { for (const d of defaults ?? []) keys.add(d); continue; }
        if (!allowed || allowed.has(k)) keys.add(k);
    }
    const sorted = [...keys].sort();
    const def = defaults ? [...defaults].filter(k => !allowed || allowed.has(k)).sort() : null;
    const isDefault = def != null && def.length === sorted.length && def.every((k, i) => k === sorted[i]);
    // 'none' rather than '': the memo key drops empty values, so an empty
    // selection would otherwise collide with the legacy full-catalog slot.
    const canonical = isDefault ? 'default' : (sorted.join(',') || 'none');
    return { allow: new Set(sorted), canonical, subset: true };
}
