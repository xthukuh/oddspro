import test from 'node:test';
import assert from 'node:assert/strict';
import {
    claimVerdict, claimDriftMinutes, claimIsDrifted, CLAIM_DRIFT_MINUTES,
    orientationVerdict, orientationUpdate, ORIENTATION_MARGIN,
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
