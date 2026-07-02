// Pre-match snapshot calculations (src/db/prematch-calc.js). Callers filter
// status IN RESULT_STATUSES in SQL; the calc enforces the row-level rules:
// non-null FT scores and kickoff strictly before the fixture's kickoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h2hSummary, computePrematch, formatGoals } from '../src/db/prematch-calc.js';

// The fixture under analysis: team 1 hosts team 2
const FIXTURE = { home_team_id: 1, away_team_id: 2, kickoff: '2026-07-02 19:00:00' };

const fx = (home_team_id, away_team_id, ft_home, ft_away, kickoff) =>
    ({ home_team_id, away_team_id, ft_home, ft_away, kickoff });

const compute = (fixturesByTeam, extra = {}) => computePrematch({
    fixture: FIXTURE,
    fixturesByTeam,
    teamWindow: 5,
    h2hWindow: 5,
    ...extra,
});

// --- h2hSummary (moved from records.js _h2hSummary; behavior locked in) ---

test('h2hSummary tallies W/D/L from the home-team perspective across venues', () => {
    const meetings = [
        fx(1, 2, 2, 0, '2026-01-01 15:00:00'), // team 1 home win  -> W
        fx(2, 1, 3, 1, '2026-02-01 15:00:00'), // team 1 away loss -> L
        fx(2, 1, 0, 2, '2026-03-01 15:00:00'), // team 1 away win  -> W
        fx(1, 2, 1, 1, '2026-04-01 15:00:00'), // draw             -> D
    ];
    assert.equal(h2hSummary(meetings, FIXTURE), '2W-1D-1L');
});

test('h2hSummary excludes meetings at or after kickoff and null-score rows', () => {
    const meetings = [
        fx(1, 2, 2, 0, '2026-01-01 15:00:00'),      // counts
        fx(1, 2, 5, 0, '2026-07-02 19:00:00'),      // exactly at kickoff: excluded
        fx(2, 1, 4, 0, '2026-08-01 15:00:00'),      // future: excluded
        fx(1, 2, null, null, '2026-02-01 15:00:00'), // unfinished: excluded
    ];
    assert.equal(h2hSummary(meetings, FIXTURE), '1W-0D-0L');
});

test('h2hSummary ignores fixtures of other team pairs and returns null on none', () => {
    assert.equal(h2hSummary([fx(1, 3, 2, 0, '2026-01-01 15:00:00')], FIXTURE), null);
    assert.equal(h2hSummary([], FIXTURE), null);
});

// --- computePrematch ---

test('computePrematch copies rank/form from standings, nulls when absent', () => {
    const out = compute(new Map(), {
        homeStanding: { rank: 3, form: 'WWDLW' },
        awayStanding: { rank: 11, form: 'LLDWL' },
    });
    assert.equal(out.home_rank, 3);
    assert.equal(out.home_form, 'WWDLW');
    assert.equal(out.away_rank, 11);
    assert.equal(out.away_form, 'LLDWL');

    const bare = compute(new Map());
    assert.equal(bare.home_rank, null);
    assert.equal(bare.away_form, null);
});

test('computePrematch: h2h_count spans all meetings, window caps h2h_n and goals', () => {
    // 7 finished pair meetings; window 5 keeps the latest 5 by kickoff
    const meetings = [
        fx(1, 2, 1, 0, '2026-01-01 15:00:00'), // oldest two fall outside the window
        fx(2, 1, 2, 2, '2026-01-08 15:00:00'),
        fx(1, 2, 2, 1, '2026-02-01 15:00:00'), // windowed: home team GF 2 GA 1
        fx(2, 1, 0, 3, '2026-03-01 15:00:00'), // windowed: home team (away here) GF 3 GA 0
        fx(1, 2, 1, 1, '2026-04-01 15:00:00'), // windowed: 1-1
        fx(2, 1, 2, 0, '2026-05-01 15:00:00'), // windowed: home team GF 0 GA 2
        fx(1, 2, 0, 0, '2026-06-01 15:00:00'), // windowed: 0-0
    ];
    const out = compute(new Map([[1, meetings], [2, meetings]]));
    assert.equal(out.h2h_count, 7);
    assert.equal(out.h2h_n, 5);
    assert.equal(out.h2h_home_goals, 2 + 3 + 1 + 0 + 0); // 6
    assert.equal(out.h2h_away_goals, 1 + 0 + 1 + 2 + 0); // 4
    assert.equal(out.h2h, '3W-3D-1L');
});

test('computePrematch: vs-others excludes the opponent and orients goals per venue', () => {
    const homeHistory = [
        fx(1, 2, 9, 9, '2026-01-01 15:00:00'), // pair meeting: excluded from others
        fx(1, 3, 2, 0, '2026-02-01 15:00:00'), // team 1 home: GF 2 GA 0
        fx(4, 1, 1, 3, '2026-03-01 15:00:00'), // team 1 away: GF 3 GA 1
    ];
    const awayHistory = [
        fx(2, 1, 9, 9, '2026-01-01 15:00:00'), // pair meeting: excluded
        fx(5, 2, 2, 2, '2026-02-15 15:00:00'), // team 2 away: GF 2 GA 2
    ];
    const out = compute(new Map([[1, homeHistory], [2, awayHistory]]));
    assert.equal(out.home_oth_n, 2);
    assert.equal(out.home_oth_gf, 5);
    assert.equal(out.home_oth_ga, 1);
    assert.equal(out.away_oth_n, 1);
    assert.equal(out.away_oth_gf, 2);
    assert.equal(out.away_oth_ga, 2);
    assert.equal(out.h2h_count, 1);
});

test('computePrematch: vs-others window keeps only the most recent teamWindow games', () => {
    const history = [];
    for (let m = 1; m <= 8; m++) {
        // team 1 beats team 3 1-0 monthly; only the last 2 should count
        history.push(fx(1, 3, 1, 0, `2026-0${Math.min(m, 6)}-0${m} 15:00:00`));
    }
    const out = compute(new Map([[1, history]]), { teamWindow: 2 });
    assert.equal(out.home_oth_n, 2);
    assert.equal(out.home_oth_gf, 2);
    assert.equal(out.home_oth_ga, 0);
});

test('computePrematch excludes rows at/after kickoff and rows without scores', () => {
    const history = [
        fx(1, 3, 2, 0, '2026-07-02 19:00:00'),      // at kickoff: excluded
        fx(1, 3, 2, 0, '2026-09-01 15:00:00'),      // future: excluded
        fx(1, 3, null, null, '2026-01-01 15:00:00'), // no score: excluded
        fx(1, 3, 1, 0, '2026-02-01 15:00:00'),      // counts
    ];
    const out = compute(new Map([[1, history]]));
    assert.equal(out.home_oth_n, 1);
    assert.equal(out.home_oth_gf, 1);
});

test('computePrematch with no history yields zero counts and null aggregates', () => {
    const out = compute(new Map());
    assert.equal(out.h2h, null);
    assert.equal(out.h2h_count, 0);
    assert.equal(out.h2h_n, 0);
    assert.equal(out.h2h_home_goals, null);
    assert.equal(out.h2h_away_goals, null);
    assert.equal(out.home_oth_n, 0);
    assert.equal(out.home_oth_gf, null);
    assert.equal(out.away_oth_ga, null);
});

// --- formatGoals ---

test('formatGoals renders "gf/ga (avg total)" with one decimal', () => {
    assert.equal(formatGoals(8, 5, 5), '8/5 (2.6)');
    assert.equal(formatGoals(0, 0, 2), '0/0 (0.0)');
});

test('formatGoals returns null when the window is empty', () => {
    assert.equal(formatGoals(null, null, 0), null);
    assert.equal(formatGoals(null, null, null), null);
});
