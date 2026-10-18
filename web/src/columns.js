// Shared column helpers for the web app:
//   labelFor           - the human title for any column key, matching the
//                        table header by construction (single source).
//   availableColumnKeys- which market/stat columns actually carry data on the
//                        loaded day, so the SELECTORS (settings + filters) can
//                        offer only what the day has (date-dynamic), mirroring
//                        the empty-column drop DataTable already does.
// Pure (imports only the static BASE_COLUMNS registry) so node:test covers it.

import { BASE_COLUMNS } from './baseColumns.js';

// Filterable/selectable base keys that are NOT in BASE_COLUMNS (the table's
// visible base set). Labels read the same as everywhere else in the UI.
const EXTRA_BASE_LABELS = {
    league: 'League',
    home_team: 'Home Team',
    away_team: 'Away Team',
    // Client-only checkbox column: filterable as a boolean ($row['select']).
    select: 'Select',
    // Synthetic row-number column: filterable on its load-order position (R27d).
    no: 'No',
    hot: 'Over 2.5 pick',
    hot_score: 'Over 2.5 score',
    // Client-only derived filter field: the chosen tip's confidence as an
    // integer win % (0-100). Not a table column - filterable only.
    tip: 'Stats tip',
    tip_confidence: 'Stats tip confidence %',
    banker: 'Tip win chance',
    banker_price: 'Tip price',
    // Filterable data fields that are no longer their own TABLE column (id folds
    // into Start; updated/locked fold into the Status tooltip; goals folds into
    // Score) but stay queryable.
    api_id: 'ID',
    updated_at: 'Updated',
    locked_at: 'Locked',
    goals: 'Goals',
};

// Date fields and fields whose SORT value is numeric even when the display text
// is a string (form points, score total, h2h points, tip confidence). Shared
// with the filter builder so the header-tooltip value-type hint matches the
// control the builder offers for the same field.
export const FILTER_DATE_KEYS = new Set(['start_time', 'updated_at', 'locked_at']);
export const FILTER_NUMBER_KEYS = new Set(['no', 'goals', 'score', 'h2h_count', 'hot', 'hot_score',
    'api_id', 'tip', 'tip_confidence', 'banker', 'banker_price', 'season', 'home_rank', 'away_rank', 'home_form', 'away_form',
    'h2h', 'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth']);

// Filter value type of a column: odds markets + post-match (fs:*) stats + the
// numeric-sort keys are numbers; the date keys are dates; everything else text.
export function filterType(col) {
    const key = col?.key;
    if (FILTER_DATE_KEYS.has(key)) return 'date';
    if (col?.group === 'market' || (typeof key === 'string' && key.startsWith('fs:')) || FILTER_NUMBER_KEYS.has(key)) {
        return 'number';
    }
    return 'text';
}

// Header-tooltip filter hint: the exact key the expression/filter builder
// expects, the column's value type, and a working example expression
// ($row['key'] reads the sort value, raw('key') the display text). Helps users
// writing custom filters know a column's queryable name and shape.
export function filterHint(col) {
    const key = col?.key;
    if (!key) return null;
    const type = filterType(col);
    const example = type === 'text'
        ? `contains(raw('${key}'), '...')`
        : type === 'date'
            ? `$row['${key}'] >= <timestamp>`
            : `$row['${key}'] >= ${key === 'tip' ? '0.7' : col?.group === 'market' ? '1.8' : '2'}`;
    return { key, type, example };
}

// Human label for a column key. base column -> its table title; extra base ->
// the map above; stat -> catalog stat label; market/unknown -> the key itself
// (market keys like "O 2.5" / "1X" already read as their own label).
export function labelFor(key, catalog) {
    const base = BASE_COLUMNS.find(c => c.key === key);
    if (base) return base.label;
    if (EXTRA_BASE_LABELS[key]) return EXTRA_BASE_LABELS[key];
    const stat = catalog?.stats?.find(c => c.key === key);
    if (stat) return stat.label ?? key;
    return key;
}

// Market family grouping (PRESENTATION ONLY): humanizes the catalog's
// fine-grained `group` tag (result/double_chance/over_under/btts/dnb/
// odd_even/ht_ft/team_total/combo/other - from src/markets.js canonicalMarket)
// and gives it a fixed display order, shared by the Settings market picker
// (MultiSelect groupBy) and the FilterBuilder market optgroups - one source,
// no drift between the two pickers. This is UNRELATED to the internal column
// dispatch tag ('market'/'base'/'stat'/'select'/'summary' - see DataTable's
// `col.group`), which stays untouched.
export const MARKET_GROUP_ORDER = [
    'result', 'double_chance', 'over_under', 'btts', 'dnb', 'odd_even', 'ht_ft', 'team_total', 'combo', 'other',
];
const MARKET_GROUP_LABEL = {
    result: 'Result', double_chance: 'Double chance', over_under: 'Over/Under',
    btts: 'Both teams to score', dnb: 'Draw no bet', odd_even: 'Odd/Even',
    ht_ft: 'Half time / Full time', team_total: 'Team totals', combo: 'Combos', other: 'Other',
};
export function marketGroupLabel(group) {
    return MARKET_GROUP_LABEL[group] ?? (group || 'Other');
}

// Market/stat keys with at least one non-null value across the loaded rows.
//   markets: from row.markets + row.markets_stale (last-seen prices count).
//   stats:   dynamic fs:* from row.stats; static stat columns from the
//            top-level row field (season, ranks, form, h2h, rolling goals) -
//            same presence test DataTable uses to drop empty columns.
// Base fields are always available, so callers gate only markets/stats.
//   marketKeys (optional): the lean body's `market_keys` - every catalog
//            market the day carries, including columns the lean rows were
//            not sent (2026-10-18), so the picker still offers them.
export function availableColumnKeys(rows, catalog, marketKeys = null) {
    const markets = new Set(Array.isArray(marketKeys) ? marketKeys : []);
    const stats = new Set();
    const statKeys = catalog?.stats?.map(c => c.key) ?? [];
    for (const r of rows ?? []) {
        for (const k in r.markets ?? {}) if (r.markets[k] != null) markets.add(k);
        for (const k in r.markets_stale ?? {}) if (r.markets_stale[k] != null) markets.add(k);
        for (const k of statKeys) {
            if (stats.has(k)) continue;
            const v = k.startsWith('fs:') ? r.stats?.[k] : r[k];
            if (v != null) stats.add(k);
        }
    }
    return { markets, stats };
}

// The `markets` parameter for a lean /api/records request (2026-10-18): the
// enabled market columns plus every key the sort chain or the filter tree
// could read off a row, because a lean row carries only the markets asked
// for. 'default' stands for the catalog's default columns (the reader never
// changed the selection), so this needs no catalog and the request is
// identical before and after the catalog loads. Over-inclusion is harmless:
// the server drops any key that is not a catalog market and canonicalises
// the rest, so 'default' plus a stats key still lands on the warmed slot.
// Expression nodes reference columns as quoted strings ($row["O 2.5"]), so
// every quoted literal in an expression counts.
const _QUOTED = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g;
export function requestedMarkets(marketKeys, chain, filters) {
    const keys = new Set(Array.isArray(marketKeys) ? marketKeys : ['default']);
    for (const e of Array.isArray(chain) ? chain : []) if (e?.type === 'column' && e.key) keys.add(e.key);
    const walk = node => {
        if (!node) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (node.enabled === false) return;
        if (node.type === 'group') { walk(node.items); return; }
        if (node.type === 'expr') {
            for (const m of String(node.expr ?? '').matchAll(_QUOTED)) keys.add(m[1] ?? m[2]);
            return;
        }
        if (node.key) keys.add(node.key);
        if (node.col) keys.add(node.col);
    };
    walk(filters);
    return [...keys].filter(Boolean).sort().join(',');
}
