// Fixed base columns of the datatable (always shown; match_url folds into the
// fixture cell). Kept in a pure, JSX-free module so both DataTable.jsx and the
// column helpers (columns.js) can import it and node:test can exercise the
// helpers offline. DataTable.jsx re-exports this for existing importers.
export const BASE_COLUMNS = [
    { key: 'api_id', label: 'API ID' },
    { key: 'start_time', label: 'Start' },
    { key: 'fixture', label: 'Fixture' },
    { key: 'provider', label: 'Provider' },
    { key: 'score', label: 'Score' },
    { key: 'goals', label: 'Goals' },
    { key: 'tip', label: 'Tip' },
    { key: 'status', label: 'Status' },
    { key: 'updated_at', label: 'Updated' },
    { key: 'locked_at', label: 'Locked' },
];
