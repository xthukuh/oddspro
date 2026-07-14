// Sliding-window rate-limit math (src/authlimit-rules.js). Pure, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slidingWindowAllow } from '../src/authlimit-rules.js';

test('allows up to max within the window, then blocks', () => {
    const win = { windowMs: 60_000, max: 3 };
    let hits = [];
    for (let i = 0; i < 3; i++) {
        const r = slidingWindowAllow(hits, 1000 + i, win);
        assert.equal(r.allowed, true);
        hits = r.hits;
    }
    const blocked = slidingWindowAllow(hits, 1003, win);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds >= 1);
    assert.equal(blocked.hits.length, 3); // the blocked hit is NOT recorded
});

test('old hits outside the window are pruned, freeing slots', () => {
    const win = { windowMs: 60_000, max: 2 };
    // hits at t=0 (61s old -> pruned) and t=30000 (31s old -> kept); now t=61000.
    const r = slidingWindowAllow([0, 30_000], 61_000, win);
    assert.equal(r.allowed, true);          // only 1 hit still in window, room for one more
    assert.deepEqual(r.hits, [30_000, 61_000]);
});

test('retryAfterSeconds counts down to when the earliest hit ages out', () => {
    const win = { windowMs: 60_000, max: 1 };
    const r = slidingWindowAllow([50_000], 80_000, win); // hit at 50s, now 80s
    assert.equal(r.allowed, false);
    // earliest (50s) frees at 50s+60s=110s; now 80s -> 30s left.
    assert.equal(r.retryAfterSeconds, 30);
});

test('handles an empty/undefined history', () => {
    const r = slidingWindowAllow(undefined, 1000, { windowMs: 1000, max: 1 });
    assert.equal(r.allowed, true);
    assert.deepEqual(r.hits, [1000]);
});
