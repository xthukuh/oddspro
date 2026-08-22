// DOM glue for the records-cache localStorage seed (pure pack/unpack lives
// in recordsCache.js, offline-tested). Strictly best-effort: every storage
// failure (quota, disabled localStorage, corrupt blob) is swallowed - the
// app degrades to exactly the pre-persistence behavior, a fetch with a brief
// spinner. The key is DEVICE-LOCAL: excluded from prefs sync
// (src/db/prefs-rules.js DEVICE_EXACT) and .oddspro config snapshots
// (configSnapshot.js isTransient) - multi-MB response bodies must never ride
// either channel.

import { packRecordsCache, unpackRecordsCache, prioritizeEntries, PERSIST_KEY } from './recordsCache.js';

const MAX_AGE_MS = 12 * 3_600_000; // seeds older than this load fresh instead
const DEBOUNCE_MS = 1_000;         // writes are ~MBs; coalesce bursts (prefetch)

// First-write timestamps per key, so a hydrated entry keeps its ORIGINAL age
// across re-persists instead of looking freshly fetched forever.
const stamps = new Map();
// The key of the day the user is VIEWING (set by the main fetch, never the
// neighbour prefetch) - packed first so the char budget can never drop it in
// favour of a prefetched neighbour.
let primaryKey = null;
let timer = null;

// Seed the in-memory LRU from the previous visit. Called once at module
// scope in App.jsx, before the first render.
export function hydrateRecordsCache(cache) {
    try {
        const raw = localStorage.getItem(PERSIST_KEY);
        if (!raw) return 0;
        const entries = unpackRecordsCache(JSON.parse(raw), { nowMs: Date.now(), maxAgeMs: MAX_AGE_MS });
        for (const e of entries) {
            cache.set(e.key, e.value);
            stamps.set(e.key, e.at);
        }
        return entries.length;
    } catch {
        return 0;
    }
}

// Schedule a debounced snapshot of the cache's newest entries. Pass the key
// that was just set so its freshness stamp is recorded - with
// `{primary: true}` from the MAIN fetch (the day on screen), never from the
// neighbour prefetch; call with no key after a delete to persist the removal.
export function persistRecordsCache(cache, key, { primary = false } = {}) {
    if (key) {
        stamps.set(key, Date.now());
        if (primary) primaryKey = key;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
        timer = null;
        const nowMs = Date.now();
        const newestFirst = cache.entries().reverse()
            .map(e => ({ key: e.key, at: stamps.get(e.key) ?? nowMs, value: e.value }));
        const ordered = prioritizeEntries(newestFirst, primaryKey);
        // The pack budget models the quota but the browser owns the truth:
        // on a QuotaExceeded, retry with just the viewed day, and if even
        // that fails clear the key so a stale seed never outlives eviction.
        try {
            localStorage.setItem(PERSIST_KEY, JSON.stringify(packRecordsCache(ordered, { nowMs })));
        } catch {
            try {
                localStorage.setItem(PERSIST_KEY,
                    JSON.stringify(packRecordsCache(ordered, { nowMs, maxEntries: 1 })));
            } catch {
                try { localStorage.removeItem(PERSIST_KEY); } catch { /* disabled storage */ }
            }
        }
    }, DEBOUNCE_MS);
}
