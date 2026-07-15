// Device-local session token. Minted by the server on signup/login; sent as
// `Authorization: Bearer` on API requests. Opaque - expiry and revocation live
// server-side (hashed `sessions` rows), so there is no client-side exp to
// track: a stale token simply 401s and gets cleared. Mirrors humanToken.js
// (same storage module shape), plus an in-memory fallback so a browser whose
// localStorage throws (old-iOS private mode) still completes signup -> verify:
// the token then lasts the tab instead of persisting.
const KEY = 'oddspro.session';

let _mem = null;

export function getSessionToken() {
    try {
        return localStorage.getItem(KEY) || _mem;
    } catch {
        return _mem;
    }
}

export function setSessionToken(token) {
    _mem = token || null;
    try {
        if (token) localStorage.setItem(KEY, token);
        else localStorage.removeItem(KEY);
    } catch { /* private mode / quota - _mem carries the tab */ }
}

export function clearSessionToken() {
    _mem = null;
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}
