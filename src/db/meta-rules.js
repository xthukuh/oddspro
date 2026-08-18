// Pure rules for the `meta` key/value table (zero imports, offline-tested).
// Values are stored JSON-encoded text; a corrupt row must never throw into
// a caller's request path.

export function parseMetaValue(raw) {
    if (raw === null || raw === undefined) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function nextVersion(current) {
    return Number.isFinite(current) ? current + 1 : 1;
}
