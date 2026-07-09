// api-sports rate-limit decision rules (src/db/rate-rules.js): per-minute
// header parsing, next-window sleep math and the bounded-retry gate. Pure
// module - no .env/DB/axios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    minuteRemaining, msToNextMinute, isRateLimitError, shouldRetryRateLimit,
} from '../src/db/rate-rules.js';

// The exact live error that killed a history backfill (2026-07-09)
const LIVE_RATE_ERROR = {
    rateLimit: 'Too many requests. You have exceeded the limit of requests per minute of your subscription.',
};

test('minuteRemaining reads the per-minute header, null when absent or garbage', () => {
    assert.equal(minuteRemaining({ 'x-ratelimit-remaining': '7' }), 7);
    assert.equal(minuteRemaining({ 'x-ratelimit-remaining': 0 }), 0);
    assert.equal(minuteRemaining({ 'x-ratelimit-requests-remaining': '99' }), null); // daily pair, not minute
    assert.equal(minuteRemaining({}), null);
    assert.equal(minuteRemaining(undefined), null);
    assert.equal(minuteRemaining({ 'x-ratelimit-remaining': 'abc' }), null);
    assert.equal(minuteRemaining({ 'x-ratelimit-remaining': '' }), null);
});

test('msToNextMinute waits out the current window plus the pad', () => {
    assert.equal(msToNextMinute(90_500), 30_500);       // 29.5s left + 1s pad
    assert.equal(msToNextMinute(120_000), 61_000);      // exact boundary = full window
    assert.equal(msToNextMinute(59_999, 0), 1);         // 1ms to the boundary, no pad
    assert.equal(msToNextMinute(59_999, 500), 501);
});

test('isRateLimitError matches the observed live shape and text variants', () => {
    assert.equal(isRateLimitError(LIVE_RATE_ERROR), true);
    assert.equal(isRateLimitError([LIVE_RATE_ERROR]), true);                 // array form
    assert.equal(isRateLimitError(['Too many requests per minute']), true); // bare string item
    assert.equal(isRateLimitError({ other: 'Rate limit exceeded' }), true); // text match, odd key
});

test('isRateLimitError stays false for fatal errors - especially the daily quota', () => {
    // The daily-quota message says "request limit", not "rate limit" - it
    // must stay fatal so the APISPORTS_MIN_REMAINING floor semantics hold.
    assert.equal(isRateLimitError({ requests: 'You have reached the request limit for the day.' }), false);
    assert.equal(isRateLimitError({ token: 'Error/Missing application key.' }), false);
    assert.equal(isRateLimitError([]), false);
    assert.equal(isRateLimitError({}), false);
    assert.equal(isRateLimitError(null), false);
});

test('shouldRetryRateLimit bounds the retries (0-based attempt counter)', () => {
    assert.equal(shouldRetryRateLimit(LIVE_RATE_ERROR, 0), true);
    assert.equal(shouldRetryRateLimit(LIVE_RATE_ERROR, 1), true);
    assert.equal(shouldRetryRateLimit(LIVE_RATE_ERROR, 2), false);          // 2 retries max
    assert.equal(shouldRetryRateLimit(LIVE_RATE_ERROR, 0, 0), false);       // retries disabled
    assert.equal(shouldRetryRateLimit({ token: 'bad key' }, 0), false);     // non-rate error never retries
});
