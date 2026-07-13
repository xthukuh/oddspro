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
    { key: 'tip', label: 'Tip' },
    { key: 'status', label: 'Status' },
];
