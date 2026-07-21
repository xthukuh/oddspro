// Exponential backoff for client polling. Pure + zero-import so it is
// offline-testable from the root suite, the same convention every decision
// module in this repo follows.
//
// Why this exists: every poll loop retried on a FIXED cadence regardless of
// failure - the freshness poll every 60s, the job poll every 2s, the visitor
// badge every 2 min. A server that is down, restarting, or mid-maintenance
// therefore took sustained request pressure from every open tab at exactly the
// moment it could least afford it, and a deploy or a DB restart looked to the
// operator like a small traffic spike. Backing off turns N tabs x forever into
// a quickly-thinning trickle.

export const DEFAULT_BACKOFF = Object.freeze({
    base: 2_000,      // first retry ~2s after the first failure
    factor: 2,        // 2s, 4s, 8s, 16s, 32s, then the cap
    cap: 60_000,      // never wait longer than a minute to notice recovery
    jitter: 0.2,      // +/-20%
});

// Delay before retry number `attempt` (1 = the first retry). Deterministic
// except for the jitter source, which is injected so tests can pin it.
//
// The jitter is not decoration: without it every tab that failed on the same
// server blip retries in the SAME instant forever, so recovery is greeted by a
// synchronized thundering herd - the classic way a service that just came back
// gets knocked over again.
export function nextDelay(attempt, opts = {}, rand = Math.random) {
    const { base, factor, cap, jitter } = { ...DEFAULT_BACKOFF, ...opts };
    const n = Math.max(1, Math.floor(Number(attempt) || 1));
    // Cap the EXPONENT before computing the power: at attempt ~1000 the
    // intermediate would be Infinity, and Infinity * jitter is NaN - a NaN
    // delay makes setTimeout fire immediately, turning the backoff into a
    // busy-loop. Clamp first, so the maths never leaves finite range.
    const steps = Math.min(n - 1, 32);
    const raw = Math.min(cap, base * Math.pow(factor, steps));
    const spread = raw * jitter;
    const delay = raw + (rand() * 2 - 1) * spread;
    // Never below base/2 (a jittered-down first retry must still be a pause)
    // and never above the cap plus its jitter allowance.
    return Math.round(Math.max(base / 2, Math.min(cap * (1 + jitter), delay)));
}

// Should the client show its "can't reach the server" warning yet? Deliberately
// NOT on the first failure: a single dropped request during a deploy or a brief
// network blip is normal and self-heals within one retry, and a banner that
// cries wolf gets dismissed reflexively - which is exactly when it stops
// working as a signal.
export const WARN_AFTER_FAILURES = 3;
export function shouldWarnOffline(consecutiveFailures, threshold = WARN_AFTER_FAILURES) {
    return (Number(consecutiveFailures) || 0) >= threshold;
}

// Fold one poll outcome into the backoff state. Success RESETS immediately
// (recovery must not be penalized by the failures that preceded it).
export function reduceBackoff(state, ok, opts = {}, rand = Math.random) {
    const failures = ok ? 0 : (Number(state?.failures) || 0) + 1;
    return {
        failures,
        // null delay = "resume the caller's normal interval"
        delay: ok ? null : nextDelay(failures, opts, rand),
        warn: shouldWarnOffline(failures, opts.warnAfter),
    };
}
