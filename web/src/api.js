// Typed wrappers over the oddspro API (:3001, proxied via vite in dev).
import { getHumanToken } from './humanToken.js';

// Baked in at build time from VITE_API_TOKEN (set it in .env to match the
// server's API_TOKEN before `npm run build:web`). Unset locally - no-op.
const API_TOKEN = import.meta.env.VITE_API_TOKEN || null;

// Auth headers: the optional build-time API_TOKEN bearer plus the check-once
// human-verification token (X-Human-Token) once the PoW gate has passed. Both
// no-op when unset - a server that isn't enforcing simply ignores them.
function _authHeaders() {
    const h = {};
    if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
    const human = getHumanToken();
    if (human) h['X-Human-Token'] = human;
    return h;
}

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

// Today's unique visitors + page views for the status-bar badge:
//   { date, unique, total }
export async function fetchDailyVisitors() {
    return _get('/api/visits/daily-unique');
}

// Magic sort: top tip-ranking strategies by backtested 4-leg slip survival
// + the calibration object the client scores today's rows with:
//   { generated_at, sample: { settled, days, eligible_days, min_days,
//     sufficient }, strategies: [{ id, label, low_sample, stats }],
//     calibration }
export async function fetchMagicSort() {
    return _get('/api/magic-sort');
}

// Start refreshing a date's data. A 409 (refresh already running - manual or
// scheduled) also resolves to the in-flight job state - callers just track
// it. May resolve to { fresh: true, last_refreshed_at, ... } when the server
// already refreshed the date within its cache window (no new run started).
export async function startRefresh(date) {
    const res = await fetch(`/api/refresh?date=${encodeURIComponent(date)}`, {
        method: 'POST',
        headers: { 'X-Requested-With': 'fetch', ..._authHeaders() }, // CSRF guard (see server.js)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body;
}

// Refresh job state + freshness signal: { running, mode, date, dates, step,
// last_step, started_at, finished_at, error, summary, data_version,
// last_success }. data_version bumps on every successful run (any mode);
// last_success = { at, mode, dates } drives the silent-reload scope gate
// (freshness.js). (The backend still supports cooperative cancel via
// POST /api/refresh/cancel, but the UI no longer exposes it - busy state
// lives entirely on the refresh button.)
export async function fetchRefreshStatus() {
    return _get('/api/refresh');
}

// Proof-of-work human gate (opt-in; only reachable when the server has
// HUMAN_POW_ENABLED). fetchChallenge -> solve in the browser -> submitHuman
// mints the check-once token. See web/src/HumanGate.jsx + src/human-pow.js.
export async function fetchChallenge() {
    return _get('/api/challenge');
}

export async function submitHuman(solution) {
    const res = await fetch('/api/human', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
        body: JSON.stringify(solution),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
    return body; // { token, ttl_days }
}
