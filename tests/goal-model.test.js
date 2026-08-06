// Goal model (src/db/goal-model.js): one fitted intensity per fixture, every
// market read off the same score matrix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, fitGoalModel, predictFixture, marketProbabilities, modelMarkets } from '../src/db/goal-model.js';

const CUT = new Date('2026-07-01T00:00:00Z').getTime();
const day = n => new Date(CUT - n * 86400000).toISOString();

// A synthetic league: team 1 scores freely, team 2 does not.
const HIST = [];
for (let i = 0; i < 60; i++) {
    HIST.push({ home_team_id: 1, away_team_id: 3 + (i % 8), ft_home: 3, ft_away: 0, kickoff: day(i + 1), league_id: 7 });
    HIST.push({ home_team_id: 2, away_team_id: 3 + (i % 8), ft_home: 0, ft_away: 2, kickoff: day(i + 1), league_id: 7 });
    HIST.push({ home_team_id: 3 + (i % 8), away_team_id: 4 + (i % 8), ft_home: 1, ft_away: 1, kickoff: day(i + 1), league_id: 7 });
}

test('every market is a coherent probability read off one score matrix', () => {
    const m = fitGoalModel(HIST, CUT);
    const mk = marketProbabilities(predictFixture(m, 1, 2, 7));
    // partitions sum to 1
    assert.ok(Math.abs(mk['1'] + mk.X + mk['2'] - 1) < 1e-3);
    assert.ok(Math.abs(mk.GG + mk.NG - 1) < 1e-3);
    assert.ok(Math.abs(mk.ODD + mk.EVEN - 1) < 1e-3);
    assert.ok(Math.abs(mk.DNB1 + mk.DNB2 - 1) < 1e-3);
    for (const l of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5]) {
        assert.ok(Math.abs(mk[`O ${l}`] + mk[`U ${l}`] - 1) < 1e-3, `O/U ${l}`);
    }
});

test('the over ladder is MONOTONE - the defect the empirical rates had', () => {
    const m = fitGoalModel(HIST, CUT);
    for (const [h, a] of [[1, 2], [2, 1], [3, 4]]) {
        const mk = marketProbabilities(predictFixture(m, h, a, 7));
        const lines = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];
        for (let i = 0; i < lines.length - 1; i++) {
            assert.ok(mk[`O ${lines[i]}`] >= mk[`O ${lines[i + 1]}`] - 1e-9,
                `O ${lines[i]} >= O ${lines[i + 1]}`);
            assert.ok(mk[`U ${lines[i]}`] <= mk[`U ${lines[i + 1]}`] + 1e-9);
        }
        // and per side
        for (const tag of ['H', 'A']) {
            for (let i = 0; i < lines.length - 1; i++) {
                assert.ok(mk[`TT:${tag}:O ${lines[i]}`] >= mk[`TT:${tag}:O ${lines[i + 1]}`] - 1e-9);
            }
        }
    }
});

test('strength is directional: a scoring side gets a higher intensity', () => {
    const m = fitGoalModel(HIST, CUT);
    const strong = predictFixture(m, 1, 5, 7);   // team 1 scores 3 a game
    const weak = predictFixture(m, 2, 5, 7);     // team 2 scores 0 at home
    assert.ok(strong.lambdaHome > weak.lambdaHome);
    assert.ok(marketProbabilities(strong)['O 2.5'] > marketProbabilities(weak)['O 2.5']);
});

test('the cutoff is enforced HERE, not trusted to the caller', () => {
    // A future blowout must not move the fit at all.
    const leak = [...HIST, { home_team_id: 2, away_team_id: 5, ft_home: 9, ft_away: 0,
        kickoff: new Date(CUT + 86400000).toISOString(), league_id: 7 }];
    const a = predictFixture(fitGoalModel(HIST, CUT), 2, 5, 7);
    const b = predictFixture(fitGoalModel(leak, CUT), 2, 5, 7);
    assert.equal(a.lambdaHome, b.lambdaHome);
    // ...and a match exactly AT the cutoff is excluded too (strict <)
    const edge = [...HIST, { home_team_id: 2, away_team_id: 5, ft_home: 9, ft_away: 0,
        kickoff: new Date(CUT).toISOString(), league_id: 7 }];
    assert.equal(predictFixture(fitGoalModel(edge, CUT), 2, 5, 7).lambdaHome, a.lambdaHome);
});

test('unknown teams and empty history degrade to league/global average', () => {
    const m = fitGoalModel(HIST, CUT);
    const unknown = predictFixture(m, 999999, 999998, 7);
    assert.ok(unknown.lambdaHome > 0 && unknown.lambdaHome < 8);
    assert.equal(unknown.samples.home_n, 0);
    // no history at all: falls back to the long-run constants, never NaN
    const empty = predictFixture(fitGoalModel([], CUT), 1, 2, 7);
    assert.ok(Number.isFinite(empty.lambdaHome) && Number.isFinite(empty.lambdaAway));
    const mk = marketProbabilities(empty);
    for (const v of Object.values(mk)) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1);
});

test('recent matches weigh more than old ones', () => {
    const old = Array.from({ length: 30 }, (_, i) => ({ home_team_id: 1, away_team_id: 3,
        ft_home: 5, ft_away: 0, kickoff: day(300 + i), league_id: 7 }));
    const recent = Array.from({ length: 30 }, (_, i) => ({ home_team_id: 1, away_team_id: 3,
        ft_home: 0, ft_away: 0, kickoff: day(1 + i), league_id: 7 }));
    const m = fitGoalModel([...old, ...recent], CUT, { halfLifeDays: 60 });
    const flat = fitGoalModel([...old, ...recent], CUT, { halfLifeDays: 100000 });
    // the recent goalless run should drag the decayed fit below the flat one
    assert.ok(predictFixture(m, 1, 9, 7).lambdaHome < predictFixture(flat, 1, 9, 7).lambdaHome);
});

test('modelMarkets is the fit -> predict -> markets shorthand', () => {
    const m = fitGoalModel(HIST, CUT);
    assert.deepEqual(modelMarkets(m, 1, 2, 7), marketProbabilities(predictFixture(m, 1, 2, 7)));
    assert.equal(DEFAULT_MODEL.rho, -0.05);
});
