import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { lruGet, lruSet, entryFresh, etagMatches } from './db/cache-rules.js';

// HTTP response caching for the heavy read endpoints (decision math is pure,
// src/db/cache-rules.js). Two tools, picked by freshness contract:
//
//   makeJsonCache() - a keyed LRU memo of fully-serialized (and gzipped)
//     responses for endpoints whose payload only changes when the warehouse
//     does (/api/records ~850 KB on a busy date, /api/columns). Keyed on the
//     auto-refresh data_version, so a successful refresh invalidates
//     naturally; a TTL belt covers out-of-process writers. Concurrent misses
//     of the same key share ONE in-flight compute.
//
//   sendJson() - stateless ETag + gzip for endpoints that must recompute per
//     request (e.g. /api/magic-sort: its safe policy is late-read per response
//     by design (M6) - memoizing the body would re-introduce the staleness
//     that fix removed). Still saves the transfer: a 304 answers a matching
//     If-None-Match, and bodies gzip ~8-10x.
//
// Convention notes: browsers get `Cache-Control: no-cache` (= revalidate every
// time, serve 304 when unchanged), never `max-age` - a stale odds table is
// worse than a cheap conditional round-trip.

const gzipAsync = promisify(zlib.gzip);
const GZIP_MIN_BYTES = 1024; // tiny bodies aren't worth the header overhead

const weakEtag = body => `W/"${crypto.createHash('sha1').update(body).digest('base64url')}"`;

// Serialize once; gzip lazily (first gzip-accepting client) and only once -
// the promise is memoized on the entry so concurrent hits never double-work.
function buildEntry(version, loader) {
    return {
        version,
        at: Date.now(),
        data: (async () => {
            const body = JSON.stringify(await loader());
            return { body, etag: weakEtag(body), gzip: null };
        })(),
    };
}

async function writeResponse(req, res, data) {
    res.set('ETag', data.etag);
    res.set('Cache-Control', 'no-cache');
    res.set('Vary', 'Accept-Encoding');
    if (etagMatches(req.get('if-none-match'), data.etag)) return res.status(304).end();
    res.type('application/json');
    if (data.body.length >= GZIP_MIN_BYTES && req.acceptsEncodings('gzip')) {
        data.gzip ??= gzipAsync(Buffer.from(data.body));
        res.set('Content-Encoding', 'gzip');
        return res.send(await data.gzip);
    }
    return res.send(data.body);
}

// Keyed response memo. `version` is read per request (late) so a data_version
// bump invalidates every entry at once without an explicit clear.
export function makeJsonCache({ max = 12, ttlMs = 10 * 60_000, version = () => 0 } = {}) {
    const store = new Map();
    const fresh = (key, loader) => {
        const ver = version();
        let entry = lruGet(store, key);
        if (!entryFresh(entry, ver, Date.now(), ttlMs)) {
            entry = buildEntry(ver, loader);
            // A failed compute must not poison the slot - drop it so the
            // next request retries (same idiom as magicSortCached).
            entry.data.catch(() => { if (lruGet(store, key) === entry) store.delete(key); });
            lruSet(store, key, entry, max);
        }
        return entry;
    };
    return {
        async send(req, res, key, loader) {
            return writeResponse(req, res, await fresh(key, loader).data);
        },
        // A5 pre-warm: compute a slot ahead of demand (after a data_version
        // bump / at boot) so the first USER request is a memo hit, not the
        // cold compute. Same freshness contract as send; a same-version warm
        // is a no-op. App-update cache busting is inherent: the memo lives
        // in-process (a deploy restart clears it) and ETags hash the body.
        async warm(key, loader) {
            await fresh(key, loader).data;
        },
        clear: () => store.clear(),
    };
}

// Stateless variant: fresh compute every request, but still 304 + gzip.
export async function sendJson(req, res, payload) {
    const body = JSON.stringify(payload);
    return writeResponse(req, res, { body, etag: weakEtag(body), gzip: null });
}
