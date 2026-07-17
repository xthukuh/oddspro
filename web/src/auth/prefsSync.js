import { getPrefs, putPrefs } from '../api.js';
import { collectConfig, applyConfig } from '../configSnapshot.js';
import { excludeDeviceKeys, fingerprint, reconcile } from '../../../src/db/prefs-rules.js';

// Cross-device prefs sync (v1.1.0 Phase 7). The LWW protocol is the pure
// src/db/prefs-rules.js (shared verbatim with the server); this module is the
// browser IO around it: collect local prefs via configSnapshot, track this
// device's sync cursor, and talk to GET/PUT /api/prefs.
//
// Cursor (oddspro.prefs.sync, a DEVICE key - never synced/exported): the
// { version, updated_at, fp } of the last state this device pushed or pulled,
// tagged with the user id so a different account logging in on this device
// can never inherit (or overwrite the server with) someone else's clock.
// fp = content fingerprint - a push is skipped while local prefs still match
// the cursor (clean), so the interval auto-sync is free when nothing changed.
//
// Every entry point is best-effort by design: sync must never break an auth
// flow, so callers get { action: 'error' } instead of a throw.

const CURSOR_KEY = 'oddspro.prefs.sync';

export function readCursor(userId) {
    try {
        const c = JSON.parse(localStorage.getItem(CURSOR_KEY));
        return c && c.uid === userId ? c : null;
    } catch { return null; }
}

function writeCursor(userId, { version, updated_at, fp }) {
    localStorage.setItem(CURSOR_KEY, JSON.stringify({ uid: userId, version, updated_at, fp }));
}

export function clearCursor() {
    localStorage.removeItem(CURSOR_KEY);
}

// This device's syncable prefs right now (oddspro.* minus device keys).
const syncable = () => excludeDeviceKeys(collectConfig());

// Adopt a server copy wholesale: swap localStorage (applyConfig wipes the
// cursor too - rewritten right after), stamp the cursor at the server's clock.
function adopt(userId, server) {
    const data = excludeDeviceKeys(server.data || {});
    applyConfig(data);
    writeCursor(userId, { version: server.version, updated_at: server.updated_at, fp: fingerprint(data) });
}

// Push local prefs when dirty (or force). On a 409 the pure reconcile()
// decides the race: our attempt wins the version tie only with the newer
// wall-clock write (retry one version past the server), otherwise the winner
// is adopted - both devices converge on the same state either way.
// reloadOnPull: background pushes (interval/logout) adopt silently and let
// the next natural load show the synced state; a reload mid-session would be
// jarring. Returns { action: 'push' | 'pull' | 'none' | 'error', version? }.
export async function pushPrefs(userId, { force = false, reloadOnPull = false } = {}) {
    try {
        const data = syncable();
        const fp = fingerprint(data);
        const cursor = readCursor(userId);
        if (!force && cursor && cursor.fp === fp) return { action: 'none' };
        return await _put(userId, data, fp, (cursor?.version || 0) + 1, reloadOnPull);
    } catch { return { action: 'error' }; }
}

async function _put(userId, data, fp, version, reloadOnPull, retried = false) {
    try {
        const res = await putPrefs(data, version);
        writeCursor(userId, { version: res.version, updated_at: res.updated_at, fp });
        return { action: 'push', version: res.version };
    } catch (e) {
        if (e?.status !== 409 || !e?.body?.server || retried) throw e;
        const d = reconcile({ version, updated_at: new Date().toISOString() }, e.body.server);
        if (d.action === 'push') return _put(userId, data, fp, d.version, reloadOnPull, true);
        adopt(userId, e.body.server); // lost the race - converge on the winner
        if (reloadOnPull) window.location.reload();
        return { action: 'pull' };
    }
}

// Pull the server copy when it is ahead of this device's cursor. reload
// defaults ON (the plan's GET -> applyConfig -> reload: React re-reads
// localStorage from scratch), but a no-op pull - same version, or same
// content under a moved version - never reloads. { action: 'empty' } = no
// server row yet; the caller decides to seed it (first login).
export async function pullPrefs(userId, { reload = true } = {}) {
    try {
        const row = await getPrefs();
        if (!Number(row?.version)) return { action: 'empty' };
        const d = reconcile(readCursor(userId), row);
        if (d.action === 'push') return pushPrefs(userId, { force: true }); // server behind (restored backup)
        if (d.action !== 'pull') return { action: 'none' };
        const incoming = excludeDeviceKeys(row.data || {});
        if (fingerprint(incoming) === fingerprint(syncable())) {
            // Content already matches - just catch the cursor up, no reload churn.
            writeCursor(userId, { version: row.version, updated_at: row.updated_at, fp: fingerprint(incoming) });
            return { action: 'none' };
        }
        adopt(userId, row);
        if (reload) window.location.reload();
        return { action: 'pull' };
    } catch { return { action: 'error' }; }
}

// Login/verify/hydrate entry: adopt the server copy, or seed it from local
// state when the account has none yet (first login pushes local).
export async function syncOnLogin(userId) {
    const r = await pullPrefs(userId);
    if (r.action === 'empty') return pushPrefs(userId, { force: true });
    return r;
}

// Manual "Sync now": push if dirty (409 adopts + reloads), else pull if the
// server moved. Exactly one of the two runs a network write.
export async function syncNow(userId) {
    const pushed = await pushPrefs(userId, { reloadOnPull: true });
    if (pushed.action !== 'none') return pushed;
    return pullPrefs(userId);
}

// Debounced-by-cheapness auto-sync: an interval push that no-ops (no network)
// while the fingerprint is clean, PLUS a tab-focus sync (2026-07-17 spec):
// walking to this device runs syncNow - push-if-dirty FIRST, so our own focus
// event can never clobber fresh local edits, else pull (adopt + reload only
// when another device actually changed content). Throttled; 'focus' catches
// app switches where visibility never changed. Returns the stop function.
export function startAutoSync(userId, intervalMs = 120_000, focusThrottleMs = 30_000) {
    const t = setInterval(() => { pushPrefs(userId); }, intervalMs);
    let last = 0;
    const onFocus = () => {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - last < focusThrottleMs) return;
        last = now;
        syncNow(userId);
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
        clearInterval(t);
        document.removeEventListener('visibilitychange', onFocus);
        window.removeEventListener('focus', onFocus);
    };
}
