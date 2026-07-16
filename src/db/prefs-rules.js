// Cross-device preference sync rules (v1.1.0 Phase 7). Pure, zero imports -
// offline-testable and shared VERBATIM by the server (PUT sanitization in
// src/prefs.js/server.js) and the web client (web/src/auth/prefsSync.js, the
// same out-of-root import idiom as magic-rules) so the two can never drift.
//
// Model: one JSON blob of oddspro.* localStorage prefs per user (user_prefs,
// migration batch 11), last-write-wins. `version` is the primary clock - a
// device pushes its cursor version + 1 and the server only accepts strictly
// newer versions - and `updated_at` breaks version ties (two devices racing
// the same next version: the later wall-clock write wins, deterministically).

// Per-device state that must NEVER sync: the session token ('oddspro.human'
// is the retired proof-of-work token - kept so legacy devices still exclude it)
// (secrets - syncing one device's token would clone/clobber sessions), the
// transient per-date row selections (data, not config), and the sync cursor
// itself (each device's own clock - syncing it would be circular).
const DEVICE_EXACT = new Set(['oddspro.session', 'oddspro.human', 'oddspro.prefs.sync']);
const DEVICE_PREFIXES = ['oddspro.select.d.'];

export function isDeviceKey(key) {
    return DEVICE_EXACT.has(key) || DEVICE_PREFIXES.some(p => key.startsWith(p));
}

// The syncable subset of a { key: value } config map: oddspro.* minus device
// keys. Applied on collect (client), on PUT (server, defense in depth) and on
// apply (client - a hostile server blob must not install tokens).
export function excludeDeviceKeys(map) {
    const out = {};
    for (const [k, v] of Object.entries(map || {})) {
        if (k.startsWith('oddspro.') && !isDeviceKey(k)) out[k] = v;
    }
    return out;
}

// Order-independent content hash (FNV-1a over sorted key/value pairs) for
// dirty detection: a push is skipped when the collected prefs fingerprint
// still matches the last-synced cursor. Not cryptographic - only guards
// against pointless version bumps, never against tampering.
export function fingerprint(map) {
    const keys = Object.keys(map || {}).sort();
    let h = 0x811c9dc5;
    for (const k of keys) {
        const s = `${k}\u0000${map[k]}\u0001`; // unambiguous k/v + pair boundaries
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
    }
    return h.toString(16).padStart(8, '0');
}

// The LWW decision. `local` is this device's sync cursor ({ version,
// updated_at? } or a bare version number; null = never synced), `serverRow`
// the server's { version, updated_at } (null = no row yet). Returns
//   { action: 'push', version } - write local state up as `version`
//   { action: 'pull', server }  - adopt the server copy
//   { action: 'none' }          - in sync (content drift is the caller's
//                                 fingerprint check - a dirty device pushes)
// The 409-conflict path reuses this with local = the attempted write
// ({ version: attempted, updated_at: now }): a version tie then falls to the
// timestamp, so the later write deterministically wins the race.
export function reconcile(local, serverRow) {
    const l = typeof local === 'number' ? { version: local } : (local ?? {});
    const lv = Number(l.version) || 0;
    const sv = Number(serverRow?.version) || 0;
    if (!sv) return { action: 'push', version: lv + 1 };
    if (sv > lv) return { action: 'pull', server: serverRow };
    if (sv < lv) return { action: 'push', version: lv + 1 };
    const lt = Date.parse(l.updated_at ?? '') || 0;
    const st = Date.parse(serverRow.updated_at ?? '') || 0;
    if (lt > st) return { action: 'push', version: sv + 1 };
    return { action: 'none' };
}

// Sanity cap on stored keys - real configs are a few dozen; anything beyond
// this is garbage, not preferences (the 64kb body limit caps bytes).
export const MAX_PREF_KEYS = 500;

// Validate + sanitize a PUT /api/prefs body ({ data, version }). Hand-rolled
// (this module stays zero-import - no zod). Only syncable oddspro.* keys with
// scalar values survive, stringified to match localStorage semantics; the
// count of everything discarded comes back as `dropped` (observability, not
// an error - a stale client sending a since-excluded key must not fail).
export function validatePrefsPut(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'Body must be { data, version }.' };
    }
    const { data, version } = body;
    if (!Number.isInteger(version) || version < 1 || version > 2 ** 31 - 1) {
        return { ok: false, error: 'version must be a positive integer.' };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, error: 'data must be an object of preference keys.' };
    }
    const entries = Object.entries(data);
    if (entries.length > MAX_PREF_KEYS) {
        return { ok: false, error: `Too many keys (max ${MAX_PREF_KEYS}).` };
    }
    const clean = {};
    let dropped = 0;
    for (const [k, v] of entries) {
        const scalar = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
        if (scalar && k.startsWith('oddspro.') && !isDeviceKey(k)) clean[k] = String(v);
        else dropped++;
    }
    return { ok: true, version, data: clean, dropped };
}
