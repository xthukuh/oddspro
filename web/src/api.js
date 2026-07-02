// Typed wrappers over the oddspro API (:3001, proxied via vite in dev).

async function _get(path, params = {}) {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') search.set(k, v);
    }
    const qs = search.toString();
    const res = await fetch(qs ? `${path}?${qs}` : path);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body;
}

// Column catalog: { base: [...], markets: [{key,label,default}...], stats: [...] }
export async function fetchColumns() {
    return _get('/api/columns');
}

// Paginated records: { data, total, page, per_page, pages }
//   date: 'YYYY-MM-DD' | 'all'; sort: [{key, dir}]; filters: [{key, op, value}]
export async function fetchRecords({ date, page, perPage, sort, filters }) {
    return _get('/api/records', {
        date,
        page,
        per_page: perPage,
        sort: sort?.length ? JSON.stringify(sort) : null,
        filters: filters?.length ? JSON.stringify(filters) : null,
    });
}

// Start refreshing a date's data. A 409 (refresh already running) also
// resolves to the in-flight job state - callers just track it.
export async function startRefresh(date) {
    const res = await fetch(`/api/refresh?date=${encodeURIComponent(date)}`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch' }, // CSRF guard (see server.js)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body;
}

// Refresh job state: { running, date, step, started_at, finished_at, error, summary }
export async function fetchRefreshStatus() {
    return _get('/api/refresh');
}
