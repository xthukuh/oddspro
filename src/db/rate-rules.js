// Pure api-sports rate-limit decision rules (zero imports so tests run
// without .env/DB; src/apisports.js is the only runtime consumer).
//
// api-sports sends two rate-limit header pairs: the daily quota
// (x-ratelimit-requests-limit / -remaining - handled by the quota floor in
// apisports.js, which halts the run) and the per-minute burst budget
// (x-ratelimit-limit / x-ratelimit-remaining). Exhausting the minute budget
// answers 200 with an errors.rateLimit entry instead of data - transient by
// definition, so the client paces itself on the header and retries the odd
// overshoot instead of dying mid-batch (the serial history backfill was the
// first casualty: 3 requests per fixture, hundreds of fixtures).

// Per-minute remaining from a response's headers; null when the pair is
// absent or garbage (callers leave their tracked state alone).
export function minuteRemaining(headers) {
    const v = headers?.['x-ratelimit-remaining'];
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// How long to sleep to land in the NEXT minute window (the budget resets on
// the minute), padded so a clock-skewed server still sees the new window.
export function msToNextMinute(now, padMs = 1000) {
    return 60000 - (now % 60000) + padMs;
}

// Does an api-sports `errors` payload (object or array form) describe the
// per-minute rate limit? Matched by the observed key (`rateLimit`) or by
// message text; the daily-quota message ("reached the request limit for the
// day") deliberately does NOT match - that one must stay fatal.
export function isRateLimitError(errors) {
    if (errors == null) return false;
    const texts = [];
    const scan = e => {
        if (e && typeof e === 'object') {
            if ('rateLimit' in e) return true;
            texts.push(...Object.values(e));
        } else {
            texts.push(e);
        }
        return false;
    };
    if (Array.isArray(errors)) {
        if (errors.some(scan)) return true;
    } else if (scan(errors)) {
        return true;
    }
    return texts.some(t => typeof t === 'string' && /rate ?limit|too many requests/i.test(t));
}

// Retry gate for _getPage's bounded loop: only rate-limit errors, only while
// attempts remain (attempt is 0-based; maxRetries 2 = 3 tries total).
export function shouldRetryRateLimit(errors, attempt, maxRetries = 2) {
    return attempt < maxRetries && isRateLimitError(errors);
}
