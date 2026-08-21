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
    };
}
