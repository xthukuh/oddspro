// In-memory records cache behind instant date navigation.
//
// Pure and DOM-free so it can be unit tested offline, and so the fetch effect
// in App.jsx stays readable. Holds parsed response bodies, which run to a few
// MB each on a busy day, hence the small default cap.
//
// NOTE ON THE KEY: it deliberately does NOT include the refresh counter that
// App.jsx puts in its effect identity. That counter bumps on every background
// auto-refresh, so including it would mint a fresh slot every few minutes and
// the cache would never hit. Excluding it means an auto-refresh reuses the
// same slot and simply replaces its contents.

// Providers are sorted so that the same selection in a different order is the
// same request, which it is on the wire.
// Total by contract: a default parameter only fires on `undefined`, so the
// null case is coalesced explicitly rather than left to destructuring.
export function recordsCacheKey(input) {
    const { date, filtersKey, completed, providers, token } = input ?? {};
    const p = Array.isArray(providers) ? [...providers].sort().join(',') : '';
    return [
        date ?? 'all',
        filtersKey ?? '',
        completed === false ? '0' : '1',
        p,
        token ?? '',
    ].join('|');
}

// Insertion-ordered Map used as an LRU: re-inserting on read moves an entry to
// the end, so the first key the iterator yields is always the least recently
// used one.
export function makeLruCache(max = 8) {
    const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : 1;
    const m = new Map();
    return {
        has: k => m.has(k),
        get(k) {
            if (!m.has(k)) return undefined;
            const v = m.get(k);
            m.delete(k);
            m.set(k, v);
            return v;
        },
        set(k, v) {
            if (m.has(k)) m.delete(k);
            m.set(k, v);
            while (m.size > cap) m.delete(m.keys().next().value);
        },
        delete: k => m.delete(k),
        clear: () => m.clear(),
        size: () => m.size,
        // Insertion-order snapshot (oldest -> newest) for the persistence
        // layer. Read-only: does not touch recency.
        entries: () => [...m.entries()].map(([key, value]) => ({ key, value })),
    };
}

// ---- localStorage persistence (pure pack/unpack; DOM glue in
// recordsPersist.js). A brand-new visit (fresh tab, next day) starts with an
// empty in-memory LRU, so the table showed the loading spinner even though
// the same body sat in yesterday's tab. Persisting the newest few entries
// lets the next visit paint instantly from the seed; correctness is
// unchanged because App.jsx ALWAYS revalidates a cache hit against the
// server (whose warm keeper answers in milliseconds / 304), so a stale seed
// self-corrects silently within the first round trip.

export const PERSIST_KEY = 'oddspro.recordsCache';
// Bump when the /api/records payload shape changes incompatibly - a seed
// written by an older deploy is then discarded instead of rendered.
export const PERSIST_FORMAT = 1;

// Move the entry the user is actually VIEWING to the front of the pack
// order. Without this, the neighbour-day prefetch (which lands AFTER the main
// fetch) is the "newest" entry, and on a busy day one body alone nearly fills
// the char budget - so the seed persisted the neighbour and dropped the very
// day the next visit will load. Total: an absent/unknown key is a no-op.
export function prioritizeEntries(entries, primaryKey) {
    const list = Array.isArray(entries) ? entries : [];
    if (!primaryKey) return list;
    const head = list.filter(e => e && e.key === primaryKey);
    return head.length ? [...head, ...list.filter(e => !head.includes(e))] : list;
}

// Envelope from entries listed NEWEST FIRST (run prioritizeEntries first so
// the viewed day leads). Budgeted: localStorage quota is ~5M UTF-16 chars per
// origin, so at most `maxEntries` bodies within `maxChars` total - a busy
// Saturday's full-day body alone measures ~4.5M chars, hence the near-quota
// default; an entry that would blow the remaining budget is skipped rather
// than allowed to crowd out an earlier (higher-priority) one. The glue layer
// (recordsPersist.js) falls back to packing the viewed day alone, then to
// clearing the key, when setItem still hits the quota.
export function packRecordsCache(entries, { nowMs = 0, maxEntries = 3, maxChars = 4_600_000 } = {}) {
    const out = [];
    let used = 0;
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || typeof e.key !== 'string' || e.value == null) continue;
        if (out.length >= maxEntries) break;
        let size;
        try { size = JSON.stringify(e.value)?.length; } catch { continue; }
        if (!Number.isFinite(size) || used + size > maxChars) continue;
        used += size;
        out.push({ k: e.key, at: Number(e.at) || nowMs, value: e.value });
    }
    return { v: PERSIST_FORMAT, at: nowMs, entries: out };
}

// Total: any malformed/foreign-format envelope yields []. Entries older than
// maxAgeMs are dropped (odds that old should load fresh rather than flash a
// long-stale table), and the survivors come back OLDEST FIRST so LRU
// insertion leaves the newest one most-recent.
export function unpackRecordsCache(envelope, { nowMs = 0, maxAgeMs = 12 * 3_600_000 } = {}) {
    if (!envelope || envelope.v !== PERSIST_FORMAT || !Array.isArray(envelope.entries)) return [];
    return envelope.entries
        .filter(e => e && typeof e.k === 'string' && e.value != null
            && Number.isFinite(Number(e.at)) && (nowMs - Number(e.at)) <= maxAgeMs)
        .map(e => ({ key: e.k, at: Number(e.at), value: e.value }))
        .sort((a, b) => a.at - b.at);
}
