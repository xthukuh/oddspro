// Client-side filter engine: conditions over columns the server can't
// WHERE on (the JS-derived STATS columns, score) run in the browser - the
// table already holds the whole selection (per_page=all), mirroring how
// sorting went client-side. Pure module (imports only sortValues.js) so
// node:test covers it offline like the other rule modules.

// Condition/group evaluation + the raw-value helper live in filterExpr.js (one
// source of truth for filter semantics - this module delegates so the flat-AND
// path and the advanced nested/expression path can never drift).
import { rawValue, filterRows, parseTipFilter } from './filterExpr.js';

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
// but its SQL target is l.name alone - filtering the display is both correct and
// exactly what the value-picker offers. (The whole day is loaded, so running it
// client-side costs nothing.)
export const CLIENT_ONLY_KEYS = new Set(['league']);

// Regex ops have no SQL form; expression conditions are opaque to SQL - both
// must evaluate over the loaded day.
const CLIENT_ONLY_OPS = new Set(['match', 'not-match']);

// R26b: a `tip` condition whose value carries a candidate/outcome prefix
// (`2:`, `H:`, `M2:`, …) can't be a plain `fp.tip_market LIKE` - the server
// would match the literal "H2:" text and return nothing. Such conditions must
// evaluate client-side (where parseTipFilter resolves the runner-up + settles
// hit/miss). A plain, un-prefixed tip value stays server-side, unchanged.
function tipHasPrefix(f) {
    if (!f || f.key !== 'tip' || f.col != null || typeof f.value !== 'string') return false;
    const p = parseTipFilter(f.value);
    return p.index !== 1 || p.outcome !== null;
}

// Partition applied filters into a server (SQL) subset and a client subset.
// A flat array is an implicit top-level AND, so each condition is placed
// independently: server-side only when every column it references is a server
// key AND the op has a SQL form. An ADVANCED model (a `{type:'group'}` object -
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
        if (f?.enabled === false) continue; // toggled off in the builder - skip entirely
        const local = f.type === 'expr'
            || CLIENT_ONLY_OPS.has(f.op)
            || CLIENT_ONLY_KEYS.has(f.key)
            || tipHasPrefix(f)
            || !keys.has(f.key)
            || (f.col != null && !keys.has(f.col));
        (local ? client : server).push(f);
    }
    return { server, client };
}

// Count leaf conditions in a filter model (flat array or nested group) - drives
// the "N active" filter badge and the ViewPills chip. Sub-groups recurse; each
// leaf condition (plain or expr) counts one. Disabled nodes (enabled: false)
// carry no constraint, so they don't count - the badge reflects only what is
// actually narrowing the table.
export function conditionCount(filters) {
    if (Array.isArray(filters)) return filters.filter(f => f?.enabled !== false).length;
    if (filters && filters.type === 'group') {
        return (filters.items ?? []).reduce((n, it) => {
            if (!it || it.enabled === false) return n;
            return n + (it.type === 'group' ? conditionCount(it) : 1);
        }, 0);
    }
    return 0;
}

// AND-combined client conditions over the loaded day. A flat condition array is
// an implicit top-level AND group; filterRows (filterExpr.js) evaluates each
// condition with the SAME derived semantics sorting uses (form → points,
// "gf/ga (avg)" → avg, "H / A" → sum, score → total goals), so filtering always
// agrees with the column's sort order. Hidden columns filter fine - descriptors
// come from the full catalog, independent of visibility.
export function applyClientFilters(rows, filters, columns) {
    return filterRows(rows, filters, columns);
}

// Distinct displayed values of a column across the loaded rows, for filter
// value pickers on low-cardinality fields (league, status, provider, season,
// round). Uses the RAW displayed value (rawValue) so the options match what the
// user sees AND what the filter compares. Returns [] once the distinct count
// exceeds `cap` (too many to be a useful list - the caller falls back to free
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

// "With Selected → Keep selection": the inverse of Hide selection - drop every
// UNCHECKED row so only the checked ones remain across every record view. Same
// identity-based `select` flag (survives filtering). Mutually exclusive with
// Hide selection in the UI (both on would empty the view).
export function applySelectionKeep(rows, keep) {
    return keep ? (rows ?? []).filter(r => r.select) : rows;
}

// Footer betting-ledger summary over the DISPLAYED rows: treat each shown pick
// as one flat `stake`-unit bet, deduped to one bet per canonical fixture
// (api_id) since a fixture's tip is fixture-level (each provider row repeats it).
// Only tipped fixtures with a real positive price count.
//   picks     - unique displayed fixtures carrying a bettable tip
//   totalOdds - Σ of the picks' prices ("total odds"); × stake = potential value
//   value     - stake × totalOdds (gross return if EVERY pick won - a ceiling)
//   won/lost  - settled hits / misses; settled = won + lost
//   staked    - stake × settled  (only settled bets are realised)
//   returned  - Σ over settled hits of stake × price
//   profit    - returned − staked (settled P/L; pending stakes not yet lost -
//               same convention as the betslip playground's slipTotals)
export function displayedSummary(rows, stake = 1) {
    const seen = new Set();
    let picks = 0, totalOdds = 0, won = 0, lost = 0, returned = 0;
    for (const r of rows ?? []) {
        const price = Number(r.tip_price);
        if (r.tip_market == null || !Number.isFinite(price) || price <= 0) continue;
        if (r.api_id != null) { if (seen.has(r.api_id)) continue; seen.add(r.api_id); }
        picks += 1;
        totalOdds += price;
        if (r.tip_outcome === 'hit') { won += 1; returned += stake * price; }
        else if (r.tip_outcome === 'miss') { lost += 1; }
    }
    const settled = won + lost;
    const staked = stake * settled;
    return { picks, totalOdds, value: stake * totalOdds, won, lost, settled, staked, returned, profit: returned - staked };
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

// --- Bulk selection actions (the Select-column header menu) ---
// All return a NEW Set<match_id> (never mutate the passed selection) so the
// caller can persist it through saveSelection. `selection` may be a Set or an
// array of ids. Pure + import-free relative to config, so node:test covers them.
const _asSet = sel => new Set(sel instanceof Set ? sel : sel ?? []);

// Select All: union the given rows' ids into the selection. Callers pass the
// VISIBLE rows so "select all" means what the user currently sees.
export function unionSelectionIds(rows, selection) {
    const next = _asSet(selection);
    for (const r of rows ?? []) next.add(r.match_id);
    return next;
}

// Invert: flip each given row's membership (checked <-> unchecked). Over the
// VISIBLE rows, so it inverts what the user sees.
export function invertSelectionIds(rows, selection) {
    const next = _asSet(selection);
    for (const r of rows ?? []) next.has(r.match_id) ? next.delete(r.match_id) : next.add(r.match_id);
    return next;
}

// Select Similar: add every LOADED row that shares an api_id with a currently
// selected row (the same canonical fixture's other-provider rows) - reaching
// siblings even when a filter hid them. Rows without an api_id match nothing.
export function selectSimilarIds(loadedRows, selection) {
    const sel = _asSet(selection);
    const apiIds = new Set();
    for (const r of loadedRows ?? []) if (r.api_id != null && sel.has(r.match_id)) apiIds.add(r.api_id);
    const next = new Set(sel);
    for (const r of loadedRows ?? []) if (r.api_id != null && apiIds.has(r.api_id)) next.add(r.match_id);
    return next;
}

// Keep One Provider: reduce the selection to a single row per canonical fixture,
// keeping the highest-priority provider's row (reuses applyOneOfEach's ranking).
// Selected rows without an api_id are all kept. `priority` = ordered provider
// list (index 0 = top).
export function keepOneProviderIds(loadedRows, selection, priority = []) {
    const sel = _asSet(selection);
    const selectedRows = (loadedRows ?? []).filter(r => sel.has(r.match_id));
    return new Set(applyOneOfEach(selectedRows, priority).map(r => r.match_id));
}

// Prioritize Selected: stable partition floating checked rows to the top,
// preserving each group's incoming (sorted) order. Returns the same reference
// untouched when nothing is selected (no reordering to do).
export function prioritizeSelectedRows(rows) {
    if (!Array.isArray(rows)) return rows;
    const sel = [], rest = [];
    for (const r of rows) (r.select ? sel : rest).push(r);
    return sel.length ? [...sel, ...rest] : rows;
}
