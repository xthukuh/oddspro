// Typed wrappers over the oddspro API (:3001, proxied via vite in dev).
import { getHumanToken } from './humanToken.js';
import { getSessionToken } from './auth/sessionToken.js';

// Baked in at build time from VITE_API_TOKEN (set it in .env to match the
// server's API_TOKEN before `npm run build:web`). Unset locally - no-op.
const API_TOKEN = import.meta.env.VITE_API_TOKEN || null;

// API failure carrying the parsed error body, so auth flows can read the
// structured fields the server sends (retry_after_seconds, attempts_left,
// verify_required, pin_change_required, ...). message stays what callers
// already display, so existing catch sites are unaffected.
export class ApiError extends Error {
    constructor(status, body, statusText = '') {
        super(body?.error ?? `${status} ${statusText}`.trim());
        this.name = 'ApiError';
        this.status = status;
        this.body = body || {};
    }
}

// Auth headers: one Authorization bearer - the user's session token when
// signed in, else the optional build-time API_TOKEN - plus the check-once
// human-verification token (X-Human-Token) once the PoW gate has passed. All
// no-op when unset - a server that isn't enforcing simply ignores them.
function _authHeaders() {
    const h = {};
    const session = getSessionToken();
    if (session) h.Authorization = `Bearer ${session}`;
    else if (API_TOKEN) h.Authorization = `Bearer ${API_TOKEN}`;
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
    if (!res.ok) throw new ApiError(res.status, body, res.statusText);
    return body;
}

// JSON-body request for the mutating auth endpoints: X-Requested-With is the
// server's CSRF guard (custom headers force a CORS preflight it never approves).
async function _send(path, body = {}, method = 'POST') {
    const res = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ..._authHeaders() },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data, res.statusText);
    return data;
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

// --- User accounts (v1.1.0) -------------------------------------------------
// Session-token flows against /api/auth/* (src/server.js). signup/login return
// { token, user } (+ signup's otp: { sent, retry_after_seconds?, error? });
// the caller stores the token via auth/sessionToken.js and _authHeaders picks
// it up from there. Errors are ApiError - read e.body for the structured
// fields (retry_after_seconds, attempts_left, reason, ...).

// data: { name, phone, phone_region, phone_code, pin, pin_confirm }
export async function signup(data) {
    return _send('/api/auth/signup', data);
}

// data: { phone, pin } -> { token, user } (user.phone_verified may be false)
export async function login(data) {
    return _send('/api/auth/login', data);
}

export async function verifyOtp(code) {
    return _send('/api/auth/verify-otp', { code });
}

// -> { sent, retry_after_seconds? } (429 ApiError carries the corrected wait)
export async function resendOtp() {
    return _send('/api/auth/resend-otp');
}

// data: { phone, phone_region, phone_code } (unverified accounts only)
export async function changePhone(data) {
    return _send('/api/auth/change-phone', data);
}

// all: revoke every session for the account (sign out of all devices)
export async function logout(all = false) {
    return _send('/api/auth/logout', all ? { all: true } : {});
}

// Hydrate the signed-in user from a stored token -> { user, session }
export async function fetchMe() {
    return _get('/api/auth/me');
}

// data: { name?, pin?, current_pin? } (PIN change clears must_change_pin)
export async function updateProfile(data) {
    return _send('/api/auth/profile', data, 'PUT');
}

// --- Cross-device prefs sync (v1.1.0 Phase 7) --------------------------------

// The signed-in user's synced prefs blob -> { data, version, updated_at }
// (version 0 + data null = no server copy yet; see auth/prefsSync.js).
export async function getPrefs() {
    return _get('/api/prefs');
}

// LWW write -> { version, updated_at } (409 ApiError body carries
// { conflict: true, server } for the client-side reconcile).
export async function putPrefs(data, version) {
    return _send('/api/prefs', { data, version }, 'PUT');
}

// --- Dynamic settings + admin lab (v1.1.0 Phase 6) ---------------------------

// Public effective subset (client-safe operational knobs) - no auth needed.
export async function getSettings() {
    return _get('/api/settings');
}

// Full admin catalog: [{key, group, type, public, live, min, max, enum,
// default, override, effective}] - admin-role session (or ADMIN_TOKEN bearer).
export async function getAdminSettings() {
    const { settings } = await _get('/api/admin/settings');
    return settings;
}

// Batch override write (all-or-nothing server-side) ->
// { ok, results: [{key, effective, restart_required}], restart_required: [keys] }
export async function putAdminSettings(overrides) {
    return _send('/api/admin/settings', { overrides }, 'PUT');
}

// Reset one override to its config default -> { ok, key, effective, restart_required }
export async function deleteAdminSetting(key) {
    return _send(`/api/admin/settings/${encodeURIComponent(key)}`, {}, 'DELETE');
}

// Data-viz lab catalogs: { features, outcomes, defaults } (admin session only).
export async function getLabFeatures() {
    return _get('/api/admin/lab/features');
}

// Pre-binned lab aggregates: { x, y, color, outcome, cells, rows_used,
// rows_skipped, rows_loaded, min_count }. filters: [{key, op, value}].
export async function getLabData({ x, y, color, outcome, filters, days, sample, minCount, topCategories }) {
    return _get('/api/admin/lab/data', {
        x, y, color, outcome,
        filters: filters?.length ? JSON.stringify(filters) : null,
        days, sample, min_count: minCount, top_categories: topCategories,
    });
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
