// Unified sort ordering: column sorts AND magic strategies combine into one
// prioritized chain. Priority = array index (0 = highest). Each entry is:
//   { type: 'column', key, dir: 'asc' | 'desc' }
//   { type: 'magic', id }                (calibration passed in as `cal`)
//
// One comparator drives BOTH the web table and the betslip playground, so
// their orders never drift. Reuses the same pure pieces the old single-mode
// sorts did - sortValue (client column extractors) and scoreTip (the shared
// magic scorer) - so nulls sink and ties stay stable exactly as before.
import { sortValue } from './sortValues.js';
import { scoreTip } from '../../src/db/magic-rules.js';

// Sorted copy honoring the chain. Native sort is spec-stable (ES2019+), so an
// empty chain or all-equal rows keep the server's start_time/api_id/provider
// order. A null value always sorts last regardless of direction: missing data
// never tops a ranking. Magic entries always rank score-descending (best-first).
export function orderRows(rows, chain, columns, cal) {
    if (!Array.isArray(chain) || !chain.length) return rows;
    const byKey = new Map((columns ?? []).map(c => [c.key, c]));
    // Compile each entry once: magic entries pre-score every row into a Map
    // (O(n) per entry) so the comparator stays a cheap lookup.
    const compiled = chain.map(entry => {
        if (entry.type === 'magic') {
            return { magic: true, scores: new Map(rows.map(r => [r, scoreTip(r, entry.id, cal)])) };
        }
        return {
            magic: false,
            col: byKey.get(entry.key) ?? { key: entry.key },
            dir: entry.dir === 'asc' ? 1 : -1,
        };
    });
    return [...rows].sort((a, b) => {
        for (const e of compiled) {
            const va = e.magic ? e.scores.get(a) : sortValue(a, e.col);
            const vb = e.magic ? e.scores.get(b) : sortValue(b, e.col);
            const dir = e.magic ? -1 : e.dir; // magic is always best-first (desc)
            if (va == null && vb == null) continue;
            if (va == null) return 1; // nulls last, either direction
            if (vb == null) return -1;
            const cmp = typeof va === 'number' && typeof vb === 'number'
                ? va - vb
                : String(va).localeCompare(String(vb));
            if (cmp) return cmp * dir;
        }
        return 0;
    });
}

// --- Server-ranked fast path (2026-10-18) ------------------------------------
// The lean /api/records body carries `ranked` (src/db/ranked-rules.js): the
// default strategy's order and scores plus the Safe / Top picks memberships,
// computed once on the server with this same scorer. The browser renders
// them as delivered and falls back to orderRows / safeSelection whenever its
// inputs differ from the server's.

// True when the chain is exactly the server-ranked strategy, so the
// delivered order IS what orderRows would compute.
export function rankedApplies(chain, ranked) {
    return !!ranked && Array.isArray(ranked.order) && Array.isArray(chain)
        && chain.length === 1 && chain[0]?.type === 'magic' && chain[0].id === ranked.strategy;
}

// `rows` (any subset of the ranked body's rows) in the delivered order. A
// stable sort over the server order restricted to a subset is that subset in
// the same sequence, so this equals orderRows(rows, chain) for that chain.
// Rows the order does not know (none, in practice) keep their place at the end.
export function orderByRanked(rows, ranked) {
    const pos = new Map(ranked.order.map((id, i) => [id, i]));
    const known = [], rest = [];
    for (const r of rows) (pos.has(r.match_id) ? known : rest).push(r);
    known.sort((a, b) => pos.get(a.match_id) - pos.get(b.match_id));
    return rest.length ? [...known, ...rest] : known;
}

// match_id -> delivered strategy score, for the magic column.
export function rankedScores(ranked) {
    const m = new Map();
    ranked.order.forEach((id, i) => m.set(id, ranked.scores?.[i] ?? null));
    return m;
}

// The first loaded row per canonical fixture - the row safeSelection and
// sureBetsSelection themselves keep - for each delivered api_id, in order.
export function rowsForFixtures(rows, apiIds) {
    const first = new Map();
    for (const r of rows) if (!first.has(r.api_id)) first.set(r.api_id, r);
    return apiIds.map(id => first.get(id)).filter(Boolean);
}
