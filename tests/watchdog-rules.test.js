// Stalled-collection watchdog rules (src/db/watchdog-rules.js). All clocks
// are epoch ms so tests control time (the auto-rules.js convention).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectionVerdict, nextStaleStreak, shouldAlert, resolveOddsSignal, shouldRestart, MAX_RESTART_ATTEMPTS } from '../src/db/watchdog-rules.js';

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

// resolveOddsSignal (CRITICAL fix, fix round 1, 2026-08-19): pick the
// dedicated last_odds_at meta stamp over the MAX(matches.updated_at)
// fallback whenever it exists at all, even if it reads OLDER than the
// fallback - a fresher results/link write must never mask a genuinely
// stalled odds scrape.
test('resolveOddsSignal prefers last_odds_at when present', () => {
    const r = resolveOddsSignal({ lastOddsAtMs: NOW - 100 * 60_000, fallbackMs: NOW - 5 * 60_000 });
    assert.equal(r.ms, NOW - 100 * 60_000);
    assert.equal(r.source, 'last_odds_at');
});

test('resolveOddsSignal prefers last_odds_at even when it is OLDER than the fallback', () => {
    // This is the whole point of the fix: a fresher matches.updated_at (from
    // results/link, unrelated to odds) must not mask a stale odds signal.
    const r = resolveOddsSignal({ lastOddsAtMs: NOW - 400 * 60_000, fallbackMs: NOW - 1 * 60_000 });
    assert.equal(r.ms, NOW - 400 * 60_000);
    assert.equal(r.source, 'last_odds_at');
});

test('resolveOddsSignal falls back to matches.updated_at only when last_odds_at has never been set', () => {
    const r = resolveOddsSignal({ lastOddsAtMs: null, fallbackMs: NOW - 5 * 60_000 });
    assert.equal(r.ms, NOW - 5 * 60_000);
    assert.match(r.source, /fallback/);
});

test('resolveOddsSignal is total against missing/non-finite inputs', () => {
    assert.equal(resolveOddsSignal({}).ms, null);
    assert.equal(resolveOddsSignal({ lastOddsAtMs: NaN, fallbackMs: NaN }).ms, null);
    assert.equal(resolveOddsSignal().ms, null);
});

// shouldRestart (Task 5, fix round 1): cap recovery restarts by a per-run
// cooldown and abandon them entirely past MAX_RESTART_ATTEMPTS consecutive
// stale runs (escalation is independent and unaffected by this).
test('shouldRestart allows the very first attempt (no prior restart recorded)', () => {
    assert.equal(shouldRestart({ streakCount: 1, lastRestartMs: null, nowMs: NOW }), true);
});

test('shouldRestart blocks a repeat attempt inside the cooldown window', () => {
    assert.equal(shouldRestart({
        streakCount: 2, lastRestartMs: NOW - 10 * 60_000, nowMs: NOW, cooldownMinutes: 30,
    }), false);
});

test('shouldRestart allows a repeat attempt once the cooldown has passed', () => {
    assert.equal(shouldRestart({
        streakCount: 3, lastRestartMs: NOW - 31 * 60_000, nowMs: NOW, cooldownMinutes: 30,
    }), true);
    // Exact boundary counts as passed (>=).
    assert.equal(shouldRestart({
        streakCount: 3, lastRestartMs: NOW - 30 * 60_000, nowMs: NOW, cooldownMinutes: 30,
    }), true);
});

test('shouldRestart stops entirely once the streak exceeds MAX_RESTART_ATTEMPTS, regardless of cooldown', () => {
    assert.equal(shouldRestart({ streakCount: MAX_RESTART_ATTEMPTS, lastRestartMs: null, nowMs: NOW }), true);
    assert.equal(shouldRestart({ streakCount: MAX_RESTART_ATTEMPTS + 1, lastRestartMs: null, nowMs: NOW }), false);
    assert.equal(shouldRestart({ streakCount: 999, lastRestartMs: null, nowMs: NOW }), false);
});

test('shouldRestart honors a custom maxAttempts override', () => {
    assert.equal(shouldRestart({ streakCount: 2, lastRestartMs: null, nowMs: NOW, maxAttempts: 2 }), true);
    assert.equal(shouldRestart({ streakCount: 3, lastRestartMs: null, nowMs: NOW, maxAttempts: 2 }), false);
});
// FIX 2026-09-05: a full sweep in progress (the writer's job_state beacon) is
// 'busy', never 'stale' - the sweep runs 2.5-7h live and every sweep morning
// used to restart the app and SMS the admin.
test('collectionVerdict is busy (not stale) while a full sweep inside the grace window holds the slot', () => {
    const v = collectionVerdict({
        lastOddsMs: NOW - 176 * 60_000, nowMs: NOW, fixturesNearby: 12, staleMinutes: 45,
        busyJob: { mode: 'full', startedMs: NOW - 180 * 60_000 }, busyGraceMinutes: 480,
    });
    assert.equal(v.state, 'busy');
    assert.equal(v.minutes, 180);
    assert.match(v.reason, /full sweep in progress/);
});

test('collectionVerdict ignores the beacon once the sweep is older than the grace window', () => {
    const v = collectionVerdict({
        lastOddsMs: NOW - 500 * 60_000, nowMs: NOW, fixturesNearby: 12, staleMinutes: 45,
        busyJob: { mode: 'full', startedMs: NOW - 481 * 60_000 }, busyGraceMinutes: 480,
    });
    assert.equal(v.state, 'stale');
});

test('collectionVerdict ignores a non-full, malformed or absent beacon', () => {
    const stale = { lastOddsMs: NOW - 100 * 60_000, nowMs: NOW, fixturesNearby: 3, staleMinutes: 45 };
    assert.equal(collectionVerdict({ ...stale, busyJob: { mode: 'light', startedMs: NOW - 5 * 60_000 } }).state, 'stale');
    assert.equal(collectionVerdict({ ...stale, busyJob: { mode: 'full', startedMs: NaN } }).state, 'stale');
    assert.equal(collectionVerdict({ ...stale, busyJob: null }).state, 'stale');
});

test('nextStaleStreak holds on busy, like idle', () => {
    assert.equal(nextStaleStreak('busy', 2), 2);
    assert.equal(nextStaleStreak('busy', 0), 0);
});
