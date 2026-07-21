// Client polling backoff + deployed-version detection (web/src/backoff.js,
// web/src/appVersion.js). Pure, offline - same convention as the other shared
// web modules the root suite covers (config-snapshot, prefs-rules, freshness).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    nextDelay, reduceBackoff, shouldWarnOffline, DEFAULT_BACKOFF, WARN_AFTER_FAILURES,
} from '../web/src/backoff.js';
import {
    isStaleBuild, isKnownKey, keysToPrune, NEVER_PRUNE,
} from '../web/src/appVersion.js';

const noJitter = () => 0.5; // rand()=0.5 -> the jitter term is exactly 0

test('nextDelay grows exponentially and clamps at the cap', () => {
    const d = n => nextDelay(n, {}, noJitter);
    assert.equal(d(1), 2_000);    // base
    assert.equal(d(2), 4_000);
    assert.equal(d(3), 8_000);
    assert.equal(d(4), 16_000);
    assert.equal(d(5), 32_000);
    assert.equal(d(6), DEFAULT_BACKOFF.cap);   // clamped
    assert.equal(d(50), DEFAULT_BACKOFF.cap);  // stays clamped
});

test('nextDelay stays finite at absurd attempt counts', () => {
    // The exponent is clamped BEFORE the power, so the intermediate never
    // reaches Infinity. An Infinity * jitter term would be NaN, and a NaN
    // delay makes setTimeout fire immediately - turning the backoff into the
    // busy-loop it exists to prevent.
    for (const n of [100, 1_000, 10_000, Number.MAX_SAFE_INTEGER]) {
        const v = nextDelay(n, {}, noJitter);
        assert.ok(Number.isFinite(v), `attempt ${n} produced ${v}`);
        assert.ok(v <= DEFAULT_BACKOFF.cap * (1 + DEFAULT_BACKOFF.jitter));
    }
});

test('nextDelay applies bounded jitter in both directions', () => {
    const lo = nextDelay(3, {}, () => 0);   // -20%
    const hi = nextDelay(3, {}, () => 1);   // +20%
    assert.ok(lo < 8_000 && lo >= 6_400, `low jitter out of range: ${lo}`);
    assert.ok(hi > 8_000 && hi <= 9_600, `high jitter out of range: ${hi}`);
    // Jitter matters: without it every tab that failed on one server blip
    // retries in the same instant forever, so recovery meets a synchronized
    // herd. Assert the spread is real, not cosmetic.
    assert.ok(hi - lo > 1_000);
});

test('nextDelay never returns a delay below half the base', () => {
    // A jittered-down first retry must still be a pause, not an instant retry.
    assert.ok(nextDelay(1, {}, () => 0) >= DEFAULT_BACKOFF.base / 2);
});

test('shouldWarnOffline waits for repeated failures, not the first', () => {
    // One dropped request during a deploy is normal and self-heals; a banner
    // that cries wolf gets dismissed reflexively, which is when it stops
    // working as a signal.
    assert.equal(shouldWarnOffline(0), false);
    assert.equal(shouldWarnOffline(1), false);
    assert.equal(shouldWarnOffline(WARN_AFTER_FAILURES - 1), false);
    assert.equal(shouldWarnOffline(WARN_AFTER_FAILURES), true);
    assert.equal(shouldWarnOffline(99), true);
});

test('reduceBackoff resets immediately on success', () => {
    let s = { failures: 0, delay: null, warn: false };
    for (let i = 0; i < 5; i++) s = reduceBackoff(s, false, {}, noJitter);
    assert.equal(s.failures, 5);
    assert.equal(s.warn, true);
    assert.ok(s.delay > 0);
    // Recovery must not be penalized by the failures that preceded it.
    s = reduceBackoff(s, true, {}, noJitter);
    assert.deepEqual(s, { failures: 0, delay: null, warn: false });
});

test('reduceBackoff is total on missing state', () => {
    assert.equal(reduceBackoff(undefined, false, {}, noJitter).failures, 1);
    assert.equal(reduceBackoff(null, true, {}, noJitter).failures, 0);
});

// --- deployed-version detection ---------------------------------------------

test('isStaleBuild is conservative: any missing side answers false', () => {
    assert.equal(isStaleBuild('1.3.0+a', '1.3.0+b'), true);
    assert.equal(isStaleBuild('1.3.0+a', '1.3.0+a'), false);
    // The server returns null when web/dist carries no stamp (dev run, or a
    // backend deployed without a frontend build). A false positive would nag
    // every user to reload forever, which is far worse than missing one prompt.
    for (const [c, s] of [[null, '1.3.0+a'], ['1.3.0+a', null], ['', ''], [undefined, undefined],
        [1, 2], ['1.3.0+a', 7]]) {
        assert.equal(isStaleBuild(c, s), false, `${JSON.stringify([c, s])} should not be stale`);
    }
});

test('isKnownKey covers exact keys and the per-date selection prefix', () => {
    assert.equal(isKnownKey('oddspro.theme'), true);
    assert.equal(isKnownKey('oddspro.select.d.2026-07-21'), true);
    assert.equal(isKnownKey('oddspro.human'), false);   // retired PoW token
    assert.equal(isKnownKey('oddspro.whatever'), false);
    assert.equal(isKnownKey(null), false);
});

test('keysToPrune ONLY runs when the client is the currently deployed build', () => {
    const keys = ['oddspro.theme', 'oddspro.human', 'oddspro.obsolete', 'unrelated.key'];
    // Current build: prunes the unknown oddspro.* keys, leaves the rest.
    assert.deepEqual(
        keysToPrune(keys, { clientBuild: 'v1', serverBuild: 'v1' }).sort(),
        ['oddspro.human', 'oddspro.obsolete'],
    );
    // A STALE client prunes NOTHING. This is the guard that makes
    // prune-unknown safe, and the danger runs backwards from how it reads: the
    // OLD build is the one with the outdated key registry, so every key a
    // NEWER build legitimately added looks unknown to it. Pruning there would
    // delete real settings and, since prefs sync pushes the whole map
    // last-write-wins, propagate the deletion to every other device.
    assert.deepEqual(keysToPrune(keys, { clientBuild: 'v1', serverBuild: 'v2' }), []);
    // Unknown build on either side: also nothing.
    assert.deepEqual(keysToPrune(keys, { clientBuild: null, serverBuild: 'v2' }), []);
    assert.deepEqual(keysToPrune(keys, { clientBuild: 'v1', serverBuild: null }), []);
    assert.deepEqual(keysToPrune(keys, {}), []);
});

test('keysToPrune never touches non-oddspro keys or the protected set', () => {
    const keys = ['other.app.token', 'token', ...NEVER_PRUNE];
    assert.deepEqual(keysToPrune(keys, { clientBuild: 'v1', serverBuild: 'v1' }), []);
    // Spelled out: pruning the session key would sign the user out - a
    // spectacular way for a silent "cleanup" to announce itself.
    assert.equal(NEVER_PRUNE.includes('oddspro.session'), true);
});

test('keysToPrune is total on junk input', () => {
    for (const junk of [null, undefined, 'nope', 42, [null, 7, {}]]) {
        assert.deepEqual(keysToPrune(junk, { clientBuild: 'v1', serverBuild: 'v1' }), []);
    }
});
