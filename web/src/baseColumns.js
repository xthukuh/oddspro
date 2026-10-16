// Fixed base columns of the datatable (always shown; match_url folds into the
// fixture cell). Kept in a pure, JSX-free module so both DataTable.jsx and the
// column helpers (columns.js) can import it and node:test can exercise the
// helpers offline. DataTable.jsx re-exports this for existing importers.
// The ID column folded into Start (v1.0.1); Updated/Locked folded into the
// Status tooltip; Goals folded into Score (its total is Score's "3:2-1" prefix,
// v1.0.2). Those stay filterable data fields via columns.js EXTRA_BASE_LABELS -
// they're just no longer their own visible column.
export const BASE_COLUMNS = [
    { key: 'start_time', label: 'Start' },
    { key: 'fixture', label: 'Fixture' },
    { key: 'provider', label: 'Provider' },
    { key: 'score', label: 'Score' },
    // The Pick leads (2026-10-16): one obvious tip per game at 1.50+ odds,
    // chosen by our calibration. Its key stays 'banker' so saved filters and
    // sort chains keep working. The stats-blend tip is no longer a table column
    // (owner 2026-10-16: one obvious tip per game, no Over 0.5); it stays a
    // filterable field labelled 'Stats tip' (columns.js EXTRA_BASE_LABELS).
    { key: 'banker', label: 'Tip' },
    { key: 'status', label: 'Status' },
];
