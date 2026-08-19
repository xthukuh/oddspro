// Stalled-collection watchdog rules (src/db/watchdog-rules.js). All clocks
// are epoch ms so tests control time (the auto-rules.js convention).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionVerdict, nextStaleStreak, shouldAlert } from '../src/db/watchdog-rules.js';

const NOW = new Date('2026-08-19T12:00:00Z').getTime();

test('collectionVerdict is ok when odds are fresh and fixtures are nearby', () => {
    const v = collectionVerdict({ lastOddsMs: NOW - 10 * 60_000, nowMs: NOW, fixturesNearby: 3, staleMinutes: 45 });
    assert.equal(v.state, 'ok');
    assert.equal(v.minutes, 10);
});

test('collectionVerdict is stale when fixtures are nearby and odds are older than staleMinutes', () => {
    const v = collectionVerdict({ lastOddsMs: NOW - 46 * 60_000, nowMs: NOW, fixturesNearby: 1, staleMinutes: 45 });
    assert.equal(v.state, 'stale');
    assert.equal(v.minutes, 46);
});

test('collectionVerdict boundary: exactly staleMinutes old is still ok (strictly older triggers stale)', () => {
    const v = collectionVerdict({ lastOddsMs: NOW - 45 * 60_000, nowMs: NOW, fixturesNearby: 1, staleMinutes: 45 });
    assert.equal(v.state, 'ok');
});

test('collectionVerdict is idle (not stale) when no fixtures are nearby and under the quiet floor', () => {
    const v = collectionVerdict({
        lastOddsMs: NOW - 120 * 60_000, nowMs: NOW, fixturesNearby: 0, staleMinutes: 45, quietStaleMinutes: 240,
    });
    assert.equal(v.state, 'idle');
    assert.equal(v.minutes, 120);
});

test('collectionVerdict flags stale once the quiet floor is passed with no fixtures nearby', () => {
    const v = collectionVerdict({
        lastOddsMs: NOW - 241 * 60_000, nowMs: NOW, fixturesNearby: 0, staleMinutes: 45, quietStaleMinutes: 240,
    });
    assert.equal(v.state, 'stale');
    assert.equal(v.minutes, 241);
});

test('collectionVerdict treats a null lastOddsMs as stale when fixtures are nearby', () => {
    const v = collectionVerdict({ lastOddsMs: null, nowMs: NOW, fixturesNearby: 2 });
    assert.equal(v.state, 'stale');
    assert.equal(v.minutes, null);
});

test('collectionVerdict treats a null lastOddsMs as idle (not stale) when no fixtures are nearby', () => {
    const v = collectionVerdict({ lastOddsMs: null, nowMs: NOW, fixturesNearby: 0 });
    assert.equal(v.state, 'idle');
});

test('collectionVerdict is total against missing/default options', () => {
    const v = collectionVerdict({});
    assert.ok(['ok', 'idle', 'stale'].includes(v.state));
});

test('collectionVerdict uses the given staleMinutes/quietStaleMinutes floors, not hardcoded ones', () => {
    // Tight floor: 5 minutes old is already stale with fixtures nearby.
    assert.equal(collectionVerdict({ lastOddsMs: NOW - 6 * 60_000, nowMs: NOW, fixturesNearby: 1, staleMinutes: 5 }).state, 'stale');
    // Loose floor: 100 minutes old is still ok with fixtures nearby.
    assert.equal(collectionVerdict({ lastOddsMs: NOW - 100 * 60_000, nowMs: NOW, fixturesNearby: 1, staleMinutes: 200 }).state, 'ok');
});

// nextStaleStreak: the consecutive-stale counter persisted across cron runs.
test('nextStaleStreak increments on stale, resets on ok, holds on idle', () => {
    assert.equal(nextStaleStreak('stale', 0), 1);
    assert.equal(nextStaleStreak('stale', 2), 3);
    assert.equal(nextStaleStreak('ok', 5), 0);
    assert.equal(nextStaleStreak('idle', 5), 5);
});

test('nextStaleStreak tolerates a non-finite previous count', () => {
    assert.equal(nextStaleStreak('stale', NaN), 1);
    assert.equal(nextStaleStreak('idle', undefined), 0);
});

// shouldAlert: fire the one-time escalation SMS.
test('shouldAlert fires once the streak reaches the threshold and not already alerted', () => {
    assert.equal(shouldAlert(3, 3, false), true);
    assert.equal(shouldAlert(4, 3, false), true);
    assert.equal(shouldAlert(2, 3, false), false);
});

test('shouldAlert does not re-fire once already alerted for the streak', () => {
    assert.equal(shouldAlert(5, 3, true), false);
});
