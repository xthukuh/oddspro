// Visitor-tracking v2 client beacon (admin program M2/M3). Best-effort by
// design (prefsSync idiom): failures are swallowed, tracking must never break
// the app. The prod SPA is served statically by Apache, so this beacon - not a
// server middleware - is what counts visits there.
//
// Contract with src/track.js via /api/visit/*:
// - checkin (once per page load, ~2s after mount, auth-linked when signed in)
//   answers { sid, key }; the server resumes an open session inside its idle
//   window, so a quick reload does not fabricate a new visit.
// - track(name, value?) queues feature events; flushed every 15s or at 10
//   events. An event batch doubles as the heartbeat. { recheck:true } means
//   the session ended server-side - re-check-in and retry once.
// - checkout on pagehide (keepalive fetch - sendBeacon cannot carry the
//   X-Requested-With CSRF header) finalizes the stay duration.
import { authHeaders } from './api.js';

const LS_ANON = 'oddspro.visitor';
const SS_SESSION = 'oddspro.visit';
const FLUSH_MS = 15_000;
const FLUSH_AT = 10;

let _session = null;      // { sid, key }
let _queue = [];
let _timer = null;
let _started = false;
let _suspended = false;   // M14: no new events + no flushes during maintenance
let _checkinPromise = null;

function _anonId() {
    try {
        let id = localStorage.getItem(LS_ANON);
        if (!id) {
            id = (crypto.randomUUID && crypto.randomUUID())
                || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
                });
            localStorage.setItem(LS_ANON, id);
        }
        return id;
    } catch {
        return null;
    }
}

async function _post(path, body, { keepalive = false } = {}) {
    const res = await fetch(path, {
        method: 'POST',
        keepalive,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...authHeaders() },
        body: JSON.stringify(body),
    });
    return res.json().catch(() => ({}));
}

async function _checkin() {
    const anonId = _anonId();
    if (!anonId) return null;
    const r = await _post('/api/visit/checkin', {
        anon_id: anonId,
        path: location.pathname || '/',
        referer: document.referrer ? document.referrer.slice(0, 512) : null,
    });
    if (r && r.sid && r.key) {
        _session = { sid: r.sid, key: r.key };
        try { sessionStorage.setItem(SS_SESSION, JSON.stringify(_session)); } catch { /* private mode */ }
        return _session;
    }
    return null;
}

function _ensureCheckin() {
    if (_session) return Promise.resolve(_session);
    if (!_checkinPromise) {
        _checkinPromise = _checkin().catch(() => null).finally(() => { _checkinPromise = null; });
    }
    return _checkinPromise;
}

async function _flush({ keepalive = false } = {}) {
    if (_suspended || !_queue.length) return;
    const events = _queue.splice(0, _queue.length);
    try {
        const s = _session ?? await _ensureCheckin();
        if (!s) return;
        const r = await _post('/api/visit/events', { sid: s.sid, key: s.key, events }, { keepalive });
        if (r && r.recheck) {
            // Session ended server-side (idle window passed): start a fresh one
            // and retry this batch once - events land on the new session.
            _session = null;
            const fresh = await _ensureCheckin();
            if (fresh) await _post('/api/visit/events', { sid: fresh.sid, key: fresh.key, events }, { keepalive });
        }
    } catch { /* best-effort */ }
}

// Queue a feature event. Names follow the closed grammar in
// src/db/track-rules.js (lowercase snake/dotted); values are short scalars.
export function track(name, value = null) {
    if (!_started || _suspended) return;
    _queue.push(value == null ? { name } : { name, value });
    if (_queue.length >= FLUSH_AT) _flush();
}

// M14: pause the beacon while the maintenance overlay is up (the API would
// 503 anyway - keep the network quiet); resuming lets the interval timer
// flush whatever queued before the switch.
export function setTrackingSuspended(v) {
    _suspended = Boolean(v);
}

// Start once from App mount. Deferred ~2s so it never competes with the
// first records fetch; the stored session (same tab) is reused so an SPA
// remount does not re-check-in.
export function startTracking() {
    if (_started) return;
    _started = true;
    try {
        const stored = sessionStorage.getItem(SS_SESSION);
        if (stored) _session = JSON.parse(stored);
    } catch { /* ignore */ }
    setTimeout(() => { _ensureCheckin(); }, 2_000);
    _timer = setInterval(() => { _flush(); }, FLUSH_MS);
    addEventListener('pagehide', () => {
        _flush({ keepalive: true });
        if (_session) _post('/api/visit/checkout', { sid: _session.sid, key: _session.key }, { keepalive: true }).catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') _flush({ keepalive: true });
    });
}

export function stopTracking() {
    if (_timer) clearInterval(_timer);
    _timer = null;
    _started = false;
}
