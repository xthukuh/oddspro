// Pure DB deadlock retry rules (zero imports, offline-testable). InnoDB
// deadlocks and lock-wait timeouts are TRANSIENT ("try restarting transaction")
// and strike when a warehouse write races another PROCESS's write on the same
// rows/index gaps (a 2nd `serve`, a CLI run, or cron - the single-slot job
// guard only serialises writes within one process). The affected writes are
// idempotent (upserts / full-snapshot delete+insert), so a bounded retry clears
// the contention instead of surfacing a raw ~2 KB SQL dump to the user.

// mysql2 surfaces these as `err.code` (string) / `err.errno` (number); knex
// re-throws with the SQL + reason flattened into `err.message`, so match all
// three. 1213 = ER_LOCK_DEADLOCK, 1205 = ER_LOCK_WAIT_TIMEOUT.
const RETRYABLE_CODES = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);
const RETRYABLE_ERRNO = new Set([1213, 1205]);
const RETRYABLE_MSG = /deadlock found|lock wait timeout/i;

export function isRetryableDbError(err) {
    if (!err) return false;
    if (err.code && RETRYABLE_CODES.has(err.code)) return true;
    if (err.errno != null && RETRYABLE_ERRNO.has(err.errno)) return true;
    return RETRYABLE_MSG.test(String(err.message ?? err));
}

// Jittered backoff (ms) for a 0-based attempt: base * 2^attempt scaled by a
// random [0.5, 1.5) factor so racing writers don't re-collide in lock-step.
export function retryDelayMs(attempt, base = 50) {
    return Math.round(base * 2 ** attempt * (0.5 + Math.random()));
}

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Run `fn`, retrying transient DB errors up to `tries` TOTAL attempts. A
// non-retryable error (or the final attempt) throws straight through. `sleep`
// and `isRetryable` are injectable for offline tests.
export async function withRetry(fn, {
    tries = 4, base = 50, sleep = defaultSleep, isRetryable = isRetryableDbError,
} = {}) {
    let lastErr;
    for (let attempt = 0; attempt < tries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (!isRetryable(err) || attempt === tries - 1) throw err;
            await sleep(retryDelayMs(attempt, base));
        }
    }
    throw lastErr; // unreachable: the loop returns or throws
}
