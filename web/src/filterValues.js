// Client-side filter engine: conditions over columns the server can't
// WHERE on (the JS-derived STATS columns, score) run in the browser — the
// table already holds the whole selection (per_page=all), mirroring how
// sorting went client-side. Pure module (imports only sortValues.js) so
// node:test covers it offline like the other rule modules.

import { sortValue } from './sortValues.js';
// Shared VERBATIM with the server (src/db/records.js) so a CSV list splits
// identically both sides - vite's fs.allow covers the out-of-root import.
import { parseFilterList } from '../../src/db/filter-csv.js';

// Keys the API accepts in /api/records filters (catalog base + market
// columns flagged filterable). Everything else must filter client-side.
export function serverKeys(catalog) {
    return new Set([
        ...catalog.base.filter(c => c.filterable).map(c => c.key),
        ...catalog.markets.filter(c => c.filterable).map(c => c.key),
    ]);
}

// Partition applied filters: a condition is server-side only when every
// column it references (key, and the RHS column in col-mode) is a server
// key — a single client-side reference pulls the whole condition local.
export function splitFilters(filters, catalog) {
    const keys = serverKeys(catalog);
    const server = [], client = [];
    for (const f of Array.isArray(filters) ? filters : []) {
        const local = !keys.has(f.key) || (f.col != null && !keys.has(f.col));
        (local ? client : server).push(f);
    }
    return { server, client };
}

// Predicates over a three-way comparison (-1/0/1); `like` is handled
// separately against the raw displayed text.
const OPS = {
    eq: c => c === 0,
    ne: c => c !== 0,
    gt: c => c > 0,
    gte: c => c >= 0,
    lt: c => c < 0,
    lte: c => c <= 0,
};

// Compare a derived row value against the condition's RHS (a literal or
// another derived value). null when either side is missing or unparsable:
// missing data never satisfies a predicate — same spirit as nulls-last
// sorting. Numbers compare numerically, everything else case-insensitively.
function _compare(a, b) {
    if (a == null || b == null || b === '') return null;
    if (typeof a === 'number') {
        const n = typeof b === 'number' ? b : Number(b);
        return Number.isNaN(n) ? null : Math.sign(a - n);
    }
    return Math.sign(String(a).toLowerCase().localeCompare(String(b).toLowerCase()));
}

// Raw (displayed) value for `like`: the underlying field text, so e.g.
// `home_form like WWW` matches the letters, not the derived points. The
// tip column's text is its market pick (server parity: like -> tip_market).
function _raw(row, col) {
    if (col.key === 'tip') return row.tip_market ?? null;
    if (col.group === 'market') return row.markets?.[col.key] ?? null;
    if (col.key.startsWith('fs:')) return row.stats?.[col.key] ?? null;
    return row[col.key] ?? null;
}

// AND-combined client conditions. Comparison ops evaluate the SAME derived
// value sorting uses (sortValue: form → points, "gf/ga (avg)" → avg,
// "H / A" → sum, score → total goals) so filtering always agrees with the
// column's sort order. `columns` descriptors come from the full catalog —
// independent of which columns are visible, hidden columns filter fine.
export function applyClientFilters(rows, filters, columns) {
    if (!Array.isArray(filters) || !filters.length) return rows;
    const byKey = new Map(columns.map(c => [c.key, c]));
    const col = k => byKey.get(k) ?? { key: k };
    return rows.filter(row => filters.every(f => {
        const lhs = col(f.key);
        // Text/set ops (no column-to-column form) match the RAW displayed value,
        // not the derived sort value. A missing raw never satisfies (nulls-last
        // spirit), matching the server's NOT LIKE / NOT IN NULL handling.
        if ((f.op === 'like' || f.op === 'not-contains') && f.col == null) {
            const raw = _raw(row, lhs);
            if (raw == null) return false;
            const has = String(raw).toLowerCase().includes(String(f.value).toLowerCase());
            return f.op === 'like' ? has : !has;
        }
        if ((f.op === 'in' || f.op === 'not-in') && f.col == null) {
            const raw = _raw(row, lhs);
            if (raw == null) return false;
            // _compare === 0 is number-vs-number when both parse numeric (price
            // 2.5 matches "2.5"), else case-insensitive string equality.
            const inSet = parseFilterList(f.value).some(it => _compare(raw, it) === 0);
            return f.op === 'in' ? inSet : !inSet;
        }
        const test = OPS[f.op];
        if (!test) return false;
        const rhs = f.col != null ? sortValue(row, col(f.col)) : f.value;
        const cmp = _compare(sortValue(row, lhs), rhs);
        return cmp != null && test(cmp);
    }));
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
