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
    hot: 'Over 2.5 pick',
    hot_score: 'Over 2.5 score',
    // Filterable data fields that are no longer their own TABLE column (id folds
    // into Start; updated/locked fold into the Status tooltip) but stay queryable.
    api_id: 'ID',
    updated_at: 'Updated',
    locked_at: 'Locked',
};

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

// Market/stat keys with at least one non-null value across the loaded rows.
//   markets: from row.markets + row.markets_stale (last-seen prices count).
//   stats:   dynamic fs:* from row.stats; static stat columns from the
//            top-level row field (season, ranks, form, h2h, rolling goals) -
//            same presence test DataTable uses to drop empty columns.
// Base fields are always available, so callers gate only markets/stats.
export function availableColumnKeys(rows, catalog) {
    const markets = new Set();
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
