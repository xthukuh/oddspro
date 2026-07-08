// Typed wrappers over the oddspro API (:3001, proxied via vite in dev).

// Baked in at build time from VITE_API_TOKEN (set it in .env to match the
// server's API_TOKEN before `npm run build:web`). Unset locally - no-op.
const API_TOKEN = import.meta.env.VITE_API_TOKEN || null;
const _authHeaders = () => API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {};

async function _get(path, params = {}) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') search.set(k, v);
    }
    const qs = search.toString();
    const res = await fetch(qs ? `${path}?${qs}` : path, { headers: _authHeaders() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body;
}

// Column catalog: { base: [...], markets: [{key,label,default}...], stats: [...] }
export async function fetchColumns() {
    return _get('/api/columns');
}

// Records for the whole selection (the table is unpaginated; sorting is
// client-side - the server's stable default order is the input):
//   date: 'YYYY-MM-DD' | 'all'; filters: [{key, op, value|col}]
//   completed: false hides concluded games (settings toggle)
//   providers: subset of visible bookmakers (settings multi-select)
export async function fetchRecords({ date, filters, completed, providers }) {
    return _get('/api/records', {
        date,
        per_page: 'all',
        filters: filters?.length ? JSON.stringify(filters) : null,
        completed: completed === false ? 0 : null,
        providers: providers?.length ? providers.join(',') : null,
    });
}

// Magic sort: top tip-ranking strategies by backtested 4-leg slip survival
// + the calibration object the client scores today's rows with:
//   { generated_at, sample: { settled, days, eligible_days, min_days,
//     sufficient }, strategies: [{ id, label, low_sample, stats }],
//     calibration }
export async function fetchMagicSort() {
    return _get('/api/magic-sort');
}

// Start refreshing a date's data. A 409 (refresh already running) also
// resolves to the in-flight job state - callers just track it.
export async function startRefresh(date) {
    const res = await fetch(`/api/refresh?date=${encodeURIComponent(date)}`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch', ..._authHeaders() }, // CSRF guard (see server.js)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body;
}

// Refresh job state: { running, date, step, started_at, finished_at, error, summary }
export async function fetchRefreshStatus() {
    return _get('/api/refresh');
}
