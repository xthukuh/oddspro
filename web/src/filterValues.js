// Client-side filter engine: conditions over columns the server can't
// WHERE on (the JS-derived STATS columns, score) run in the browser — the
// table already holds the whole selection (per_page=all), mirroring how
// sorting went client-side. Pure module (imports only sortValues.js) so
// node:test covers it offline like the other rule modules.

// Condition/group evaluation + the raw-value helper live in filterExpr.js (one
// source of truth for filter semantics — this module delegates so the flat-AND
// path and the advanced nested/expression path can never drift).
import { rawValue, filterRows } from './filterExpr.js';

// Keys the API accepts in /api/records filters (catalog base + market
// columns flagged filterable). Everything else must filter client-side.
export function serverKeys(catalog) {
    return new Set([
        ...catalog.base.filter(c => c.filterable).map(c => c.key),
        ...catalog.markets.filter(c => c.filterable).map(c => c.key),
    ]);
}

// Base fields whose SQL column differs from the DISPLAYED value, so they must
// filter client-side over what the user sees. `league` renders "Country - Name"
// but its SQL target is l.name alone — filtering the display is both correct and
// exactly what the value-picker offers. (The whole day is loaded, so running it
// client-side costs nothing.)
export const CLIENT_ONLY_KEYS = new Set(['league']);

// Regex ops have no SQL form; expression conditions are opaque to SQL — both
// must evaluate over the loaded day.
const CLIENT_ONLY_OPS = new Set(['match', 'not-match']);

// Partition applied filters into a server (SQL) subset and a client subset.
// A flat array is an implicit top-level AND, so each condition is placed
// independently: server-side only when every column it references is a server
// key AND the op has a SQL form. An ADVANCED model (a `{type:'group'}` object —
// nested groups / OR joins) can't be expressed as flat AND SQL, so it runs
// entirely client-side (the server loads the whole date; applyClientFilters
// narrows it). CLIENT_ONLY_KEYS / _OPS and expr conditions force local.
export function splitFilters(filters, catalog) {
    if (filters && !Array.isArray(filters) && filters.type === 'group') {
        return { server: [], client: filters };
    }
    const keys = serverKeys(catalog);
    const server = [], client = [];
    for (const f of Array.isArray(filters) ? filters : []) {
        const local = f.type === 'expr'
            || CLIENT_ONLY_OPS.has(f.op)
            || CLIENT_ONLY_KEYS.has(f.key)
            || !keys.has(f.key)
            || (f.col != null && !keys.has(f.col));
        (local ? client : server).push(f);
    }
    return { server, client };
}

// Count leaf conditions in a filter model (flat array or nested group) — drives
// the "N active" filter badge and the ViewPills chip. Sub-groups recurse; each
// leaf condition (plain or expr) counts one.
export function conditionCount(filters) {
    if (Array.isArray(filters)) return filters.length;
    if (filters && filters.type === 'group') {
        return (filters.items ?? []).reduce(
            (n, it) => n + (it && it.type === 'group' ? conditionCount(it) : 1), 0);
    }
    return 0;
}

// AND-combined client conditions over the loaded day. A flat condition array is
// an implicit top-level AND group; filterRows (filterExpr.js) evaluates each
// condition with the SAME derived semantics sorting uses (form → points,
// "gf/ga (avg)" → avg, "H / A" → sum, score → total goals), so filtering always
// agrees with the column's sort order. Hidden columns filter fine — descriptors
// come from the full catalog, independent of visibility.
export function applyClientFilters(rows, filters, columns) {
    return filterRows(rows, filters, columns);
}

// Distinct displayed values of a column across the loaded rows, for filter
// value pickers on low-cardinality fields (league, status, provider, season,
// round). Uses the RAW displayed value (rawValue) so the options match what the
// user sees AND what the filter compares. Returns [] once the distinct count
// exceeds `cap` (too many to be a useful list — the caller falls back to free
// text). Numbers sort numerically, strings case-insensitively.
export function distinctValues(rows, col, cap = 50) {
    const seen = new Set();
    for (const r of rows ?? []) {
        const v = rawValue(r, col);
        if (v == null || v === '') continue;
        seen.add(typeof v === 'number' ? v : String(v));
        if (seen.size > cap) return [];
    }
    return [...seen].sort((a, b) => (
        typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b), undefined, { sensitivity: 'base' })
    ));
}

// Serialize picker selections back into the `in`/`not-in` CSV shape
// parseFilterList understands: quote any item holding a comma, whitespace or a
// quote, doubling inner quotes. Inverse of parseFilterList.
export function toFilterCsv(items) {
    return (items ?? [])
        .map(raw => {
            const s = String(raw);
            return /[",\s]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(',');
}

// Settled-outcome display toggles (client-side, over the whole loaded day):
//   hideHits - drop settled winning tips (tip_outcome === 'hit')
//   hideMiss - drop settled losing tips  (tip_outcome === 'miss')
//   noMiss   - keep only rows whose tip market never missed today (a single
//              miss blacklists that whole market for the day); tipless rows drop
// Unsettled (upcoming/ongoing) rows always pass hideHits/hideMiss; noMiss keeps
// upcoming picks of clean markets. Enabling both hideHits+hideMiss leaves only
// upcoming/ongoing games. `failed` is computed over the passed-in rows, so the
// "day" respects any active advanced filter (= the whole date when none is set).
export function applyOutcomeToggles(rows, { hideHits = false, hideMiss = false, noMiss = false } = {}) {
    if (!hideHits && !hideMiss && !noMiss) return rows;
    const failed = noMiss
        ? new Set(rows.filter(r => r.tip_outcome === 'miss' && r.tip_market != null).map(r => r.tip_market))
        : null;
    return rows.filter(r => {
        if (hideHits && r.tip_outcome === 'hit') return false;
        if (hideMiss && r.tip_outcome === 'miss') return false;
        if (noMiss && (r.tip_market == null || failed.has(r.tip_market))) return false;
        return true;
    });
}

// Row selection (the "Select" checkbox column): stamp each row's `select`
// boolean from the persisted id set (keyed by stable match_id), so the Select
// column, the Select filter field ($row['select']) and the hide-cut all read
// one field. Returns new row objects (never mutates the fetched data).
export function stampSelection(rows, selectedIds) {
    const ids = selectedIds instanceof Set ? selectedIds : new Set(selectedIds ?? []);
    return (rows ?? []).map(r => ({ ...r, select: ids.has(r.match_id) }));
}

// "With Selected → Hide selection": drop checked rows from every record view
// (table, filter options, day calcs, betslip pool) when the toggle is on. Keyed
// off the stamped `select` flag, so it's identity-based and survives filtering.
export function applySelectionHide(rows, hide) {
    return hide ? (rows ?? []).filter(r => !r.select) : rows;
}

// One-of-each view: collapse to a single row per canonical fixture (api_id),
// keeping the row from the highest-priority provider present (`priority` is the
// ordered provider list, index 0 = top). Providers absent from the list rank
// last; rows without an api_id are never merged. A game only a lower-priority
// provider carries still appears, so enabled providers complement one another
// and no game is missed. Kept rows keep their incoming (sorted) order.
export function applyOneOfEach(rows, priority = []) {
    if (!Array.isArray(rows) || rows.length < 2) return rows;
    const rank = new Map(priority.map((p, i) => [p, i]));
    const rankOf = p => (rank.has(p) ? rank.get(p) : Number.MAX_SAFE_INTEGER);
    const best = new Map(); // api_id (or the row itself when id-less) -> chosen row
    for (const r of rows) {
        if (r.api_id == null) { best.set(r, r); continue; }
        const cur = best.get(r.api_id);
        if (cur === undefined || rankOf(r.provider) < rankOf(cur.provider)) best.set(r.api_id, r);
    }
    const keep = new Set(best.values());
    return rows.filter(r => keep.has(r));
}
