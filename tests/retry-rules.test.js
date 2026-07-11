// DB deadlock retry rules (src/db/retry-rules.js). InnoDB deadlocks and lock-
// wait timeouts are TRANSIENT ("try restarting transaction") and strike when a
// warehouse write races another process's write on the same rows/gaps; the
// affected writes are idempotent (upserts / full-snapshot delete+insert), so a
// bounded retry clears them without surfacing a raw SQL dump to the user.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableDbError, retryDelayMs, withRetry } from '../src/db/retry-rules.js';

// isRetryableDbError: only transient lock contention is retryable.
test('isRetryableDbError matches deadlock by mysql2 code', () => {
    assert.equal(isRetryableDbError({ code: 'ER_LOCK_DEADLOCK' }), true);
    assert.equal(isRetryableDbError({ code: 'ER_LOCK_WAIT_TIMEOUT' }), true);
});

test('isRetryableDbError matches deadlock by mysql errno', () => {
    assert.equal(isRetryableDbError({ errno: 1213 }), true); // ER_LOCK_DEADLOCK
    assert.equal(isRetryableDbError({ errno: 1205 }), true); // ER_LOCK_WAIT_TIMEOUT
});

test('isRetryableDbError matches by message (knex flattens the SQL + reason)', () => {
    assert.equal(
        isRetryableDbError(new Error('insert into `teams` ... - Deadlock found when trying to get lock; try restarting transaction')),
        true,
    );
    assert.equal(isRetryableDbError(new Error('Lock wait timeout exceeded; try restarting transaction')), true);
});

test('isRetryableDbError rejects unrelated / permanent errors', () => {
    assert.equal(isRetryableDbError(null), false);
    assert.equal(isRetryableDbError(undefined), false);
    assert.equal(isRetryableDbError({ code: 'ER_DUP_ENTRY', errno: 1062 }), false);
    assert.equal(isRetryableDbError({ code: 'ER_NO_REFERENCED_ROW_2' }), false);
    assert.equal(isRetryableDbError(new Error('read ECONNRESET')), false);
});

// retryDelayMs: positive, non-decreasing in expectation (jittered backoff).
test('retryDelayMs grows with the attempt and stays positive', () => {
    for (let a = 0; a < 5; a++) {
        const d = retryDelayMs(a, 50);
        assert.ok(d > 0, `delay for attempt ${a} should be > 0`);
    }
    // Base scaling: attempt 1 window strictly exceeds attempt 0's floor.
    assert.ok(retryDelayMs(3, 50) >= retryDelayMs(0, 50));
});

const noSleep = async () => {};

test('withRetry returns the value on first success (no retry)', async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 42; }, { sleep: noSleep });
    assert.equal(out, 42);
    assert.equal(calls, 1);
});

// mysql2/knex throw real Error instances carrying `.code`/`.errno`.
const dbError = (message, code, errno) => Object.assign(new Error(message), { code, errno });

test('withRetry retries a transient deadlock then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(async () => {
        calls++;
        if (calls < 3) throw dbError('Deadlock found', 'ER_LOCK_DEADLOCK', 1213);
        return 'ok';
    }, { tries: 4, sleep: noSleep });
    assert.equal(out, 'ok');
    assert.equal(calls, 3);
});

test('withRetry rethrows a non-retryable error immediately', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => { calls++; throw dbError('Duplicate entry', 'ER_DUP_ENTRY', 1062); }, { sleep: noSleep }),
        /Duplicate entry/,
    );
    assert.equal(calls, 1); // no retry on a permanent error
});

test('withRetry gives up after `tries` transient failures and throws the last error', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => { calls++; throw new Error('Deadlock found; try restarting transaction'); }, { tries: 3, sleep: noSleep }),
        /Deadlock found/,
    );
    assert.equal(calls, 3); // exactly `tries` attempts
});
