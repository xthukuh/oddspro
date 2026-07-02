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
