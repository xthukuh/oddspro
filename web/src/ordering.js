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
