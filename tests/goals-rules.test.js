// Over 2.5 hot-pick deduction rules (src/db/goals-rules.js). Callers filter
// status IN FINAL_STATUSES in SQL; the calc enforces the row-level rules:
// non-null FT scores and kickoff strictly before the fixture's kickoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_THRESHOLDS, impliedProbability, teamGoalsAggregates, pairedTeamGoalsAggregates,
    h2hGoalsAggregates, apiPredictionSignal, scoreOver25,
} from '../src/db/goals-rules.js';

// The fixture under analysis: team 1 hosts team 2
const CUTOFF = new Date('2026-07-02 19:00:00').getTime();

const fx = (home_team_id, away_team_id, ft_home, ft_away, kickoff) =>
    ({ home_team_id, away_team_id, ft_home, ft_away, kickoff });

// Aggregates that pass every default gate (avgTotal 3.4, overRate 0.8)
const goodTeam = { n: 5, gfAvg: 2.0, gaAvg: 1.4, avgTotal: 3.4, overRate: 0.8, bttsRate: 0.8 };
const noH2h = { n: 0, overRate: null, avgTotal: null };
const goodMarket = { impliedOver: 0.6 };

const score = (over = {}) => scoreOver25({
    home: goodTeam, away: goodTeam, h2h: noH2h, market: goodMarket, api: null, ...over,
});

// --- impliedProbability ---

test('impliedProbability strips the vig via two-way normalization', () => {
    // Fair coin priced 1.9/1.9 (5.3% margin) -> exactly 0.5 after devig
    assert.equal(impliedProbability(1.9, 1.9), 0.5);
    // 1.5/2.5 -> (1/1.5)/(1/1.5 + 1/2.5) = 0.625
    assert.equal(impliedProbability(1.5, 2.5), 0.625);
});

test('impliedProbability returns null on missing or degenerate prices', () => {
    assert.equal(impliedProbability(null, 2.0), null);
    assert.equal(impliedProbability(1.8, undefined), null);
    assert.equal(impliedProbability(1.0, 2.0), null); // price <= 1 is not a real book
    assert.equal(impliedProbability('abc', 2.0), null);
});

// --- teamGoalsAggregates ---

test('teamGoalsAggregates computes rates over the last-N vs-others window', () => {
    const rows = [
        fx(1, 3, 2, 1, '2026-06-01 15:00:00'), // 3 goals: over, btts
        fx(4, 1, 0, 4, '2026-05-01 15:00:00'), // 4 goals: over, no btts (team 1 away: GF 4 GA 0)
        fx(1, 5, 1, 1, '2026-04-01 15:00:00'), // 2 goals: under, btts
    ];
    const out = teamGoalsAggregates(rows, 1, 2, CUTOFF, 5);
    assert.equal(out.n, 3);
    assert.equal(out.gfAvg, Math.round((2 + 4 + 1) / 3 * 1000) / 1000);
    assert.equal(out.gaAvg, Math.round((1 + 0 + 1) / 3 * 1000) / 1000);
    assert.equal(out.avgTotal, 3);
    assert.equal(out.overRate, Math.round(2 / 3 * 1000) / 1000);
    assert.equal(out.bttsRate, Math.round(2 / 3 * 1000) / 1000);
});

test('teamGoalsAggregates excludes pair meetings, future and unscored rows', () => {
    const rows = [
        fx(1, 2, 9, 9, '2026-06-01 15:00:00'),       // vs the opponent: excluded
        fx(1, 3, 2, 2, '2026-07-02 19:00:00'),       // at kickoff: excluded
        fx(1, 3, null, null, '2026-05-01 15:00:00'), // unscored: excluded
        fx(1, 3, 3, 1, '2026-04-01 15:00:00'),       // counts (4 goals)
    ];
    const out = teamGoalsAggregates(rows, 1, 2, CUTOFF, 5);
    assert.equal(out.n, 1);
    assert.equal(out.overRate, 1);
});

test('teamGoalsAggregates window keeps only the newest games; empty -> nulls', () => {
    const rows = [
        fx(1, 3, 5, 0, '2026-06-01 15:00:00'), // newest two count
        fx(1, 4, 4, 0, '2026-05-01 15:00:00'),
        fx(1, 5, 0, 0, '2026-04-01 15:00:00'), // outside window 2
    ];
    const out = teamGoalsAggregates(rows, 1, 2, CUTOFF, 2);
    assert.equal(out.n, 2);
    assert.equal(out.overRate, 1); // the 0-0 never entered the window

    const empty = teamGoalsAggregates([], 1, 2, CUTOFF, 5);
    assert.equal(empty.n, 0);
    assert.equal(empty.avgTotal, null);
    assert.equal(empty.overRate, null);
});

// --- h2hGoalsAggregates ---

test('h2hGoalsAggregates covers pair meetings only, windowed, either venue', () => {
    const rows = [
        fx(1, 2, 2, 1, '2026-06-01 15:00:00'), // 3 goals: over
        fx(2, 1, 0, 1, '2026-05-01 15:00:00'), // 1 goal: under
        fx(1, 3, 9, 9, '2026-04-01 15:00:00'), // other pair: excluded
        fx(1, 2, 2, 2, '2026-03-01 15:00:00'), // 4 goals: over
    ];
    const out = h2hGoalsAggregates(rows, 1, 2, CUTOFF, 5);
    assert.equal(out.n, 3);
    assert.equal(out.overRate, Math.round(2 / 3 * 1000) / 1000);
    assert.equal(out.avgTotal, Math.round((3 + 1 + 4) / 3 * 1000) / 1000);

    const empty = h2hGoalsAggregates([], 1, 2, CUTOFF, 5);
    assert.equal(empty.n, 0);
    assert.equal(empty.overRate, null);
});

// --- apiPredictionSignal ---

test('apiPredictionSignal reads the signed under_over line', () => {
    assert.equal(apiPredictionSignal({ under_over: '+2.5' }), 'support');
    assert.equal(apiPredictionSignal({ under_over: '+3.5' }), 'support');
    assert.equal(apiPredictionSignal({ under_over: '+1.5' }), null);      // over 1.5 says little about over 2.5
    assert.equal(apiPredictionSignal({ under_over: '-2.5' }), 'contradict');
    assert.equal(apiPredictionSignal({ under_over: '-1.5' }), 'contradict');
    assert.equal(apiPredictionSignal({ under_over: '-3.5' }), null);      // under 3.5 does not deny over 2.5
});

test('apiPredictionSignal falls back to the advice text, else neutral', () => {
    assert.equal(apiPredictionSignal({ advice: 'Combo Double chance : draw or X and -2.5 goals' }), 'contradict');
    assert.equal(apiPredictionSignal({ advice: 'Combo Winner : Y and +2.5 goals' }), 'support');
    assert.equal(apiPredictionSignal({ advice: 'Winner : Arsenal' }), null);
    assert.equal(apiPredictionSignal({}), null);
    assert.equal(apiPredictionSignal(null), null);
    assert.equal(apiPredictionSignal(undefined), null);
});

// --- scoreOver25 ---

test('scoreOver25 is hot when every gate passes; signals audit each gate', () => {
    const out = score();
    assert.equal(out.hot, true);
    assert.equal(out.api_supports, null);
    assert.ok(out.score > 0 && out.score <= 1);
    assert.ok(Array.isArray(out.signals) && out.signals.length >= 9);
    assert.ok(out.signals.every(s => s.pass));
});

test('scoreOver25 fails each gate independently (strict AND)', () => {
    // Thin sample
    assert.equal(score({ home: { ...goodTeam, n: 4 } }).hot, false);
    assert.equal(score({ away: { ...goodTeam, n: 0, avgTotal: null, overRate: null } }).hot, false);
    // Low scoring profile - either side, either metric
    assert.equal(score({ home: { ...goodTeam, avgTotal: 2.9 } }).hot, false);
    assert.equal(score({ home: { ...goodTeam, overRate: 0.4 } }).hot, false);
    assert.equal(score({ away: { ...goodTeam, avgTotal: 2.5 } }).hot, false);
    assert.equal(score({ away: { ...goodTeam, overRate: 0.5 } }).hot, false);
    // Market disagrees
    assert.equal(score({ market: { impliedOver: 0.45 } }).hot, false);
});

test('scoreOver25 boundary values pass (gates are >=)', () => {
    const edgeTeam = {
        ...goodTeam,
        n: DEFAULT_THRESHOLDS.minGames,
        avgTotal: DEFAULT_THRESHOLDS.minAvgTotal,
        overRate: DEFAULT_THRESHOLDS.minOverRate,
    };
    const out = score({
        home: edgeTeam, away: edgeTeam,
        market: { impliedOver: DEFAULT_THRESHOLDS.minImpliedOver },
    });
    assert.equal(out.hot, true);
});

test('scoreOver25 H2H veto only fires on an established low-scoring rivalry', () => {
    // 3+ meetings mostly under -> veto
    assert.equal(score({ h2h: { n: 3, overRate: 0.333, avgTotal: 1.7 } }).hot, false);
    // Same rate but only 2 meetings -> too thin to veto
    assert.equal(score({ h2h: { n: 2, overRate: 0, avgTotal: 1.0 } }).hot, true);
    // Established and goal-rich -> passes
    assert.equal(score({ h2h: { n: 4, overRate: 0.75, avgTotal: 3.5 } }).hot, true);
});

test('scoreOver25 API prediction: contradict vetoes, support boosts, absent is neutral', () => {
    assert.equal(score({ api: 'contradict' }).hot, false);
    const neutral = score({ api: null });
    const support = score({ api: 'support' });
    assert.equal(support.hot, true);
    assert.equal(support.api_supports, true);
    assert.ok(support.score > neutral.score);
});

test('scoreOver25 missing odds fail unless requireMarket is disabled (backtest)', () => {
    const inputs = { home: goodTeam, away: goodTeam, h2h: noH2h, market: null, api: null };
    assert.equal(scoreOver25(inputs).hot, false);
    assert.equal(scoreOver25(inputs, { requireMarket: false }).hot, true);
});

test('scoreOver25 threshold overrides apply', () => {
    // Tighten the market floor past the given implied probability
    assert.equal(score().hot, true);
    assert.equal(scoreOver25(
        { home: goodTeam, away: goodTeam, h2h: noH2h, market: goodMarket, api: null },
        { minImpliedOver: 0.65 },
    ).hot, false);
});

// --- pairedTeamGoalsAggregates (fairness pairing) ---

test('pairedTeamGoalsAggregates caps both sides at the smaller qualifying count', () => {
    const homeRows = [
        fx(1, 3, 2, 2, '2026-06-01 15:00:00'), // newest: 4 goals (over)
        fx(1, 4, 1, 0, '2026-05-01 15:00:00'), // 1 goal
        fx(5, 1, 0, 3, '2026-04-01 15:00:00'), // 3 goals (over) - drops when capped
    ];
    const awayRows = [
        fx(2, 6, 1, 1, '2026-06-02 15:00:00'), // 2 goals
        fx(7, 2, 2, 2, '2026-05-02 15:00:00'), // 4 goals (over)
    ];
    const { home, away, pool } = pairedTeamGoalsAggregates(homeRows, awayRows, 1, 2, CUTOFF, 5);
    // Raw pools kept for eligibility attribution
    assert.deepEqual(pool, { home_n: 3, away_n: 2 });
    // Both judged over exactly 2 games - home's oldest game is excluded
    assert.equal(home.n, 2);
    assert.equal(away.n, 2);
    assert.equal(home.avgTotal, 2.5); // (4 + 1) / 2, NOT (4 + 1 + 3) / 3
    assert.equal(home.overRate, 0.5); // 1 of the 2 most recent, NOT 2 of 3
    assert.equal(away.avgTotal, 3);
    assert.equal(away.overRate, 0.5);
});

test('pairedTeamGoalsAggregates leaves equal samples untouched', () => {
    const homeRows = [fx(1, 3, 2, 1, '2026-06-01 15:00:00'), fx(1, 4, 0, 0, '2026-05-01 15:00:00')];
    const awayRows = [fx(2, 5, 1, 1, '2026-06-02 15:00:00'), fx(2, 6, 3, 0, '2026-05-02 15:00:00')];
    const { home, away } = pairedTeamGoalsAggregates(homeRows, awayRows, 1, 2, CUTOFF, 5);
    assert.deepEqual(home, teamGoalsAggregates(homeRows, 1, 2, CUTOFF, 5));
    assert.deepEqual(away, teamGoalsAggregates(awayRows, 2, 1, CUTOFF, 5));
});

test('pairedTeamGoalsAggregates zeroes both sides when one has no history', () => {
    const homeRows = [fx(1, 3, 2, 1, '2026-06-01 15:00:00')];
    const { home, away, pool } = pairedTeamGoalsAggregates(homeRows, [], 1, 2, CUTOFF, 5);
    assert.deepEqual(pool, { home_n: 1, away_n: 0 });
    assert.equal(home.n, 0);
    assert.equal(away.n, 0);
    assert.equal(home.avgTotal, null);
});
