// /standings parsing + row-shaping (src/apisports-standings.js): schema
// tolerance for the observed `points: null` payload (playoff/bracket slots
// carrying a real team id but no accumulated points) that aborted the whole
// standings sweep at 33/88, plus the per-row ZodError skip, in-response
// duplicate collapse and team collection. Pure module - no .env / DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StandingRow, buildStandingRows } from '../src/apisports-standings.js';

// A well-formed league-table row
const row = (over = {}) => ({
    rank: 1,
    team: { id: 33, name: 'Manchester United', logo: 'https://x/33.png' },
    points: 45,
    goalsDiff: 21,
    group: 'Premier League',
    form: 'WWDLW',
    description: 'Promotion',
    all: {
        played: 20, win: 14, draw: 3, lose: 3,
        goals: { for: 40, against: 19 },
    },
    ...over,
});

test('StandingRow tolerates points: null (the payload that aborted the sweep)', () => {
    // Regression: this exact shape previously threw "expected number, received null".
    const parsed = StandingRow.parse(row({ points: null, goalsDiff: null }));
    assert.equal(parsed.points, null);
    assert.equal(parsed.goalsDiff, null);
});

test('buildStandingRows coalesces null accumulator stats to 0, keeps the rank', () => {
    const { rows } = buildStandingRows([[row({ points: null, goalsDiff: null, all: null })]], { league_id: 39, season: 2026 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].rank, 1);
    assert.equal(rows[0].points, 0);
    assert.equal(rows[0].goals_diff, 0);
    assert.equal(rows[0].played, 0);
    assert.equal(rows[0].goals_for, 0);
});

test('buildStandingRows maps every column on a full row', () => {
    const { rows, teams } = buildStandingRows([[row()]], { league_id: 39, season: 2026 });
    const r = rows[0];
    assert.deepEqual(r, {
        league_id: 39,
        season: 2026,
        team_id: 33,
        group_name: 'Premier League',
        rank: 1,
        points: 45,
        goals_diff: 21,
        form: 'WWDLW',
        description: 'Promotion',
        played: 20,
        win: 14,
        draw: 3,
        lose: 3,
        goals_for: 40,
        goals_against: 19,
        metadata: JSON.stringify(row()),
    });
    assert.deepEqual(teams, [{ id: 33, name: 'Manchester United', logo: 'https://x/33.png' }]);
});

test('buildStandingRows skips teamless placeholder rows (TBD bracket slots)', () => {
    const { rows } = buildStandingRows([[
        row(),
        { rank: 2, team: { id: null, name: 'TBD' }, points: null, goalsDiff: null },
        { rank: 3 }, // no team object at all
    ]], { league_id: 1, season: 2026 });
    assert.equal(rows.length, 1);
});

test('buildStandingRows skips (not throws) a row zod cannot parse - one bad row must never abort the sweep', () => {
    const { rows, skipped } = buildStandingRows([[
        row(),
        row({ rank: 'first', team: { id: 5, name: 'X' } }), // rank must be numeric
    ]], { league_id: 1, season: 2026 });
    assert.equal(rows.length, 1);
    assert.equal(skipped.length, 1);
});

test('buildStandingRows collapses in-response duplicates on (team, group) like MLS Next Pro', () => {
    const { rows } = buildStandingRows([[row(), row({ points: 50 })]], { league_id: 1, season: 2026 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].points, 50); // last one wins, matching the previous Map behavior
});

test('buildStandingRows spans multiple groups, defaulting group to empty string', () => {
    const { rows } = buildStandingRows([
        [row({ group: 'Group A' })],
        [row({ team: { id: 34, name: 'Newcastle' }, group: null })],
    ], { league_id: 1, season: 2026 });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].group_name, '');
});
