// Odds history pure rules (src/db/odds-history-rules.js). Offline. Spec:
// docs/dev/specs/2026-10-10-1600-odds-history-targets.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    eatWallClock, parseEatMs, historyGateOpen, observationKind, targetAt, planTargetFreezes, targetsPossiblyDue,
    asOfChangeId, replayState, kickoffMoved, planDueQueue, sweepStepAllowsDue,
    TARGETS, TIMED_TARGETS, FREEZE_MARGIN_MS, BASELINE_TOLERANCE_MS,
} from '../src/db/odds-history-rules.js';

const H = 3600_000, M = 60_000;
const KICK = Date.parse('2026-10-11T15:00:00+03:00');

test('EAT wall clock round-trips through parseEatMs at millisecond precision', () => {
    const ms = Date.parse('2026-10-10T12:34:56.789Z');
    assert.equal(eatWallClock(ms), '2026-10-10 15:34:56.789');
    assert.equal(parseEatMs(eatWallClock(ms)), ms);
    assert.equal(eatWallClock('junk'), null);
});

test('parseEatMs accepts the warehouse shapes and defaults to EAT', () => {
    assert.equal(parseEatMs('2026-10-11 15:00'), KICK);
    assert.equal(parseEatMs('2026-10-11 15:00:00'), KICK);
    assert.equal(parseEatMs('2026-10-11T15:00:00+03:00'), KICK);
    assert.equal(parseEatMs('2026-10-11T12:00:00Z'), KICK);
    assert.equal(parseEatMs('2026-10-11T15:00:00.123456'), KICK + 123); // MySQL %f
    assert.equal(parseEatMs('2026-10-11T15:00:00+0300'), KICK);
    assert.equal(parseEatMs(new Date(KICK)), KICK);
    assert.equal(parseEatMs(KICK), KICK);
    for (const junk of [null, '', 'tomorrow', '2026-10-11', NaN, {}]) assert.ok(Number.isNaN(parseEatMs(junk)), String(junk));
});

test('historyGateOpen: pre-match only, completed and unknown kickoff fail closed', () => {
    assert.equal(historyGateOpen({ nowMs: KICK - 1, kickoffMs: KICK }), true);
    assert.equal(historyGateOpen({ nowMs: KICK, kickoffMs: KICK }), false);
    assert.equal(historyGateOpen({ nowMs: KICK + 1, kickoffMs: KICK }), false);
    assert.equal(historyGateOpen({ nowMs: KICK - H, kickoffMs: KICK, completed: true }), false);
    assert.equal(historyGateOpen({ nowMs: KICK - H, kickoffMs: NaN }), false);
    assert.equal(historyGateOpen({ nowMs: KICK - H, kickoffMs: null }), false);
    assert.equal(historyGateOpen(), false);
});

test('observationKind: first, update, and the three baseline triggers', () => {
    assert.equal(observationKind({ existingCount: 0, lastObsMs: null }), 'first');
    assert.equal(observationKind({ existingCount: 0, lastObsMs: KICK }), 'update');
    // pre-existing match: odds on file, never logged
    assert.equal(observationKind({ existingCount: 5, lastObsMs: null }), 'baseline');
    // odds_markets written after the last logged look (knob gap / post-kickoff write)
    assert.equal(observationKind({ existingCount: 5, lastObsMs: KICK, touchedMaxMs: KICK + BASELINE_TOLERANCE_MS + 1 }), 'baseline');
    // the normal same-transaction stamp stays an update
    assert.equal(observationKind({ existingCount: 5, lastObsMs: KICK, touchedMaxMs: KICK + 900 }), 'update');
    assert.equal(observationKind({ existingCount: 5, lastObsMs: KICK, touchedMaxMs: null }), 'update');
});

test('targetAt anchors opening to the first look and the rest to the kickoff', () => {
    assert.deepEqual(TARGETS, ['opening', 't24h', 't3h', 't1h', 'closing']);
    assert.equal(targetAt('opening', { firstObsMs: 123 }), 123);
    assert.equal(targetAt('t24h', { kickoffMs: KICK }), KICK - 24 * H);
    assert.equal(targetAt('t3h', { kickoffMs: KICK }), KICK - 3 * H);
    assert.equal(targetAt('t1h', { kickoffMs: KICK }), KICK - H);
    assert.equal(targetAt('closing', { kickoffMs: KICK }), KICK);
    assert.ok(Number.isNaN(targetAt('t1h', {})));
    assert.ok(Number.isNaN(targetAt('nope', { kickoffMs: KICK })));
});

test('planTargetFreezes: opening at once, timed targets only after target_at + margin', () => {
    const observations = [{ ms: KICK - 30 * H, kind: 'first' }, { ms: KICK - 3 * H - 4 * M, kind: 'update' }];
    // 2h before kickoff: opening, t24h (looked at T-30h only -> lagged 6h) and t3h are due
    const plan = planTargetFreezes({ nowMs: KICK - 2 * H, kickoffMs: KICK, observations, maxLagMs: 15 * M });
    assert.deepEqual(plan.map(p => p.target), ['opening', 't24h', 't3h']);
    const by = Object.fromEntries(plan.map(p => [p.target, p]));
    assert.deepEqual(by.opening, { target: 'opening', target_at_ms: KICK - 30 * H, observed_at_ms: KICK - 30 * H, lag_seconds: 0, quality: 'ok' });
    assert.equal(by.t24h.quality, 'lagged');
    assert.equal(by.t24h.lag_seconds, 6 * 3600);
    assert.equal(by.t3h.quality, 'ok');
    assert.equal(by.t3h.lag_seconds, 240);
    // inside the settle margin nothing timed freezes yet
    const early = planTargetFreezes({ nowMs: KICK - H + FREEZE_MARGIN_MS - 1, kickoffMs: KICK, observations, frozen: ['opening', 't24h', 't3h'] });
    assert.deepEqual(early, []);
});

test('planTargetFreezes: no look at or before target_at is recorded as missing, never filled forward', () => {
    const observations = [{ ms: KICK - 10 * H, kind: 'first' }];
    const plan = planTargetFreezes({ nowMs: KICK + H, kickoffMs: KICK, observations, frozen: ['opening'] });
    const by = Object.fromEntries(plan.map(p => [p.target, p]));
    assert.deepEqual(by.t24h, { target: 't24h', target_at_ms: KICK - 24 * H, observed_at_ms: null, lag_seconds: null, quality: 'missing' });
    assert.equal(by.t3h.observed_at_ms, KICK - 10 * H);
    assert.equal(by.closing.target_at_ms, KICK);
});

test('planTargetFreezes: frozen targets are never planned again; baseline opening is flagged', () => {
    const observations = [{ ms: KICK - 2 * H, kind: 'baseline' }];
    // first logged 2h out: opening is flagged baseline, and the already-passed
    // t24h/t3h are honestly 'missing' (the log never saw them)
    const first = planTargetFreezes({ nowMs: KICK - 2 * H, kickoffMs: KICK, observations });
    assert.deepEqual(first[0], { target: 'opening', target_at_ms: KICK - 2 * H, observed_at_ms: KICK - 2 * H, lag_seconds: 0, quality: 'baseline' });
    assert.deepEqual(first.slice(1).map(p => `${p.target}:${p.quality}`), ['t24h:missing', 't3h:missing']);
    const all = planTargetFreezes({ nowMs: KICK + H, kickoffMs: KICK, observations, frozen: new Set(TARGETS) });
    assert.deepEqual(all, []);
    // never logged at all -> nothing, not five 'missing' rows
    assert.deepEqual(planTargetFreezes({ nowMs: KICK + H, kickoffMs: KICK, observations: [] }), []);
});

test('planTargetFreezes follows a rescheduled kickoff (target_at moves with it until frozen)', () => {
    const observations = [{ ms: KICK - 30 * H, kind: 'first' }, { ms: KICK + H - 70 * M, kind: 'update' }];
    // kickoff moved 2h later: at the OLD kickoff + 1h nothing timed is due except t24h/t3h
    const moved = KICK + 2 * H;
    const plan = planTargetFreezes({ nowMs: KICK + H, kickoffMs: moved, observations, frozen: ['opening'] });
    assert.deepEqual(plan.map(p => p.target), ['t24h', 't3h']);
    assert.equal(plan[1].target_at_ms, moved - 3 * H);
});

test('targetsPossiblyDue skips matches that can freeze nothing yet', () => {
    // no opening stored yet: always worth a look
    assert.equal(targetsPossiblyDue({ nowMs: KICK - 48 * H, kickoffMs: KICK, frozen: [] }), true);
    // opening stored, 2 days out: nothing timed has passed
    assert.equal(targetsPossiblyDue({ nowMs: KICK - 48 * H, kickoffMs: KICK, frozen: ['opening'] }), false);
    // t24h passed + margin, not stored
    assert.equal(targetsPossiblyDue({ nowMs: KICK - 24 * H + FREEZE_MARGIN_MS, kickoffMs: KICK, frozen: ['opening'] }), true);
    // everything passed but already stored
    assert.equal(targetsPossiblyDue({ nowMs: KICK + H, kickoffMs: KICK, frozen: TARGETS }), false);
    // unknown kickoff with opening stored: nothing timed can be planned
    assert.equal(targetsPossiblyDue({ nowMs: KICK, kickoffMs: NaN, frozen: ['opening'] }), false);
});

test('replayState: last event per identity up to the cutoff, stale means not offered', () => {
    const rows = [
        { id: 1, type_name: '1X2', name: '1', handicap: null, odds: '1.90', event: 'first_seen' },
        { id: 2, type_name: '1X2', name: '2', handicap: null, odds: '4.00', event: 'first_seen' },
        { id: 3, type_name: 'TOTAL', name: 'OVER', handicap: '2.5', odds: '1.80', event: 'first_seen' },
        { id: 7, type_name: '1X2', name: '1', handicap: null, odds: '1.75', event: 'changed' },
        { id: 8, type_name: '1X2', name: '2', handicap: null, odds: '4.00', event: 'stale' },
        { id: 9, type_name: '1X2', name: '2', handicap: null, odds: '4.50', event: 'revived' },
    ];
    assert.deepEqual(replayState(rows, 3).map(r => `${r.name}@${r.odds}`), ['1@1.9', '2@4', 'OVER@1.8']);
    assert.deepEqual(replayState(rows, 7).map(r => `${r.name}@${r.odds}`), ['1@1.75', '2@4', 'OVER@1.8']);
    assert.deepEqual(replayState(rows, 8).map(r => `${r.name}@${r.odds}`), ['1@1.75', 'OVER@1.8']);
    assert.deepEqual(replayState(rows, 9).map(r => `${r.name}@${r.odds}`), ['1@1.75', '2@4.5', 'OVER@1.8']);
    // unsorted input, null cutoff, junk
    assert.deepEqual(replayState([...rows].reverse(), 7).map(r => r.odds), [1.75, 4, 1.8]);
    assert.deepEqual(replayState(rows, null), []);
    assert.deepEqual(replayState(null, 5), []);
});

test('asOfChangeId picks the highest id at or before the observation instant', () => {
    const rows = [{ id: 1, observed_ms: 100 }, { id: 2, observed_ms: 100 }, { id: 5, observed_ms: 200 }];
    assert.equal(asOfChangeId(rows, 100), 2);
    assert.equal(asOfChangeId(rows, 150), 2);
    assert.equal(asOfChangeId(rows, 200), 5);
    assert.equal(asOfChangeId(rows, 99), null);
    assert.equal(asOfChangeId(rows, NaN), null);
});

test('kickoffMoved flags a minute or more of drift only', () => {
    assert.equal(kickoffMoved(KICK, KICK), false);
    assert.equal(kickoffMoved(KICK, KICK + 59_000), false);
    assert.equal(kickoffMoved(KICK, KICK + 2 * H), true);
    assert.equal(kickoffMoved(null, KICK), false);
});

test('planDueQueue: due inside a window when not looked at since it opened', () => {
    assert.deepEqual(TIMED_TARGETS, ['t24h', 't3h', 't1h', 'closing']);
    const now = KICK - H - 3 * M; // inside the t1h window (opens at T-1h-5m)
    const plan = planDueQueue(now, [
        { id: 1, kickoffMs: KICK, lastObsMs: KICK - 2 * H },          // due t1h
        { id: 2, kickoffMs: KICK, lastObsMs: KICK - H - 4 * M },      // looked inside the window: not due
        { id: 3, kickoffMs: KICK, lastObsMs: null },                  // never looked: due
        { id: 4, kickoffMs: KICK - 10 * M, lastObsMs: KICK - 2 * H }, // closing window not open yet
        { id: 5, kickoffMs: KICK - 4 * H, lastObsMs: null },          // already started: ignored
    ], { leadMin: 5, cap: 10 });
    assert.deepEqual(plan.due.map(d => `${d.id}:${d.target}`), ['1:t1h', '3:t1h']);
    assert.equal(plan.total, 2);
    // match 4's closing window opens at KICK-15m; that is the next window to open
    assert.equal(plan.nextOpenMs, KICK - 10 * M - 5 * M);
});

test('planDueQueue orders by urgency, caps, and is total over junk', () => {
    const now = KICK - 6 * M;
    const plan = planDueQueue(now, [
        { id: 'late', kickoffMs: KICK, lastObsMs: null },
        { id: 'soon', kickoffMs: KICK - 4 * M, lastObsMs: null },
    ], { leadMin: 10, cap: 1 });
    assert.deepEqual(plan.due.map(d => d.id), ['soon']);
    assert.equal(plan.total, 2);
    assert.deepEqual(planDueQueue(now, null), { due: [], total: 0, nextOpenMs: null });
    assert.deepEqual(planDueQueue(NaN, []), { due: [], total: 0, nextOpenMs: null });
    assert.deepEqual(planDueQueue(now, [{ id: 1, kickoffMs: KICK }], { leadMin: 0 }), { due: [], total: 0, nextOpenMs: null });
});

test('sweepStepAllowsDue allows only the listed enrichment steps (fail closed)', () => {
    for (const ok of ['deep stats (final correlated fixtures, fetch-once)', 'standings (correlated leagues)',
        'team history (upcoming correlated fixtures, fetch-once)', 'pre-match snapshots (upsert upcoming, freeze past)',
        'API predictions (upcoming correlated fixtures, fetch-once)', 'hot picks (rules; AI reviews run in the background worker)',
        'daily multibet slip (settle pending, build today\'s card)', 'AI enrichment (upcoming correlated fixtures; collection only)']) {
        assert.equal(sweepStepAllowsDue(ok), true, ok);
    }
    for (const no of ['fixtures 2026-10-10', 'results (settle finished fixtures, complete matches)', 'betpawa odds 2026-10-10',
        'betika odds 2026-10-11', 'link (correlate bookmaker matches to fixtures)', 'starting', '', null, undefined, 42]) {
        assert.equal(sweepStepAllowsDue(no), false, String(no));
    }
});
