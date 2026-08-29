// Auto-refresh scheduling rules (src/db/auto-rules.js). The scheduler tick
// feeds these predicates epoch ms; "daily" is an EAT calendar day (+03:00,
// no DST), independent of the server's timezone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseDailyTime, eatDateKey, eatMinutesOfDay, isFullDue, isLightDue, trimLogTail, refreshOutcome,
    shouldConsumeRefreshRequest, summarizeSteps, makeStepGuard, hasDataBearingSuccess, shouldStampFreshness,
    summarizeTimings,
    hasOddsSaveData, fullSweepAttemptVerdict,
} from '../src/db/auto-rules.js';

// refreshOutcome (F3): classify a finished refresh job.
test('refreshOutcome reports ok for a clean run', () => {
    assert.equal(refreshOutcome({ error: null, cancelRequested: false }), 'ok');
    assert.equal(refreshOutcome({}), 'ok');
});

test('refreshOutcome reports error when a run threw without a cancel', () => {
    assert.equal(refreshOutcome({ error: 'boom', cancelRequested: false }), 'error');
});

test('refreshOutcome treats a cancel as cancelled even if the abort threw', () => {
    assert.equal(refreshOutcome({ error: 'cancelled', cancelRequested: true }), 'cancelled');
    assert.equal(refreshOutcome({ error: null, cancelRequested: true }), 'cancelled');
});

// refreshOutcome (Task A, 2026-08-19): 'partial' surfaces a light pass where
// some guarded steps failed and some succeeded, via summary.steps_verdict.
test('refreshOutcome reports partial from a partial-steps summary', () => {
    assert.equal(refreshOutcome({ error: null, cancelRequested: false, summary: { steps_verdict: 'partial' } }), 'partial');
});

test('refreshOutcome lets error/cancelled win over a partial-steps summary', () => {
    assert.equal(refreshOutcome({ error: 'boom', summary: { steps_verdict: 'partial' } }), 'error');
    assert.equal(refreshOutcome({ cancelRequested: true, summary: { steps_verdict: 'partial' } }), 'cancelled');
});

test('refreshOutcome ignores a non-partial or absent steps_verdict', () => {
    assert.equal(refreshOutcome({ summary: { steps_verdict: 'ok' } }), 'ok');
    assert.equal(refreshOutcome({ summary: {} }), 'ok');
    assert.equal(refreshOutcome({ summary: null }), 'ok');
});

// summarizeSteps (Task A): classify a light pass's guarded per-step outcomes.
test('summarizeSteps reports ok when every step succeeded, or none ran', () => {
    assert.equal(summarizeSteps([{ step: 'results', ok: true }, { step: 'link', ok: true }]), 'ok');
    assert.equal(summarizeSteps([]), 'ok');
    assert.equal(summarizeSteps(null), 'ok');
    assert.equal(summarizeSteps(undefined), 'ok');
});

test('summarizeSteps reports error only when every step that ran failed', () => {
    assert.equal(summarizeSteps([{ step: 'results', ok: false, error: 'boom' }]), 'error');
    assert.equal(summarizeSteps([
        { step: 'results', ok: false, error: 'a' },
        { step: 'link', ok: false, error: 'b' },
    ]), 'error');
});

test('summarizeSteps reports partial when some steps failed and some succeeded', () => {
    assert.equal(summarizeSteps([
        { step: 'results', ok: false, error: 'boom' },
        { step: 'betpawa odds', ok: true },
        { step: 'betika odds', ok: true },
    ]), 'partial');
    // Order independent.
    assert.equal(summarizeSteps([
        { step: 'betpawa odds', ok: true },
        { step: 'betika odds', ok: false, error: 'timeout' },
    ]), 'partial');
});

// makeStepGuard (fix round 1, 2026-08-19): the extracted, injectable guard
// behind lightRefresh's guardStep. The regression that matters most here is a
// swallowed cancel - a cancel signal from checkCancel must propagate OUT of
// the guard uncaught (never recorded as a step failure), while an ordinary
// Error thrown by the step's own work must be captured and never escape.
test('makeStepGuard lets a cancel thrown by checkCancel propagate uncaught, unrecorded', async () => {
    const results = [];
    const guard = makeStepGuard({ results, checkCancel: () => { throw new Error('cancelled'); } });
    await assert.rejects(() => guard('some step', async () => 'unused'), /cancelled/);
    assert.deepEqual(results, []); // never recorded as a step failure
});

test('makeStepGuard captures an ordinary step failure into results without throwing', async () => {
    const results = [];
    const failures = [];
    let t = 1000;
    const guard = makeStepGuard({ results, onFailure: (label, message) => failures.push([label, message]), now: () => (t += 250) });
    const out = await guard('flaky step', async () => { throw new Error('boom'); });
    assert.equal(out, undefined);
    assert.deepEqual(results, [{ step: 'flaky step', ok: false, error: 'boom', ms: 250 }]);
    assert.deepEqual(failures, [['flaky step', 'boom']]);
});

test('makeStepGuard records success and resolves to the step function\'s return value', async () => {
    const results = [];
    let t = 1000;
    const guard = makeStepGuard({ results, now: () => (t += 250) });
    const out = await guard('ok step', async () => 42);
    assert.equal(out, 42);
    assert.deepEqual(results, [{ step: 'ok step', ok: true, ms: 250 }]);
});

test('makeStepGuard calls checkCancel with the label BEFORE the step function ever runs', async () => {
    const seen = [];
    const results = [];
    const guard = makeStepGuard({ results, checkCancel: label => seen.push(label) });
    await guard('labelled', async () => { seen.push('fn ran'); return 'x'; });
    assert.deepEqual(seen, ['labelled', 'fn ran']);
});

test('makeStepGuard never calls the step function when checkCancel throws', async () => {
    const results = [];
    let fnCalled = false;
    const guard = makeStepGuard({ results, checkCancel: () => { throw new Error('cancelled'); } });
    await assert.rejects(() => guard('x', async () => { fnCalled = true; }));
    assert.equal(fnCalled, false);
});

// hasDataBearingSuccess (Task 4, fix round 1): only results/per-provider odds
// count as "the warehouse actually collected something new".
test('hasDataBearingSuccess is true when results or either provider succeeded', () => {
    assert.equal(hasDataBearingSuccess([{ step: 'results', ok: true }]), true);
    assert.equal(hasDataBearingSuccess([{ step: 'betpawa odds', ok: true }]), true);
    assert.equal(hasDataBearingSuccess([{ step: 'betika odds', ok: true }]), true);
});

test('hasDataBearingSuccess is false when only link/settle-picks/idle-check succeeded', () => {
    assert.equal(hasDataBearingSuccess([
        { step: 'results', ok: false, error: 'boom' },
        { step: 'betpawa odds', ok: false, error: 'boom' },
        { step: 'betika odds', ok: false, error: 'boom' },
        { step: 'odds idle check', ok: true },
        { step: 'link', ok: true },
        { step: 'settle picks', ok: true },
    ]), false);
});

test('hasDataBearingSuccess is false on empty/null/undefined input', () => {
    assert.equal(hasDataBearingSuccess([]), false);
    assert.equal(hasDataBearingSuccess(null), false);
    assert.equal(hasDataBearingSuccess(undefined), false);
});

// hasDataBearingSuccess (round 2, 2026-08-19): the regex is now a PREFIX
// match so the full sweep's per-date-per-provider labels count too, while
// canonical fixtures (cheaply refetchable, not view-once) stay excluded.
test('hasDataBearingSuccess matches the full sweep\'s per-date odds labels', () => {
    assert.equal(hasDataBearingSuccess([{ step: 'betpawa odds 2026-08-20', ok: true }]), true);
    assert.equal(hasDataBearingSuccess([{ step: 'betika odds 2026-08-21', ok: true }]), true);
    assert.equal(hasDataBearingSuccess([{ step: 'results', ok: true }]), true); // bare label still matches
});

test('hasDataBearingSuccess still excludes fixtures and non-data-bearing steps under the prefix match', () => {
    assert.equal(hasDataBearingSuccess([
        { step: 'fixtures 2026-08-20', ok: true },
        { step: 'link', ok: true },
        { step: 'odds idle check', ok: true },
        { step: 'settle picks', ok: true },
    ]), false);
});

// shouldStampFreshness (Task 4, fix round 1): 'ok' always stamps; 'partial'
// only stamps when a data-bearing step actually succeeded; everything else
// (error/cancelled) never stamps.
test('shouldStampFreshness always stamps on ok, regardless of summary', () => {
    assert.equal(shouldStampFreshness('ok', null), true);
    assert.equal(shouldStampFreshness('ok', {}), true);
    assert.equal(shouldStampFreshness('ok', { data_bearing_ok: false }), true);
});

test('shouldStampFreshness on partial defers to summary.data_bearing_ok', () => {
    assert.equal(shouldStampFreshness('partial', { data_bearing_ok: true }), true);
    assert.equal(shouldStampFreshness('partial', { data_bearing_ok: false }), false);
    assert.equal(shouldStampFreshness('partial', {}), false);
    assert.equal(shouldStampFreshness('partial', null), false);
});

test('shouldStampFreshness never stamps on error or cancelled', () => {
    assert.equal(shouldStampFreshness('error', { data_bearing_ok: true }), false);
    assert.equal(shouldStampFreshness('cancelled', { data_bearing_ok: true }), false);
});

// hasOddsSaveData (defect 3, 2026-08-19): the collection heartbeat must only
// stamp `last_odds_at` when saveMatches() actually left something new behind,
// never merely because the call did not throw.
test('hasOddsSaveData is true when markets were written', () => {
    assert.equal(hasOddsSaveData({ inserted: 0, updated: 0, skipped: 5, markets: 12 }), true);
});

test('hasOddsSaveData is true when a match was inserted or updated, even with zero markets', () => {
    assert.equal(hasOddsSaveData({ inserted: 1, updated: 0, skipped: 0, markets: 0 }), true);
    assert.equal(hasOddsSaveData({ inserted: 0, updated: 1, skipped: 0, markets: 0 }), true);
});

test('hasOddsSaveData is false on the all-zero counts saveMatches returns for an empty games array', () => {
    assert.equal(hasOddsSaveData({ inserted: 0, updated: 0, skipped: 0, markets: 0 }), false);
});

test('hasOddsSaveData is false when everything was skipped (completed matches only)', () => {
    assert.equal(hasOddsSaveData({ inserted: 0, updated: 0, skipped: 40, markets: 0 }), false);
});

test('hasOddsSaveData is false on missing/malformed input', () => {
    assert.equal(hasOddsSaveData(null), false);
    assert.equal(hasOddsSaveData(undefined), false);
    assert.equal(hasOddsSaveData({}), false);
});

const utc = iso => new Date(iso).getTime();

test('parseDailyTime parses HH:MM and rejects everything else', () => {
    assert.equal(parseDailyTime('06:00'), 360);
    assert.equal(parseDailyTime('00:00'), 0);
    assert.equal(parseDailyTime('23:59'), 23 * 60 + 59);
    assert.equal(parseDailyTime(' 06:00 '), 360); // trimmed
    assert.equal(parseDailyTime(''), null);       // disabled
    assert.equal(parseDailyTime('off'), null);
    assert.equal(parseDailyTime('OFF'), null);
    assert.equal(parseDailyTime('6:00'), null);   // strict two-digit hours
    assert.equal(parseDailyTime('24:00'), null);
    assert.equal(parseDailyTime('06:60'), null);
    assert.equal(parseDailyTime('garbage'), null);
    assert.equal(parseDailyTime(null), null);
    assert.equal(parseDailyTime(undefined), null);
});

test('eatDateKey/eatMinutesOfDay shift UTC into the EAT day', () => {
    // 2026-07-09 22:30 UTC = 2026-07-10 01:30 EAT - next EAT day
    assert.equal(eatDateKey(utc('2026-07-09T22:30:00Z')), '2026-07-10');
    assert.equal(eatMinutesOfDay(utc('2026-07-09T22:30:00Z')), 90);
    // 2026-07-09 12:00 UTC = 15:00 EAT, same day
    assert.equal(eatDateKey(utc('2026-07-09T12:00:00Z')), '2026-07-09');
    assert.equal(eatMinutesOfDay(utc('2026-07-09T12:00:00Z')), 15 * 60);
});

test('isFullDue fires once past the EAT time, once per EAT day', () => {
    const at = parseDailyTime('06:00'); // 06:00 EAT = 03:00 UTC
    // Before the mark: not due
    assert.equal(isFullDue(utc('2026-07-09T02:55:00Z'), at, null), false);
    // Past the mark, never ran: due
    assert.equal(isFullDue(utc('2026-07-09T03:05:00Z'), at, null), true);
    // Past the mark but already started this EAT day: blocked
    assert.equal(isFullDue(utc('2026-07-09T03:05:00Z'), at, '2026-07-09'), false);
    assert.equal(isFullDue(utc('2026-07-09T20:00:00Z'), at, '2026-07-09'), false);
    // Next EAT day re-arms (21:05 UTC on the 9th is 00:05 EAT on the 10th -
    // before 06:00 EAT, so still not due; 03:05 UTC on the 10th is)
    assert.equal(isFullDue(utc('2026-07-09T21:05:00Z'), at, '2026-07-09'), false);
    assert.equal(isFullDue(utc('2026-07-10T03:05:00Z'), at, '2026-07-09'), true);
    // Disabled mode never fires
    assert.equal(isFullDue(utc('2026-07-09T03:05:00Z'), null, null), false);
});

test('isLightDue is an elapsed-interval check; 0 disables', () => {
    const t0 = utc('2026-07-09T10:00:00Z');
    assert.equal(isLightDue(t0 + 9 * 60_000, t0, 10), false);
    assert.equal(isLightDue(t0 + 10 * 60_000, t0, 10), true); // exact boundary
    assert.equal(isLightDue(t0 + 60 * 60_000, t0, 10), true);
    assert.equal(isLightDue(t0 + 60 * 60_000, t0, 0), false); // disabled
});

// shouldConsumeRefreshRequest: the writer tick's gate on a follower-queued
// refresh_request (src/meta.js), applying the same freshness/cooldown guards
// server.js's own POST /api/refresh handler applies to a writer-direct click.
const NOW = new Date('2026-08-19T12:00:00Z').getTime();

test('shouldConsumeRefreshRequest runs a well-shaped request with no guard state', () => {
    assert.equal(shouldConsumeRefreshRequest({ date: '2026-08-19', requested_at: 'x', by: 'follower' }, { nowMs: NOW }), 'run');
});

test('shouldConsumeRefreshRequest refuses an absent or malformed request', () => {
    assert.equal(shouldConsumeRefreshRequest(null, { nowMs: NOW }), 'invalid');
    assert.equal(shouldConsumeRefreshRequest(undefined, { nowMs: NOW }), 'invalid');
    assert.equal(shouldConsumeRefreshRequest({}, { nowMs: NOW }), 'invalid');
    assert.equal(shouldConsumeRefreshRequest({ date: '' }, { nowMs: NOW }), 'invalid');
    assert.equal(shouldConsumeRefreshRequest({ date: '2026-8-19' }, { nowMs: NOW }), 'invalid');   // strict zero-padding
    assert.equal(shouldConsumeRefreshRequest({ date: 'not-a-date' }, { nowMs: NOW }), 'invalid');
    assert.equal(shouldConsumeRefreshRequest('2026-08-19', { nowMs: NOW }), 'invalid');           // not an object
});

test('shouldConsumeRefreshRequest skips fresh when the date was recently refreshed', () => {
    const req = { date: '2026-08-19' };
    // Refreshed 3 minutes ago, cache window 5 minutes - inside the window.
    assert.equal(shouldConsumeRefreshRequest(req, {
        nowMs: NOW, lastFreshMs: NOW - 3 * 60_000, cacheMinutes: 5,
    }), 'fresh');
    // Exactly at the boundary counts as still fresh (strict <, matches server.js).
    assert.equal(shouldConsumeRefreshRequest(req, {
        nowMs: NOW, lastFreshMs: NOW - 5 * 60_000 - 1, cacheMinutes: 5,
    }), 'run');
});

test('shouldConsumeRefreshRequest ignores freshness when REFRESH_CACHE_MINUTES is off (0)', () => {
    assert.equal(shouldConsumeRefreshRequest({ date: '2026-08-19' }, {
        nowMs: NOW, lastFreshMs: NOW - 1000, cacheMinutes: 0,
    }), 'run');
});

test('shouldConsumeRefreshRequest skips cooldown when the last consumed run was too recent', () => {
    const req = { date: '2026-08-19' };
    // Last queued run started 4 minutes ago, cooldown 10 minutes - blocked.
    assert.equal(shouldConsumeRefreshRequest(req, {
        nowMs: NOW, lastManualMs: NOW - 4 * 60_000, cooldownMinutes: 10,
    }), 'cooldown');
    // Past the cooldown window - allowed.
    assert.equal(shouldConsumeRefreshRequest(req, {
        nowMs: NOW, lastManualMs: NOW - 11 * 60_000, cooldownMinutes: 10,
    }), 'run');
});

test('shouldConsumeRefreshRequest ignores cooldown when REFRESH_COOLDOWN_MINUTES is off (0)', () => {
    assert.equal(shouldConsumeRefreshRequest({ date: '2026-08-19' }, {
        nowMs: NOW, lastManualMs: NOW - 1000, cooldownMinutes: 0,
    }), 'run');
});

test('shouldConsumeRefreshRequest checks freshness before cooldown', () => {
    assert.equal(shouldConsumeRefreshRequest({ date: '2026-08-19' }, {
        nowMs: NOW,
        lastFreshMs: NOW - 1000, cacheMinutes: 5,
        lastManualMs: NOW - 1000, cooldownMinutes: 10,
    }), 'fresh');
});

// fullSweepAttemptVerdict (Task 2, 2026-08-19 durability round 2): decides
// whether the writer's tick should attempt today's full sweep, given a
// success-only lastKey (dayKey of the last completed sweep) and a per-day
// attempt cap.
test('fullSweepAttemptVerdict says done once the day already has a completed sweep', () => {
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: '2026-08-19', attempts: 0, maxAttempts: 3 }), 'done');
    // Even a fresh attempts=0 counter can't override an already-completed day.
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: '2026-08-19', attempts: 5, maxAttempts: 3 }), 'done');
});

test('fullSweepAttemptVerdict runs when the day is not yet completed and attempts remain', () => {
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: null, attempts: 0, maxAttempts: 3 }), 'run');
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: '2026-08-18', attempts: 2, maxAttempts: 3 }), 'run');
});

test('fullSweepAttemptVerdict exhausts once attempts reach maxAttempts without a completed sweep', () => {
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: null, attempts: 3, maxAttempts: 3 }), 'exhausted');
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: '2026-08-18', attempts: 4, maxAttempts: 3 }), 'exhausted');
});

test('fullSweepAttemptVerdict treats maxAttempts <= 0 as unlimited retries', () => {
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', lastKey: null, attempts: 999, maxAttempts: 0 }), 'run');
});

test('fullSweepAttemptVerdict defaults to a fresh, capped-at-3 attempt when fields are omitted', () => {
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19' }), 'run');
    assert.equal(fullSweepAttemptVerdict({ dayKey: '2026-08-19', attempts: 3 }), 'exhausted');
});

test('trimLogTail keeps content under the cap unchanged', () => {
    const content = 'a\nb\nc\n';
    assert.equal(trimLogTail(content, 100), content);
    assert.equal(trimLogTail(content, content.length), content);
});

test('trimLogTail over the cap keeps <= half, at a line boundary, marked', () => {
    const lines = [...Array(100)].map((_, i) => `line-${String(i).padStart(3, '0')}`);
    const content = lines.join('\n') + '\n';
    const out = trimLogTail(content, 200, '2026-07-09T12:00:00.000Z');
    assert.ok(out.startsWith('[log truncated 2026-07-09T12:00:00.000Z]\n'));
    const body = out.slice(out.indexOf('\n') + 1);
    assert.ok(body.length <= 100);              // half the cap
    assert.ok(body.startsWith('line-'));        // starts at a whole line
    assert.ok(body.endsWith('line-099\n'));     // newest lines survive
});

// summarizeTimings (2026-08-29 profiling pass): the compact "where did the
// time go" clause appended to the one-line run summary.
test('summarizeTimings ranks phases slowest first, in seconds', () => {
    const out = summarizeTimings([
        { step: 'link', ok: true, ms: 5000 },
        { step: 'deep stats', ok: true, ms: 60000 },
        { step: 'standings', ok: true, ms: 20000 },
    ]);
    assert.equal(out, 'deep stats 60s, standings 20s, link 5s');
});

test('summarizeTimings groups per-date labels into one phase row', () => {
    const out = summarizeTimings([
        { step: 'betpawa odds 2026-08-29', ok: true, ms: 30000 },
        { step: 'betpawa odds 2026-08-30', ok: true, ms: 30000 },
        { step: 'betpawa odds 2026-08-31', ok: true, ms: 30000 },
        { step: 'fixtures 2026-08-29', ok: true, ms: 10000 },
    ]);
    assert.equal(out, 'betpawa odds 90s, fixtures 10s');
});

test('summarizeTimings strips the explanatory parenthetical from a label', () => {
    const out = summarizeTimings([
        { step: 'deep stats (final correlated fixtures, fetch-once)', ok: true, ms: 7000 },
    ]);
    assert.equal(out, 'deep stats 7s');
});

test('summarizeTimings drops steps below minMs and honours top', () => {
    const rows = [
        { step: 'a', ok: true, ms: 9000 },
        { step: 'b', ok: true, ms: 8000 },
        { step: 'c', ok: true, ms: 7000 },
        { step: 'trivial', ok: true, ms: 10 },
    ];
    assert.equal(summarizeTimings(rows, { top: 2 }), 'a 9s, b 8s');
    assert.equal(summarizeTimings(rows).includes('trivial'), false);
});

test('summarizeTimings times a FAILED step too - a slow step that then threw still shows', () => {
    const out = summarizeTimings([{ step: 'results', ok: false, error: 'boom', ms: 42000 }]);
    assert.equal(out, 'results 42s');
});

test('summarizeTimings is total against missing/garbage input', () => {
    assert.equal(summarizeTimings(null), '');
    assert.equal(summarizeTimings([]), '');
    assert.equal(summarizeTimings([{ step: 'x', ok: true }]), '');
    assert.equal(summarizeTimings([{ step: 'x', ok: true, ms: -5 }]), '');
    assert.equal(summarizeTimings([{ ms: 4000 }]), 'unknown 4s');
});
