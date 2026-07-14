// Pure network-retry rules (zero imports, offline-testable). Outbound HTTP
// (api-sports fetches, SMS sends) hits TRANSIENT socket / TLS / DNS faults -
// a single ECONNRESET at apisports.js's line-96 GET was aborting the whole
// results sweep because that call had no retry (only the daily-quota floor and
// the per-minute rate-limit were handled). These faults are safe to retry:
// the GETs are idempotent and an SMS send is a one-shot the caller controls.
//
// A real HTTP error RESPONSE (4xx/5xx) is NOT a network fault and must NOT match
// here - the rate-limit path (rate-rules.js) owns those, and matching them would
// wrongly retry a permanent 4xx. This predicate is DISJOINT from
// isRetryableDbError (retry-rules.js): a socket fault is never a DB retry and a
// deadlock is never a network retry. Reuse the shared withRetry engine
// (retry-rules.js) with this predicate injected.

// Node/undici surface transient faults as err.code (string). ECONNRESET is the
// reported TLS-before-established disconnect; the rest are the usual socket/DNS
// transients seen on flaky links.
const RETRYABLE_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
    'EPIPE', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH',
]);

export function isRetryableNetworkError(err) {
    if (!err) return false;
    if (err.code && RETRYABLE_CODES.has(err.code)) return true;
    // axios flags its errors with isAxiosError; a request that produced NO
    // response never reached the server (transient). An error WITH a response
    // is an HTTP status error - permanent for our purposes, handled elsewhere.
    // (Read the flag off the error to stay zero-import per the rules convention.)
    if (err.isAxiosError === true && !err.response) return true;
    return false;
}
