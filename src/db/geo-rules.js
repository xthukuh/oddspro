// Pure geo-resolution rules (zero imports, offline-testable): private/reserved
// IP detection, provider-response parsing and batch planning. No DB / network /
// config here so node:test covers it like the other rule modules.

// Private, loopback, link-local or otherwise non-routable addresses can't be
// geolocated - detect them so they're marked 'private' without a provider call.
export function isPrivateIp(ip) {
    if (!ip) return true;
    const s = String(ip).trim().toLowerCase();
    if (!s) return true;
    // IPv6 loopback / link-local (fe80::/10) / unique-local (fc00::/7)
    if (s === '::1' || s === '::') return true;
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true;   // fe80..febf -> link-local
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;   // fc00::/7 unique-local
    // IPv4 (also matches ::ffff: mapped forms already normalized upstream)
    const m = s.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 10 || a === 127 || a === 0) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;      // link-local
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    }
    return false;
}

export function classifyIp(ip) {
    return isPrivateIp(ip) ? 'private' : 'public';
}

// Parse one ip-api.com result object into a normalized outcome. `status:success`
// -> resolved with country + regionName; anything else -> unresolvable. Tolerant
// of missing fields (a resolved row with blank names still counts as resolved).
export function parseGeoResult(entry) {
    if (!entry || typeof entry !== 'object') return { status: 'unresolvable', country: null, region: null };
    if (entry.status === 'success') {
        const country = entry.country ? String(entry.country).slice(0, 64) : null;
        const region = (entry.regionName ?? entry.region) ? String(entry.regionName ?? entry.region).slice(0, 96) : null;
        return { status: 'resolved', country, region };
    }
    return { status: 'unresolvable', country: null, region: null };
}

// Split newly-discovered IPs into the ones to send to the provider (public) and
// the ones to cache immediately as 'private' (no lookup), capping the public
// batch at `max` (the provider's per-request limit). De-dupes and drops blanks.
export function planGeoBatch(ips, max = 100) {
    const seen = new Set();
    const publicIps = [];
    const privateIps = [];
    for (const raw of ips ?? []) {
        const ip = raw == null ? '' : String(raw).trim();
        if (!ip || seen.has(ip)) continue;
        seen.add(ip);
        if (isPrivateIp(ip)) privateIps.push(ip);
        else if (publicIps.length < max) publicIps.push(ip);
    }
    return { publicIps, privateIps };
}
