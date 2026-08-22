import test from 'node:test';
import assert from 'node:assert/strict';
import {
    claimVerdict, claimDriftMinutes, claimIsDrifted, CLAIM_DRIFT_MINUTES,
    orientationVerdict, orientationUpdate, ORIENTATION_MARGIN,
    candidateWindows, bucketByMinute, candidatesNear, candidateAttempts,
    CANDIDATE_WINDOW_MINUTES, CANDIDATE_WINDOW_MAX_GAP_MINUTES,
} from '../src/db/link-rules.js';

// The real 2026-08-19 case: fixture 1493561 was rescheduled from 2026-07-05
// to 2026-08-06, the bookmakers relisted it, and the stale July listings kept
// the link - so the settle pass wrote the August 1-0 onto a July date.
const JUL = '2026-07-05T00:30:00Z';
const AUG = '2026-08-06T00:30:00Z';

test('claimDriftMinutes handles Date objects, ISO strings and nulls', () => {
    assert.equal(claimDriftMinutes(AUG, AUG), 0);
    assert.equal(claimDriftMinutes(new Date(AUG), AUG), 0);
    assert.equal(claimDriftMinutes('2026-08-06T00:50:00Z', AUG), 20);
    assert.equal(claimDriftMinutes('2026-08-06T00:10:00Z', AUG), 20);  // absolute
    assert.equal(claimDriftMinutes(JUL, AUG), 32 * 24 * 60);
    assert.equal(claimDriftMinutes(null, AUG), null);
    assert.equal(claimDriftMinutes(AUG, undefined), null);
    assert.equal(claimDriftMinutes('not a date', AUG), null);
});

test('an uncontested fixture links', () => {
    assert.equal(claimVerdict({ existing: null, incoming: { id: 2, start_time: AUG }, kickoff: AUG }), 'link');
    assert.equal(claimVerdict({ existing: undefined, incoming: { id: 2, start_time: AUG }, kickoff: AUG }), 'link');
    assert.equal(claimVerdict({ existing: { id: null }, incoming: { id: 2, start_time: AUG }, kickoff: AUG }), 'link');
});

test('the reschedule case: the listing at the new kickoff evicts the stale one', () => {
    const v = claimVerdict({ existing: { id: 639, start_time: JUL }, incoming: { id: 27424, start_time: AUG }, kickoff: AUG });
    assert.equal(v, 'replace');
});

test('the reverse never happens: a stale listing cannot take the link back', () => {
    const v = claimVerdict({ existing: { id: 27424, start_time: AUG }, incoming: { id: 639, start_time: JUL }, kickoff: AUG });
    assert.equal(v, 'skip');
});

test('a tie keeps the incumbent - two equal listings must not churn every pass', () => {
    assert.equal(claimVerdict({ existing: { id: 1, start_time: AUG }, incoming: { id: 2, start_time: AUG }, kickoff: AUG }), 'skip');
});

test('re-linking a match to the fixture it already holds is a no-op link', () => {
    assert.equal(claimVerdict({ existing: { id: 7, start_time: AUG }, incoming: { id: 7, start_time: AUG }, kickoff: AUG }), 'link');
});

test('unparseable clocks never evict - an existing claim survives ambiguity', () => {
    assert.equal(claimVerdict({ existing: { id: 1, start_time: null }, incoming: { id: 2, start_time: AUG }, kickoff: AUG }), 'skip');
    assert.equal(claimVerdict({ existing: { id: 1, start_time: JUL }, incoming: { id: 2, start_time: null }, kickoff: AUG }), 'skip');
    assert.equal(claimVerdict({ existing: { id: 1, start_time: JUL }, incoming: { id: 2, start_time: AUG }, kickoff: null }), 'skip');
});

test('claimVerdict is total over a missing argument object', () => {
    assert.equal(claimVerdict(), 'link');
    assert.equal(claimVerdict({}), 'link');
});

test('claimIsDrifted flags a link the clock contradicts, tolerates window noise', () => {
    assert.equal(claimIsDrifted(JUL, AUG), true);
    assert.equal(claimIsDrifted(AUG, AUG), false);
    assert.equal(claimIsDrifted('2026-08-06T00:55:00Z', AUG), false);  // 25 min: inside the candidate window
    assert.equal(claimIsDrifted('2026-08-06T01:05:00Z', AUG), true);   // 35 min: outside it
    assert.equal(claimIsDrifted(null, AUG), false);                    // unknown is not "drifted"
    assert.equal(CLAIM_DRIFT_MINUTES, 30);
});

// --- orientation (F2) -------------------------------------------------------
// Real cases from the 2026-08-19 sweep over 17,938 links. API-Football keeps
// home_team_id/away_team_id in its fixtures merge list, so it can swap a
// fixture's sides AFTER we linked it; the link stays right but the read layer
// pairs bookmaker names with the canonical score and renders the result
// backwards.

test('a genuine reversal is detected - the real fixture-1548857 case', () => {
    // "FC Annecy v FC Sion" against canonical "FC Sion v Annecy"
    assert.equal(orientationVerdict(0.00, 1.00), 'swapped');
});

test('the weakest real reversal still clears the margin', () => {
    // betika "Nottingham v Guimaraes" vs "Vitoria SC v Nottingham Forest":
    // heavily abbreviated, so even the flipped pairing only reaches 0.45.
    assert.equal(orientationVerdict(0.04, 0.45), 'swapped');
});

test('a correct link reads as straight, not swapped', () => {
    assert.equal(orientationVerdict(1.00, 0.00), 'straight');
    assert.equal(orientationVerdict(0.95, 0.10), 'straight');
});

test('an ambiguous pair is "unknown" and must not be guessed', () => {
    // Both pairings similar: derby-style names, or two clubs sharing a city
    // word. Flapping a display flag on noise is worse than a stale one.
    assert.equal(orientationVerdict(0.50, 0.60), 'unknown');
    assert.equal(orientationVerdict(0.80, 0.80), 'unknown');
    assert.equal(orientationVerdict(0.00, 0.30), 'unknown'); // exactly at the margin
});

test('orientationVerdict is total over non-finite scores', () => {
    for (const [a, b] of [[NaN, 1], [1, NaN], [undefined, 1], [null, null], ['x', 'y'], [Infinity, 0]]) {
        assert.equal(orientationVerdict(a, b), 'unknown');
    }
    assert.equal(ORIENTATION_MARGIN, 0.30);
});

test('orientationUpdate writes only rows that actually moved', () => {
    // The re-validation pass runs over every recent link; rewriting them all
    // would bump matches.updated_at, which the web surfaces as the odds
    // refresh time.
    assert.equal(orientationUpdate('swapped', 0), true);
    assert.equal(orientationUpdate('swapped', false), true);
    assert.equal(orientationUpdate('swapped', 1), null);        // already flagged
    assert.equal(orientationUpdate('swapped', true), null);
    assert.equal(orientationUpdate('straight', 1), false);      // flip corrected upstream
    assert.equal(orientationUpdate('straight', 0), null);
    assert.equal(orientationUpdate('unknown', 0), null);        // never guess
    assert.equal(orientationUpdate('unknown', 1), null);        // including leaving one set
});

// --- Audit F7: batched, bucketed, league-scoped candidate pool ---------------

test('candidateWindows collapses one pass into a few bounded ranges', () => {
    // One evening slate: a single window, padded by the tolerance on both ends.
    const w = candidateWindows(['2026-08-22T18:00:00Z', '2026-08-22T19:30:00Z', '2026-08-22T18:45:00Z']);
    assert.equal(w.length, 1);
    assert.equal(w[0].from.toISOString(), '2026-08-22T17:30:00.000Z');
    assert.equal(w[0].to.toISOString(), '2026-08-22T20:00:00.000Z');
    assert.equal(CANDIDATE_WINDOW_MINUTES, 30);
});

test('candidateWindows splits on a gap wider than maxGapMinutes', () => {
    // The overnight gap between two match days must not be scanned: the shared
    // host punishes long scans, and nothing kicks off inside it.
    const w = candidateWindows(
        ['2026-08-22T18:00:00Z', '2026-08-23T13:00:00Z', '2026-08-23T14:00:00Z'],
        { maxGapMinutes: 180 },
    );
    assert.equal(w.length, 2);
    assert.equal(w[0].from.toISOString(), '2026-08-22T17:30:00.000Z');
    assert.equal(w[0].to.toISOString(), '2026-08-22T18:30:00.000Z');
    assert.equal(w[1].from.toISOString(), '2026-08-23T12:30:00.000Z');
    assert.equal(w[1].to.toISOString(), '2026-08-23T14:30:00.000Z');
    assert.equal(CANDIDATE_WINDOW_MAX_GAP_MINUTES, 180);
});

test('candidateWindows is total over unparseable and empty input', () => {
    assert.deepEqual(candidateWindows([]), []);
    assert.deepEqual(candidateWindows(null), []);
    assert.deepEqual(candidateWindows([null, 'not a date', undefined]), []);
    const w = candidateWindows([null, '2026-08-22T18:00:00Z', 'nope']);
    assert.equal(w.length, 1);
    assert.equal(w[0].from.toISOString(), '2026-08-22T17:30:00.000Z');
});

test('candidateWindows accepts Date objects (what mysql2 hands back)', () => {
    const w = candidateWindows([new Date('2026-08-22T18:00:00Z')]);
    assert.equal(w.length, 1);
    assert.equal(w[0].to.toISOString(), '2026-08-22T18:30:00.000Z');
});

const FX = [
    { id: 1, league_id: 10, kickoff: '2026-08-22T18:00:00Z' },
    { id: 2, league_id: 11, kickoff: '2026-08-22T18:00:30Z' },   // same minute bucket
    { id: 3, league_id: 10, kickoff: '2026-08-22T18:30:00Z' },   // exactly at +30
    { id: 4, league_id: 12, kickoff: '2026-08-22T18:30:01Z' },   // one second past
    { id: 5, league_id: 10, kickoff: '2026-08-22T17:30:00Z' },   // exactly at -30
    { id: 6, league_id: 10, kickoff: '2026-08-22T19:10:00Z' },   // out
    { id: 7, league_id: 10, kickoff: null },                     // unusable
];

test('candidatesNear reproduces the SQL +/-30 minute window exactly', () => {
    const buckets = bucketByMinute(FX);
    const got = candidatesNear(buckets, '2026-08-22T18:00:00Z').map(c => c.id);
    // Bucketing is by minute, so the exact-millisecond filter is what keeps id
    // 4 (18:30:01) out while id 3 (18:30:00) stays in, inclusive like BETWEEN.
    assert.deepEqual(got, [5, 1, 2, 3]);
});

test('candidatesNear returns candidates in ascending kickoff-minute order', () => {
    const buckets = bucketByMinute(FX);
    const got = candidatesNear(buckets, '2026-08-22T18:20:00Z').map(c => c.id);
    assert.deepEqual(got, [1, 2, 3, 4]);
});

test('candidatesNear is total over a missing or unparseable start time', () => {
    const buckets = bucketByMinute(FX);
    assert.deepEqual(candidatesNear(buckets, null), []);
    assert.deepEqual(candidatesNear(buckets, 'whenever'), []);
    assert.deepEqual(candidatesNear(new Map(), '2026-08-22T18:00:00Z'), []);
    assert.deepEqual(candidatesNear(null, '2026-08-22T18:00:00Z'), []);
});

test('bucketByMinute drops rows with no usable kickoff', () => {
    const buckets = bucketByMinute(FX);
    const all = [...buckets.values()].flat().map(c => c.id).sort((a, b) => a - b);
    assert.deepEqual(all, [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(bucketByMinute(null), new Map());
});

test('candidateAttempts scopes to the aliased league first, full pool second', () => {
    const pool = [FX[0], FX[1], FX[2]];      // leagues 10, 11, 10
    const a = candidateAttempts(pool, 10);
    assert.equal(a.length, 2);
    assert.equal(a[0].scope, 'league');
    assert.deepEqual(a[0].rows.map(c => c.id), [1, 3]);
    assert.equal(a[1].scope, 'all');
    assert.deepEqual(a[1].rows.map(c => c.id), [1, 2, 3]);
});

test('candidateAttempts skips the scoped pass when it would change nothing', () => {
    const pool = [FX[0], FX[1]];
    // No league alias: nothing to scope by.
    assert.deepEqual(candidateAttempts(pool, null).map(a => a.scope), ['all']);
    assert.deepEqual(candidateAttempts(pool, undefined).map(a => a.scope), ['all']);
    // The alias resolves to a league no candidate is in: a scoped pass could
    // only waste work, since an empty pool can never produce a link.
    assert.deepEqual(candidateAttempts(pool, 99).map(a => a.scope), ['all']);
    // Every candidate is already in that league: the scoped pool IS the full one.
    assert.deepEqual(candidateAttempts([FX[0], FX[2]], 10).map(a => a.scope), ['all']);
});

test('candidateAttempts is total over an empty pool', () => {
    assert.deepEqual(candidateAttempts([], 10), []);
    assert.deepEqual(candidateAttempts(null, 10), []);
});
