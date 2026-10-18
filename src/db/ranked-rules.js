// Server-ranked view block (2026-10-18 phone pass): the default Tip order and
// the day-level Safe / Top picks memberships, computed ONCE per cached
// payload with the same shared scorer the browser imports
// (src/db/magic-rules.js), so a phone renders them as delivered instead of
// re-scoring every row. Pure (its only import is the pure scorer),
// offline-tested in tests/ranked-rules.test.js.
//
// Equivalence with the browser, by construction:
//   - order: magicSortRows is a stable sort over the rows' server order; the
//     browser's orderRows is a stable sort over the same rows in the same
//     order, so a filtered subset taken in `order` sequence is exactly what
//     orderRows would return for that subset.
//   - safe / sure: the same selection functions over the same whole-day rows
//     with the same policy; each returns the FIRST row per canonical fixture,
//     so the browser maps an api_id back to its first loaded row.
// The browser falls back to computing these itself whenever its inputs
// differ from the server's (a custom sort chain, local Safe overrides, a
// hidden or kept selection).
import { magicSortRows, scoreTip, safeSelection, sureBetsSelection } from './magic-rules.js';

export const RANKED_STRATEGY = 'banker';   // the SPA's default sort chain entry

// `magic`: a /api/magic-sort payload ({ calibration, safe }). `allow`: which
// gated memberships the caller may see (the feature registry's safe_picks /
// sure_bets); a locked one is null, never an empty list that reads as "none".
export function rankedView(rows, magic, { strategy = RANKED_STRATEGY, allowSafe = true, allowSure = true } = {}) {
    const cal = magic?.calibration ?? null;
    const sorted = magicSortRows(rows ?? [], strategy, cal);
    return {
        strategy,
        order: sorted.map(r => r.match_id),
        scores: sorted.map(r => scoreTip(r, strategy, cal)),
        safe: allowSafe ? safeSelection(rows ?? [], cal, magic?.safe ?? undefined).map(r => r.api_id) : null,
        sure: allowSure
            ? sureBetsSelection(rows ?? [], cal).map(({ row, prob, market, price, kind }) => ({ api_id: row.api_id, prob, market, price, kind }))
            : null,
    };
}

// The memo-key fragment for a ranked body: everything rankedView reads that
// is NOT in the rows. The calibration stamp moves once a day (or on a
// magic-sort ?refresh=1) and the safe policy is late-read admin config (M6),
// so either moving mints a new slot instead of serving a stale ranking.
export function rankedSignature(magic, { allowSafe = true, allowSure = true } = {}) {
    if (!magic) return 'pending';
    const safe = allowSafe ? JSON.stringify(magic.safe ?? null) : 'locked';
    return `${magic.generated_at ?? '?'}|${safe}|${allowSure ? 'sure' : 'locked'}`;
}
