// Best-tip deduction rules (src/db/tip-rules.js). Callers filter status IN
// FINAL_STATUSES in SQL; the aggregates enforce non-null FT scores and
// kickoff strictly before the fixture's kickoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TIP, teamOutcomeAggregates, pairedTeamOutcomeAggregates,
    h2hOutcomeAggregates, tipEligibility, tipHit, bestTip,
} from '../src/db/tip-rules.js';

// The fixture under analysis: team 1 hosts team 2
const CUTOFF = new Date('2026-07-02 19:00:00').getTime();

const fx = (home_team_id, away_team_id, ft_home, ft_away, kickoff) =>
    ({ home_team_id, away_team_id, ft_home, ft_away, kickoff });

// Empty-evidence defaults: candidates score on market probability alone
const noTeam = { n: 0, winRate: null, drawRate: null, lossRate: null, overRates: null };
const noH2h = { n: 0, homeWinRate: null, drawRate: null, awayWinRate: null, overRates: null };
const marketOnly = { home: noTeam, away: noTeam, h2h: noH2h, apiPercents: null };

// --- teamOutcomeAggregates ---

test('teamOutcomeAggregates computes W/D/L and per-line over rates', () => {
    const rows = [
        fx(1, 3, 2, 1, '2026-06-01 15:00:00'), // win, 3 goals
        fx(4, 1, 0, 0, '2026-05-01 15:00:00'), // draw (away), 0 goals
        fx(1, 5, 1, 3, '2026-04-01 15:00:00'), // loss, 4 goals
        fx(1, 2, 9, 9, '2026-03-01 15:00:00'), // vs the opponent: excluded
    ];
    const out = teamOutcomeAggregates(rows, 1, 2, CUTOFF, 5);
    assert.equal(out.n, 3);
    assert.equal(out.winRate, Math.round(1 / 3 * 10000) / 10000);
    assert.equal(out.drawRate, Math.round(1 / 3 * 10000) / 10000);
    assert.equal(out.lossRate, Math.round(1 / 3 * 10000) / 10000);
    assert.equal(out.overRates[0.5], Math.round(2 / 3 * 10000) / 10000); // 3 and 4 goal games
    assert.equal(out.overRates[2.5], Math.round(2 / 3 * 10000) / 10000);
    assert.equal(out.overRates[3.5], Math.round(1 / 3 * 10000) / 10000); // only the 4-goal game
    assert.equal(out.overRates[6.5], 0);
});

test('teamOutcomeAggregates respects the cutoff, window and empty history', () => {
    const rows = [
        fx(1, 3, 2, 0, '2026-07-02 19:00:00'), // at kickoff: excluded
        fx(1, 3, 5, 0, '2026-06-01 15:00:00'), // newest counted
        fx(1, 4, 0, 1, '2026-05-01 15:00:00'), // outside window 1
    ];
    const out = teamOutcomeAggregates(rows, 1, 2, CUTOFF, 1);
    assert.equal(out.n, 1);
    assert.equal(out.winRate, 1);

    const empty = teamOutcomeAggregates([], 1, 2, CUTOFF, 5);
    assert.equal(empty.n, 0);
    assert.equal(empty.winRate, null);
    assert.equal(empty.overRates, null);
});

// --- pairedTeamOutcomeAggregates (fairness pairing) ---

test('pairedTeamOutcomeAggregates judges both teams over the min-capped window', () => {
    const homeRows = [
        fx(1, 3, 2, 0, '2026-06-01 15:00:00'), // newest: win
        fx(1, 4, 0, 0, '2026-05-01 15:00:00'), // draw - drops when capped
        fx(1, 5, 0, 1, '2026-04-01 15:00:00'), // loss - drops when capped
    ];
    const awayRows = [fx(2, 6, 3, 1, '2026-06-02 15:00:00')]; // win
    const { home, away } = pairedTeamOutcomeAggregates(homeRows, awayRows, 1, 2, CUTOFF, 5);
    assert.equal(home.n, 1);
    assert.equal(away.n, 1);
    assert.equal(home.winRate, 1); // only the most recent game counts
    assert.equal(away.winRate, 1);
    // Equal samples pass through identical to the direct computation
    const even = pairedTeamOutcomeAggregates(homeRows, homeRows.map(f => fx(2, 9, f.ft_home, f.ft_away, f.kickoff)), 1, 2, CUTOFF, 5);
    assert.deepEqual(even.home, teamOutcomeAggregates(homeRows, 1, 2, CUTOFF, 5));
    assert.equal(even.home.n, even.away.n);
});

// --- h2hOutcomeAggregates ---

test('h2hOutcomeAggregates orients rates to the analyzed home team across venues', () => {
    const rows = [
        fx(1, 2, 2, 0, '2026-06-01 15:00:00'), // team 1 home win
        fx(2, 1, 0, 1, '2026-05-01 15:00:00'), // team 1 away win
        fx(1, 2, 1, 1, '2026-04-01 15:00:00'), // draw
        fx(2, 1, 3, 0, '2026-03-01 15:00:00'), // team 1 away loss
        fx(1, 3, 9, 9, '2026-02-01 15:00:00'), // other pair: excluded
    ];
    const out = h2hOutcomeAggregates(rows, 1, 2, CUTOFF, 5);
    assert.equal(out.n, 4);
    assert.equal(out.homeWinRate, 0.5);
    assert.equal(out.drawRate, 0.25);
    assert.equal(out.awayWinRate, 0.25);
});

// --- tipHit ---

test('tipHit settles every canonical market from the final score', () => {
    assert.equal(tipHit('1', 2, 1), true);
    assert.equal(tipHit('1', 1, 1), false);
    assert.equal(tipHit('X', 1, 1), true);
    assert.equal(tipHit('2', 0, 3), true);
    assert.equal(tipHit('1X', 1, 1), true);
    assert.equal(tipHit('1X', 0, 1), false);
    assert.equal(tipHit('X2', 0, 1), true);
    assert.equal(tipHit('12', 2, 1), true);
    assert.equal(tipHit('12', 1, 1), false);
    assert.equal(tipHit('O 2.5', 2, 1), true);
    assert.equal(tipHit('O 2.5', 1, 1), false);
    assert.equal(tipHit('U 3.5', 2, 1), true);
    assert.equal(tipHit('U 0.5', 0, 0), true);
    assert.throws(() => tipHit('BTTS', 1, 1), TypeError);
});

// --- bestTip ---

test('bestTip devigs the 1X2 book and picks the highest-confidence outcome', () => {
    // Heavy home favorite: 1.25 / 6.0 / 9.0 -> devig p1 ~ 0.775
    const out = bestTip({ ...marketOnly, x12: { 1: 1.25, X: 6.0, 2: 9.0 }, dc: null, ou: {} });
    assert.equal(out.market, '1');
    assert.equal(out.price, 1.25);
    assert.ok(out.market_prob > 0.7 && out.market_prob < 0.85);
    assert.equal(out.confidence, out.market_prob); // market-only blend
    assert.equal(out.stats_prob, null);
});

test('bestTip enforces the price floor - near-certain junk odds are excluded', () => {
    // O 0.5 at 1.05 implies ~95% but pays nothing; U 0.5 at 12 is the pair
    const out = bestTip({
        ...marketOnly,
        x12: { 1: 2.4, X: 3.4, 2: 2.9 }, dc: null,
        ou: { 0.5: { over: 1.05, under: 12.0 }, 2.5: { over: 1.55, under: 2.45 } },
    });
    assert.notEqual(out.market, 'O 0.5');
    // With a floor at 1.0 the junk market would win instead
    const noFloor = bestTip({
        ...marketOnly,
        x12: null, dc: null, ou: { 0.5: { over: 1.05, under: 12.0 } },
    }, { minPrice: 1.01 });
    assert.equal(noFloor.market, 'O 0.5');
});

test('bestTip derives double-chance probability from the 1X2 book with the DC price', () => {
    // p1+pX ~ 0.885 devigged; DC price 1.3 clears the floor
    const out = bestTip({
        ...marketOnly,
        x12: { 1: 1.55, X: 4.2, 2: 6.5 },
        dc: { '1X': 1.3, X2: 2.4, 12: 1.25 },
        ou: {},
    });
    assert.equal(out.market, '1X');
    assert.equal(out.price, 1.3);
    assert.ok(out.market_prob > 0.85);
});

test('bestTip stats corroboration moves confidence in both directions', () => {
    const strongHome = {
        n: 7, winRate: 0.857, drawRate: 0.143, lossRate: 0, overRates: null,
    };
    const weakAway = {
        n: 7, winRate: 0, drawRate: 0.143, lossRate: 0.857, overRates: null,
    };
    const inputs = { x12: { 1: 1.5, X: 4.0, 2: 7.0 }, dc: null, ou: {}, h2h: noH2h, apiPercents: null };
    const corroborated = bestTip({ ...inputs, home: strongHome, away: weakAway });
    const marketOnlyOut = bestTip({ ...inputs, home: noTeam, away: noTeam });
    assert.equal(corroborated.market, '1');
    // stats say ~0.857 while the market says ~0.64 - blend must land between
    assert.ok(corroborated.confidence > marketOnlyOut.confidence);
    assert.ok(corroborated.stats_prob > 0.8);
    // Contradicting stats (weak home) drag confidence below market-only
    const contradicted = bestTip({ ...inputs, home: weakAway, away: strongHome });
    if (contradicted?.market === '1') {
        assert.ok(contradicted.confidence < marketOnlyOut.confidence);
    }
});

test('bestTip thin samples contribute nothing (market-only confidence)', () => {
    const thin = { n: 3, winRate: 1, drawRate: 0, lossRate: 0, overRates: null };
    const out = bestTip({
        x12: { 1: 1.5, X: 4.0, 2: 7.0 }, dc: null, ou: {},
        home: thin, away: thin, h2h: noH2h, apiPercents: null,
    });
    assert.equal(out.stats_prob, null);
    assert.equal(out.confidence, out.market_prob);
});

test('bestTip O/U uses over-rate support and its complement for unders', () => {
    const overish = {
        n: 7, winRate: null, drawRate: null, lossRate: null,
        overRates: { 0.5: 1, 1.5: 0.857, 2.5: 0.714, 3.5: 0.429, 4.5: 0.286, 5.5: 0, 6.5: 0 },
    };
    const out = bestTip({
        x12: null, dc: null,
        ou: { 2.5: { over: 1.6, under: 2.3 } },
        home: overish, away: overish, h2h: noH2h, apiPercents: null,
    });
    assert.equal(out.market, 'O 2.5');
    assert.equal(out.stats_prob, 0.714);
    const underish = { ...overish, overRates: { ...overish.overRates, 2.5: 0.143 } };
    const under = bestTip({
        x12: null, dc: null,
        ou: { 2.5: { over: 2.6, under: 1.5 } },
        home: underish, away: underish, h2h: noH2h, apiPercents: null,
    });
    assert.equal(under.market, 'U 2.5');
    assert.equal(under.stats_prob, Math.round((1 - 0.143) * 10000) / 10000);
});

test('bestTip blends API percentages into result markets only', () => {
    const inputs = {
        x12: { 1: 1.5, X: 4.0, 2: 7.0 }, dc: null, ou: {},
        home: noTeam, away: noTeam, h2h: noH2h,
    };
    const withApi = bestTip({ ...inputs, apiPercents: { home: 0.9, draw: 0.05, away: 0.05 } });
    const without = bestTip({ ...inputs, apiPercents: null });
    assert.equal(withApi.market, '1');
    assert.equal(withApi.api_prob, 0.9);
    assert.ok(withApi.confidence > without.confidence);
});

test('bestTip returns null below the confidence floor or with no priced markets', () => {
    // Coin-flip book: nothing reaches 0.5 after devig across three outcomes
    const coin = bestTip({ ...marketOnly, x12: { 1: 2.9, X: 3.1, 2: 2.9 }, dc: null, ou: {} });
    assert.equal(coin, null);
    assert.equal(bestTip({ ...marketOnly, x12: null, dc: null, ou: {} }), null);
    // Lowering the floor surfaces the best coin-flip candidate
    const lenient = bestTip({ ...marketOnly, x12: { 1: 2.9, X: 3.1, 2: 2.9 }, dc: null, ou: {} }, { minConfidence: 0.2 });
    assert.ok(lenient && lenient.confidence < 0.5);
});

test('bestTip defaults are sane', () => {
    assert.ok(DEFAULT_TIP.minPrice > 1);
    assert.ok(DEFAULT_TIP.minConfidence >= 0.5);
    const sum = DEFAULT_TIP.weights.market + DEFAULT_TIP.weights.stats + DEFAULT_TIP.weights.api;
    assert.ok(Math.abs(sum - 1) < 1e-9);
});

// --- bestTip justification breakdown (persisted as tip_breakdown) ---

test('bestTip carries evidence samples and renormalized weights', () => {
    const seven = { n: 7, winRate: 0.857, drawRate: 0.143, lossRate: 0, overRates: null };
    const out = bestTip({
        x12: { 1: 1.5, X: 4.0, 2: 7.0 }, dc: null, ou: {},
        home: seven, away: { ...seven, winRate: 0, lossRate: 0.857 },
        h2h: { ...noH2h, n: 2 }, apiPercents: null,
    });
    assert.deepEqual(out.samples, { home_n: 7, away_n: 7, h2h_n: 2 });
    // market 0.6 + stats 0.3 available -> renormalized to 2/3 and 1/3
    assert.equal(out.weights.market, Math.round(0.6 / 0.9 * 10000) / 10000);
    assert.equal(out.weights.stats, Math.round(0.3 / 0.9 * 10000) / 10000);
    assert.equal(out.weights.api, null);
    // Market-only blend: full weight on the market component
    const solo = bestTip({ ...marketOnly, x12: { 1: 1.25, X: 6.0, 2: 9.0 }, dc: null, ou: {} });
    assert.equal(solo.weights.market, 1);
    assert.equal(solo.weights.stats, null);
});

test('bestTip lists up to two runners-up in confidence order, excluding the pick', () => {
    const out = bestTip({
        ...marketOnly,
        x12: { 1: 1.25, X: 6.0, 2: 9.0 },
        dc: { '1X': 1.22, X2: 2.4, 12: 1.3 },
        ou: {},
    });
    assert.ok(Array.isArray(out.runners_up));
    assert.ok(out.runners_up.length <= 2);
    assert.ok(out.runners_up.every(r => r.market !== out.market));
    for (let i = 1; i < out.runners_up.length; i++) {
        assert.ok(out.runners_up[i - 1].confidence >= out.runners_up[i].confidence);
    }
    assert.ok(out.confidence >= (out.runners_up[0]?.confidence ?? 0));
});

// --- tipEligibility (evidence screen run BEFORE bestTip) ---
// Contract: a fixture is only tippable when BOTH teams carry a qualifying
// sample of at least minGames AND at least one full market group exists.
// The reason marker is what the web UI surfaces (<= 64 chars).

const games = n => ({ n });
const fullBook = { x12: { 1: 1.5, X: 4.0, 2: 7.0 }, dc: null, ou: {} };

test('tipEligibility rejects thin home history with a detailed reason', () => {
    const out = tipEligibility({ ...fullBook, home: games(2), away: games(7) });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /^insufficient_history/);
    assert.match(out.reason, /home/);
    assert.ok(out.reason.length <= 64);
});

test('tipEligibility rejects thin away history with a detailed reason', () => {
    const out = tipEligibility({ ...fullBook, home: games(7), away: games(4) });
    assert.equal(out.eligible, false);
    assert.match(out.reason, /^insufficient_history/);
    assert.match(out.reason, /away/);
});

test('tipEligibility rejects fixtures with no market group at all', () => {
    const out = tipEligibility({ x12: null, dc: null, ou: {}, home: games(7), away: games(7) });
    assert.equal(out.eligible, false);
    assert.equal(out.reason, 'no_markets');
});

test('tipEligibility passes a well-evidenced fixture (any single group suffices)', () => {
    assert.deepEqual(
        tipEligibility({ ...fullBook, home: games(5), away: games(5) }),
        { eligible: true, reason: null },
    );
    assert.equal(
        tipEligibility({
            x12: null, dc: null, ou: { 2.5: { over: 1.6, under: 2.3 } },
            home: games(7), away: games(7),
        }).eligible,
        true,
    );
});

test('tipEligibility honors a minGames override', () => {
    const inputs = { ...fullBook, home: games(3), away: games(3) };
    assert.equal(tipEligibility(inputs).eligible, false);
    assert.equal(tipEligibility(inputs, { minGames: 3 }).eligible, true);
});
