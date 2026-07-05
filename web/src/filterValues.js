// Client-side filter engine: conditions over columns the server can't
// WHERE on (the JS-derived STATS columns, score) run in the browser — the
// table already holds the whole selection (per_page=all), mirroring how
// sorting went client-side. Pure module (imports only sortValues.js) so
// node:test covers it offline like the other rule modules.

import { sortValue } from './sortValues.js';

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
// `home_form like WWW` matches the letters, not the derived points.
function _raw(row, col) {
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
        if (f.op === 'like' && f.col == null) {
            const raw = _raw(row, lhs);
            return raw != null && String(raw).toLowerCase().includes(String(f.value).toLowerCase());
        }
        const test = OPS[f.op];
        if (!test) return false;
        const rhs = f.col != null ? sortValue(row, col(f.col)) : f.value;
        const cmp = _compare(sortValue(row, lhs), rhs);
        return cmp != null && test(cmp);
    }));
}
