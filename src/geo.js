import { config } from './config.js';
import { effective } from './settings.js';
import { db } from './db/connection.js';
import { parseGeoResult, planGeoBatch } from './db/geo-rules.js';

// Background visitor-geo backfill. Each sweep discovers visitor IPs not yet in
// the ip_geo cache, resolves the public ones via the geo provider (private/
// reserved IPs are cached without a call), then copies country/region onto the
// pending visit rows and stamps geo_status so a processed row/IP is never
// re-scanned. Best-effort: transient provider failures leave the IPs pending for
// the next sweep; only an explicit provider "fail" marks an IP unresolvable.

// Call the ip-api.com batch endpoint for a list of public IPs. Returns a Map
// ip -> { status, country, region }, or null on a transient failure (so the
// caller leaves those IPs uncached and retries next sweep instead of burning
// them as unresolvable).
async function resolveViaApi(publicIps) {
    if (!publicIps.length) return new Map();
    const body = publicIps.map(ip => ({ query: ip, fields: 'status,country,regionName,query' }));
    let arr;
    try {
        const res = await fetch(config.GEO_API_BATCH_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) { console.debug(`[geo] provider HTTP ${res.status}`); return null; }
        arr = await res.json();
    } catch (e) {
        console.debug('[geo] provider request failed:', e?.message ?? e);
        return null;
    }
    if (!Array.isArray(arr)) return null;
    const out = new Map();
    arr.forEach((entry, i) => {
        const ip = entry?.query || publicIps[i];
        if (ip) out.set(ip, parseGeoResult(entry));
    });
    return out;
}

// One backfill pass. Idempotent + safe to run concurrently-ish (ip_geo inserts
// ignore conflicts; the visits UPDATE only touches pending rows).
export async function backfillGeo({ limit = config.GEO_BATCH_LIMIT } = {}) {
    // Rows with no IP can never be resolved - mark them so they're skipped.
    await db('visits').whereNull('ip').whereNull('geo_status').update({ geo_status: 'unresolvable' });
    await db('visit_sessions').whereNull('ip').whereNull('geo_status').update({ geo_status: 'unresolvable' });

    // Distinct visitor IPs not yet cached (newly discovered) - from the legacy
    // middleware log AND the v2 beacon sessions (M2), through one ip_geo cache.
    const rows = await db('visits as v')
        .distinct('v.ip')
        .leftJoin('ip_geo as g', 'v.ip', 'g.ip')
        .whereNull('g.ip')
        .whereNotNull('v.ip')
        .limit(limit);
    const sessionRows = await db('visit_sessions as s')
        .distinct('s.ip')
        .leftJoin('ip_geo as g', 's.ip', 'g.ip')
        .whereNull('g.ip')
        .whereNotNull('s.ip')
        .limit(limit);
    const discovered = [...new Set([...rows.map(r => r.ip), ...sessionRows.map(r => r.ip)])];
    const { publicIps, privateIps } = planGeoBatch(discovered, limit);

    const now = new Date();
    const cache = privateIps.map(ip => ({ ip, country: null, region: null, status: 'private', resolved_at: now }));

    let resolved = 0, unresolvable = 0;
    if (publicIps.length) {
        const results = await resolveViaApi(publicIps);
        if (results) { // null = transient failure -> leave public IPs pending
            for (const ip of publicIps) {
                const r = results.get(ip) ?? { status: 'unresolvable', country: null, region: null };
                if (r.status === 'resolved') resolved++; else unresolvable++;
                cache.push({ ip, country: r.country, region: r.region, status: r.status, resolved_at: now });
            }
        }
    }
    if (cache.length) await db('ip_geo').insert(cache).onConflict('ip').ignore();

    // Copy the cache onto every pending row (newly-cached IPs AND repeat
    // visits of previously-cached IPs), stamping geo_status so they're skipped
    // next time. Private/unresolvable rows get a status but null country. Both
    // tracking tables share the one cache and the same stamping idiom.
    const [res] = await db.raw(
        'UPDATE visits v JOIN ip_geo g ON v.ip = g.ip '
        + 'SET v.country = g.country, v.region = g.region, v.geo_status = g.status '
        + 'WHERE v.geo_status IS NULL',
    );
    const [sess] = await db.raw(
        'UPDATE visit_sessions s JOIN ip_geo g ON s.ip = g.ip '
        + 'SET s.country = g.country, s.region = g.region, s.geo_status = g.status '
        + 'WHERE s.geo_status IS NULL',
    );
    return {
        discovered: discovered.length,
        public: publicIps.length,
        private: privateIps.length,
        resolved,
        unresolvable,
        applied: (res?.affectedRows ?? 0) + (sess?.affectedRows ?? 0),
    };
}

// --- background scheduler (started/stopped alongside the API server) ---
let timer = null;
let firstRun = null;
let running = false;

async function tick() {
    if (running) return;
    running = true;
    try {
        const c = await backfillGeo();
        if (c.discovered) {
            console.debug(`[geo] backfill: ${c.discovered} new IP(s) - ${c.resolved} resolved, `
                + `${c.unresolvable} unresolvable, ${c.private} private; ${c.applied ?? 0} visit rows updated`);
        }
    } catch (e) {
        console.debug('[geo] backfill failed:', e?.message ?? e);
    } finally {
        running = false;
    }
}

// Start the periodic backfill: a first pass ~15s after boot, then every
// GEO_INTERVAL_MINUTES. unref'd so the timers never hold the process open. A
// localhost-only box resolves everything as 'private' (no external calls).
// The flag is read via settings.effective - the server boots loadOverrides()
// before starting schedulers, so an admin override applies on restart (the
// catalog's restart_required promise, H3).
export function startGeoScheduler() {
    if (timer || !effective('GEO_RESOLVE_ENABLED')) return false;
    firstRun = setTimeout(tick, 15_000);
    firstRun.unref?.();
    timer = setInterval(tick, config.GEO_INTERVAL_MINUTES * 60_000);
    timer.unref?.();
    console.debug(`[geo] resolver on - every ${config.GEO_INTERVAL_MINUTES}m (provider ${config.GEO_API_BATCH_URL})`);
    return true;
}

export function stopGeoScheduler() {
    if (firstRun) { clearTimeout(firstRun); firstRun = null; }
    if (timer) { clearInterval(timer); timer = null; }
}
