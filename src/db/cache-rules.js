// Pure server-response cache rules (zero imports, offline-testable). The
// decision math behind src/http-cache.js: stable cache keys, a tiny LRU over
// Map insertion order, freshness = same data_version + young TTL, and the
// If-None-Match entity-tag comparison. The heavy read endpoints
// (/api/records, /api/columns) memoize whole JSON responses keyed on the
// auto-refresh data_version - the counter only moves when a refresh actually
// SUCCEEDED, which is exactly when cached query results go stale.

// Stable cache key for a GET endpoint: path + sorted non-empty query entries,
// so param order can't fork cache slots and absent/null/'' params collapse.
export function queryCacheKey(path, query = {}) {
    const parts = Object.entries(query)
        .filter(([, v]) => v != null && v !== '')
        .map(([k, v]) => `${k}=${String(v)}`)
        .sort();
    return `${path}?${parts.join('&')}`;
}

// Minimal LRU on a Map's insertion order: a get re-inserts to mark recency,
// a set evicts from the front (oldest) once over the cap.
export function lruGet(map, key) {
    if (!map.has(key)) return undefined;
    const v = map.get(key);
    map.delete(key);
    map.set(key, v);
    return v;
}
export function lruSet(map, key, value, max = 16) {
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
    return map;
}

// A cached entry serves while the data_version it was computed at still
// stands AND it is younger than ttlMs - the TTL is the belt for writers the
// in-process version counter can't see (a CLI sweep against the same DB).
export function entryFresh(entry, version, nowMs, ttlMs) {
    return Boolean(entry) && entry.version === version && (nowMs - entry.at) < ttlMs;
}

// If-None-Match vs one entity tag, weak comparison (W/ prefixes stripped) -
// gzip vs identity encodings of the same body are semantically equivalent.
export function etagMatches(header, etag) {
    if (!header || !etag) return false;
    const norm = s => String(s).trim().replace(/^W\//, '');
    const target = norm(etag);
    return String(header).split(',').some(t => norm(t) === target);
}
