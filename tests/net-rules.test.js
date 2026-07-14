// Network retry rules (src/db/net-rules.js). Outbound calls (api-sports,
// SMS) hit TRANSIENT socket/TLS/DNS faults - a single ECONNRESET was aborting
// the whole api-sports sweep because the line-96 GET had no retry. These errors
// are safe to retry (idempotent GETs / one-shot sends); a real HTTP error
// RESPONSE (4xx/5xx) is NOT a network fault and must not match here (the
// rate-limit path owns those). Disjoint from isRetryableDbError by design.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableNetworkError } from '../src/db/net-rules.js';
import { isRetryableDbError } from '../src/db/retry-rules.js';

// A socket error carries err.code and (usually) no HTTP response.
const netErr = (code, message) => Object.assign(new Error(message ?? code), { code });

// The exact live error that aborted the results sweep 2026-07-14.
const LIVE_ECONNRESET = Object.assign(
    new Error('Client network socket disconnected before secure TLS connection was established'),
    { code: 'ECONNRESET', isAxiosError: true },
);

test('isRetryableNetworkError matches the live ECONNRESET (TLS-before-established)', () => {
    assert.equal(isRetryableNetworkError(LIVE_ECONNRESET), true);
});

test('isRetryableNetworkError matches every transient socket/DNS code', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN',
        'EPIPE', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH']) {
        assert.equal(isRetryableNetworkError(netErr(code)), true, `${code} should retry`);
    }
});

test('isRetryableNetworkError matches an axios error with no response', () => {
    // axios sets isAxiosError; a request that never got a response = transient.
    assert.equal(isRetryableNetworkError({ isAxiosError: true, response: undefined }), true);
});

test('isRetryableNetworkError rejects an HTTP error RESPONSE (owned by the rate-limit path)', () => {
    // 429/500 etc. carry a response - NOT a network fault, must not retry here.
    assert.equal(isRetryableNetworkError({ isAxiosError: true, response: { status: 500 } }), false);
    assert.equal(isRetryableNetworkError({ isAxiosError: true, response: { status: 429 } }), false);
});

test('isRetryableNetworkError rejects the quota-floor throw and unrelated errors', () => {
    assert.equal(isRetryableNetworkError(new Error('api-sports quota floor reached (4 requests remaining <= 5)')), false);
    assert.equal(isRetryableNetworkError(null), false);
    assert.equal(isRetryableNetworkError(undefined), false);
    assert.equal(isRetryableNetworkError({ code: 'ER_DUP_ENTRY', errno: 1062 }), false);
});

// The two predicates are DISJOINT: a network fault is never a DB retry and a
// deadlock is never a network retry.
test('network and DB retry predicates are disjoint', () => {
    assert.equal(isRetryableDbError(LIVE_ECONNRESET), false);
    assert.equal(isRetryableNetworkError({ code: 'ER_LOCK_DEADLOCK', errno: 1213 }), false);
    assert.equal(isRetryableNetworkError(new Error('Deadlock found; try restarting transaction')), false);
});
