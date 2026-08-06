// Best-tip deduction rules (src/db/tip-rules.js). Callers filter status IN
// FINAL_STATUSES in SQL; the aggregates enforce non-null FT scores and
// kickoff strictly before the fixture's kickoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TIP, teamOutcomeAggregates, pairedTeamOutcomeAggregates,
    h2hOutcomeAggregates, tipEligibility, tipHit, tipOutcome, tipHitSafe, bestTip,
    bookIntegrity, selectFamilyBook, buildTipBooks,
} from '../src/db/tip-rules.js';

// The fixture under analysis: team 1 hosts team 2
const CUTOFF = new Date('2026-07-02 19:00:00').getTime();

const fx = (home_team_id, away_team_id, ft_home, ft_away, kickoff) =>
    ({ home_team_id, away_team_id, ft_home, ft_away, kickoff });

// Empty-evidence defaults: candidates score on market probability alone
const noTeam = { n: 0, winRate: null, drawRate: null, lossRate: null, overRates: null };
const noH2h = { n: 0, homeWinRate: null, drawRate: null, awayWinRate: null, overRates: null };
const marketOnly = { home: noTeam, away: noTeam, h2h: noH2h, apiPercents: null };

// Builds a flat { 0.5: r, ..., 6.5: r } overRates-shaped object (also used
// for scoredOverRates/concededOverRates, which share the OU_LINES key set).
const O = r => ({ 0.5: r, 1.5: r, 2.5: r, 3.5: r, 4.5: r, 5.5: r, 6.5: r });

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

const HIST = [
    // team 10 home: scored 3, conceded 1 (btts, odd total, over 2.5)
    { home_team_id: 10, away_team_id: 30, ft_home: 3, ft_away: 1, kickoff: '2026-07-01T12:00:00Z' },
    // team 10 away: scored 0, conceded 2 (no btts, even total)
    { home_team_id: 40, away_team_id: 10, ft_home: 2, ft_away: 0, kickoff: '2026-07-03T12:00:00Z' },
];
test('teamOutcomeAggregates: btts/parity/per-side goal rates', () => {
    const a = teamOutcomeAggregates(HIST, 10, 99, Date.parse('2026-07-10'), 5);
    assert.equal(a.n, 2);
    assert.equal(a.bttsRate, 0.5);                // 3-1 both scored; 2-0 not
    assert.equal(a.oddRate, 0);                   // totals 4 and 2 - both even
    assert.equal(a.scoredOverRates[0.5], 0.5);    // scored 3 (home) and 0 (away)
    assert.equal(a.scoredOverRates[2.5], 0.5);
    assert.equal(a.concededOverRates[1.5], 0.5);  // conceded 1 and 2
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

test('h2hOutcomeAggregates gains bttsRate/oddRate', () => {
    const h = h2hOutcomeAggregates([
        { home_team_id: 10, away_team_id: 20, ft_home: 2, ft_away: 1, kickoff: '2026-07-01T12:00:00Z' },
    ], 10, 20, Date.parse('2026-07-10'), 5);
    assert.equal(h.bttsRate, 1);
    assert.equal(h.oddRate, 1); // total 3
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

test('tipOutcome settles the new families', () => {
    assert.equal(tipOutcome('GG', 2, 1), 'hit');
    assert.equal(tipOutcome('GG', 2, 0), 'miss');
    assert.equal(tipOutcome('NG', 0, 0), 'hit');
    assert.equal(tipOutcome('DNB1', 2, 1), 'hit');
    assert.equal(tipOutcome('DNB1', 1, 1), 'void');   // draw = push
    assert.equal(tipOutcome('DNB2', 1, 1), 'void');
    assert.equal(tipOutcome('DNB2', 0, 1), 'hit');
    assert.equal(tipOutcome('ODD', 2, 1), 'hit');
    assert.equal(tipOutcome('EVEN', 2, 1), 'miss');
    assert.equal(tipOutcome('TT:H:O 1.5', 2, 0), 'hit');
    assert.equal(tipOutcome('TT:H:O 1.5', 1, 3), 'miss');
    assert.equal(tipOutcome('TT:A:U 2.5', 1, 3), 'miss');
    assert.equal(tipOutcome('TT:A:U 2.5', 3, 1), 'hit');
    // symmetric counterparts: home Under, away Over
    assert.equal(tipOutcome('TT:H:U 1.5', 1, 3), 'hit');
    assert.equal(tipOutcome('TT:A:O 2.5', 0, 3), 'hit');
});

test('tipOutcome matches legacy tipHit on canonical markets', () => {
    for (const [m, fh, fa] of [['1', 2, 1], ['X', 1, 1], ['X2', 0, 1], ['O 2.5', 2, 1], ['U 4.5', 2, 1]]) {
        assert.equal(tipOutcome(m, fh, fa) === 'hit', tipHit(m, fh, fa));
    }
});

test('unknown market: tipOutcome throws, tipHitSafe returns null', () => {
    assert.throws(() => tipOutcome('CS:2-1', 2, 1), TypeError);
    assert.equal(tipHitSafe('CS:2-1', 2, 1), null);
    assert.equal(tipHitSafe('DNB1', 1, 1), 'void');
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
    // Beta-shrink (DEFAULT_TIP.statsShrinkK) pulls a 7-game 0.857 toward 0.5,
    // so assert the RELATION the test is about, not a pre-shrink constant.
    assert.ok(corroborated.stats_prob > 0.7);
    assert.equal(bestTip({ ...inputs, home: strongHome, away: weakAway }, { statsShrinkK: 0 }).stats_prob, 0.857);
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
    // raw mean is 0.714; shrunk toward 0.5 by a 7-game sample with k=5
    assert.equal(bestTip({
        x12: null, dc: null,
        ou: { 2.5: { over: 1.6, under: 2.3 } },
        home: overish, away: overish, h2h: noH2h, apiPercents: null,
    }, { statsShrinkK: 0 }).stats_prob, 0.714);
    assert.ok(out.stats_prob > 0.5 && out.stats_prob < 0.714);
    const underish = { ...overish, overRates: { ...overish.overRates, 2.5: 0.143 } };
    // U 2.5 sits below the default minUnderLine floor - override to exercise
    // the complement math the floor otherwise suppresses
    const under = bestTip({
        x12: null, dc: null,
        ou: { 2.5: { over: 2.6, under: 1.5 } },
        home: underish, away: underish, h2h: noH2h, apiPercents: null,
    }, { minUnderLine: 2.5 });
    assert.equal(under.market, 'U 2.5');
    // The Under support is the COMPLEMENT of the (shrunk) over rate, so the
    // identity to assert is over + under === 1 - not a pre-shrink constant.
    const over2 = bestTip({
        x12: null, dc: null,
        ou: { 2.5: { over: 1.6, under: 2.3 } },
        home: underish, away: underish, h2h: noH2h, apiPercents: null,
    }, { minConfidence: 0 });
    assert.ok(Math.abs(under.stats_prob + over2.stats_prob - 1) < 1e-4);
    // and without shrink it is exactly the old number
    const rawUnder = bestTip({
        x12: null, dc: null,
        ou: { 2.5: { over: 2.6, under: 1.5 } },
        home: underish, away: underish, h2h: noH2h, apiPercents: null,
    }, { minUnderLine: 2.5, statsShrinkK: 0 });
    assert.equal(rawUnder.stats_prob, Math.round((1 - 0.143) * 10000) / 10000);
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

// --- tipEligibility context gate (friendly / youth / reserve leagues) ---
// Rolling form windows say nothing about preseason exhibitions or youth
// sides - the 2026-07-05 failure analysis located -14.12u of the -15.60u
// settled tip loss in these leagues.

test('tipEligibility rejects friendly and youth/reserve leagues outright', () => {
    const excluded = [
        'Friendlies Clubs', 'Friendlies', 'Friendlies Women',
        'Brasileiro U20 A', 'UEFA U19 Championship - Women', 'Npl Nsw U20',
        'Youth Championship', 'Reserve League', 'Estadual Junior U20',
    ];
    for (const league of excluded) {
        const out = tipEligibility({ ...fullBook, home: games(7), away: games(7), league });
        assert.equal(out.eligible, false, league);
        assert.match(out.reason, /^context/, league);
        assert.ok(out.reason.length <= 64);
    }
});

test('tipEligibility context gate runs before the history screen', () => {
    // Thin history AND excluded context: the context reason wins
    const out = tipEligibility({ ...fullBook, home: games(0), away: games(0), league: 'Friendlies Clubs' });
    assert.match(out.reason, /^context/);
});

test('tipEligibility context gate has no false positives on real league names', () => {
    const kept = [
        'USL League Two', 'K League 1', 'China League One', 'Ligue 1',
        'Serie D', 'Primera B Metropolitana', 'Western Australia State League 1',
        'Super Liga', 'Segunda División', '1. Liga',
    ];
    for (const league of kept) {
        assert.equal(
            tipEligibility({ ...fullBook, home: games(7), away: games(7), league }).eligible,
            true, league,
        );
    }
});

test('tipEligibility without a league behaves exactly as before', () => {
    assert.deepEqual(
        tipEligibility({ ...fullBook, home: games(5), away: games(5), league: null }),
        { eligible: true, reason: null },
    );
    assert.deepEqual(
        tipEligibility({ ...fullBook, home: games(5), away: games(5) }),
        { eligible: true, reason: null },
    );
});

// --- bestTip Under line floor ---
// Near-Unders (U 2.5/U 3.5) bet against goals with no demonstrated edge:
// 61.9% realized vs 78.1% break-even over the 2026-07-04 settled cohort.

test('bestTip suppresses Under tips below the minUnderLine floor', () => {
    const strongUnder35 = { 3.5: { over: 3.4, under: 1.3 } };
    // Only a near-Under would qualify -> no tip at all under the default floor
    assert.equal(bestTip({ ...marketOnly, x12: null, dc: null, ou: strongUnder35 }), null);
    // Overriding the floor restores the candidate. suppressedMarkets is cleared
    // too: U 3.5 is ALSO barred by the 2026-07-26 market suppression list, and
    // this test is about the minUnderLine mechanism specifically.
    const lenient = bestTip({ ...marketOnly, x12: null, dc: null, ou: strongUnder35 },
        { minUnderLine: 3.5 });
    assert.equal(lenient.market, 'U 3.5');
    // U 4.5 and above still allowed by default; Overs never affected
    const tail = bestTip({ ...marketOnly, x12: null, dc: null, ou: { 4.5: { over: 4.2, under: 1.25 } } });
    assert.equal(tail.market, 'U 4.5');
    const over = bestTip({ ...marketOnly, x12: null, dc: null, ou: { 2.5: { over: 1.55, under: 2.45 } } });
    assert.equal(over.market, 'O 2.5');
});

test('bestTip yields to the runner-up market when the near-Under is suppressed', () => {
    // U 3.5 tops the sort at ~0.754; with it suppressed, 12 (~0.721) wins
    const inputs = {
        ...marketOnly,
        x12: { 1: 2.4, X: 3.4, 2: 2.9 },
        dc: { '1X': 1.35, X2: 1.5, 12: 1.28 },
        ou: { 3.5: { over: 3.8, under: 1.24 } },
    };
    assert.equal(bestTip(inputs, { minUnderLine: 3.5 }).market, 'U 3.5');
    assert.equal(bestTip(inputs).market, '12');
    // The suppression gate is shipped EMPTY (see DEFAULT_TIP.suppressedMarkets),
    // but when configured it yields as deep as needed - here past both U 3.5
    // and 12 to 1X.
    assert.equal(bestTip(inputs, { suppressedMarkets: ['12', 'U 3.5'] }).market, '1X');
});

// --- suppressed markets (2026-07-26 study) ---
// 12 and U 3.5 are the only markets whose flat-stake ROI has a day-clustered
// 95% CI entirely below zero (-8.8% and -8.7% over 220/164 settled tips).

test('a suppressed market never surfaces as tip OR runner-up', () => {
    const inputs = {
        ...marketOnly,
        x12: { 1: 2.4, X: 3.4, 2: 2.9 },
        dc: { '1X': 1.35, X2: 1.5, 12: 1.28 },
        ou: { 3.5: { over: 3.8, under: 1.24 }, 4.5: { over: 6.0, under: 1.14 } },
    };
    const tip = bestTip(inputs, { suppressedMarkets: ['12', 'U 3.5'] });
    assert.ok(!['12', 'U 3.5'].includes(tip.market));
    for (const ru of tip.runners_up) assert.ok(!['12', 'U 3.5'].includes(ru.market));
});

test('the suppression gate ships DISABLED and is opt-in', () => {
    // Guards the 2026-07-26 decision: the mechanism exists, the evidence for
    // using it does not replicate, so the default must stay empty.
    assert.deepEqual(DEFAULT_TIP.suppressedMarkets, []);
    assert.equal(DEFAULT_TIP.statsVetoGap, null);
    const inputs = { ...marketOnly, x12: null, dc: { '1X': 3.0, X2: 3.0, 12: 1.28 }, ou: {} };
    assert.equal(bestTip(inputs).market, '12');
    assert.equal(bestTip(inputs, { suppressedMarkets: ['12'] }), null);
});

// --- stats veto ---

test('bestTip flags (but does not drop) a tip whose stats sit below the market', () => {
    // 1X2 only, so the winner is forced to be '1' (market ~0.742). Both sides
    // are poor, giving statsProb['1'] = mean(home.winRate .1, away.lossRate .8)
    // = 0.45 - a gap of about -0.29, comfortably past the threshold.
    const weak = { n: 6, winRate: 0.1, drawRate: 0.1, lossRate: 0.8, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.5), concededOverRates: O(0.5) };
    const input = {
        x12: { 1: 1.25, X: 6.0, 2: 9.0 }, dc: null,
        ou: {}, home: weak, away: weak, h2h: { n: 0 }, apiPercents: null,
    };
    const tip = bestTip(input, { minConfidence: 0, statsVetoGap: -0.08 });
    assert.equal(tip.market, '1');
    assert.equal(tip.veto, 'stats_below_market');
    assert.ok(tip.stats_gap < -0.08);
    // Reporting, not enforcing: the tip is still returned in full so the caller
    // decides (hotpicks drops it and records the reason), and the breakdown
    // stays inspectable instead of collapsing to a bare null.
    assert.ok(tip.price);
    assert.ok(tip.runners_up);
    // Disabling the rule removes only the flag
    const off = bestTip(input, { minConfidence: 0, statsVetoGap: null });
    assert.equal(off.veto, undefined);
    assert.equal(off.market, tip.market);
    assert.equal(off.stats_gap, tip.stats_gap);
    // A comfortably-agreeing tip is never flagged
    const strong = { ...weak, winRate: 0.8, lossRate: 0.1 };
    const ok = bestTip({ ...input, home: strong, away: weak }, { minConfidence: 0, statsVetoGap: -0.08 });
    assert.equal(ok.veto, undefined);
});

test('stats_gap is null when the tip carries no stats component', () => {
    const tip = bestTip({ ...marketOnly, x12: { 1: 1.25, X: 6.0, 2: 9.0 }, dc: null, ou: {} },
        { statsVetoGap: -0.08 });
    assert.equal(tip.stats_gap, null);
    assert.equal(tip.veto, undefined);
});

// --- bestTip new-family candidates (M3) ---

test('bestTip considers BTTS and can pick GG', () => {
    const agg = { n: 6, winRate: 0.5, drawRate: 0.2, lossRate: 0.3, overRates: O(0.8), bttsRate: 0.9, oddRate: 0.5, scoredOverRates: O(0.8), concededOverRates: O(0.7) };
    const tip = bestTip({ btts: { GG: 1.55, NG: 2.3 }, home: agg, away: agg, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0.5 });
    assert.equal(tip.market, 'GG');
    assert.ok(tip.stats_prob > 0.7);   // 0.9 raw, shrunk by a 6-game sample
});

test('bestTip DNB stats renormalize over non-draw outcomes', () => {
    // statsProb['1'] blends home.winRate/away.lossRate/h2h -> with symmetric
    // aggregates below, statsProb 1 = .6, 2 = .2 -> DNB1 stats = .6/.8 = .75
    const home = { n: 6, winRate: 0.6, drawRate: 0.2, lossRate: 0.2, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.5), concededOverRates: O(0.5) };
    const away = { n: 6, winRate: 0.2, drawRate: 0.2, lossRate: 0.6, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.5), concededOverRates: O(0.5) };
    const tip = bestTip({ dnb: { DNB1: 1.5, DNB2: 2.6 }, home, away, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0 });
    const dnb1 = [tip, ...(tip.runners_up ?? [])].find(c => c.market === 'DNB1');
    // DNB renormalizes AFTER the shrink, so the ratio is what is asserted
    assert.ok(dnb1.stats_prob > 0.5 && dnb1.stats_prob < 0.75);
});

test('bestTip TT:H uses scored-vs-conceded blend', () => {
    const home = { n: 6, winRate: 0.5, drawRate: 0.2, lossRate: 0.3, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.9), concededOverRates: O(0.3) };
    const away = { n: 6, winRate: 0.3, drawRate: 0.2, lossRate: 0.5, overRates: O(0.5), bttsRate: 0.5, oddRate: 0.5, scoredOverRates: O(0.3), concededOverRates: O(0.8) };
    const tip = bestTip({ tt: { H: { 1.5: { over: 1.7, under: 2.0 } } }, home, away, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0 });
    assert.equal(tip.market, 'TT:H:O 1.5');
    // raw stats = mean(home.scoredOverRates[1.5]=.9, away.concededOverRates[1.5]=.8) = .85
    assert.equal(bestTip({ tt: { H: { 1.5: { over: 1.7, under: 2.0 } } }, home, away, h2h: { n: 0 }, apiPercents: null },
        { minConfidence: 0, statsShrinkK: 0 }).stats_prob, 0.85);
    assert.ok(tip.stats_prob > 0.5 && tip.stats_prob < 0.85);
});

test('legacy byte-compat: canonical-only input reproduces the pre-M3 tip exactly', () => {
    // Same input as "bestTip lists up to two runners-up..." above - exercises
    // x12 + dc together with a market-only blend, giving a rich return with
    // runners_up populated. Captured from the pre-M3 bestTip (before Task 5).
    // The only shape change since is the additive `stats_gap` key (2026-07-26),
    // asserted explicitly below so any further drift still fails loudly.
    const out = bestTip({
        ...marketOnly,
        x12: { 1: 1.25, X: 6.0, 2: 9.0 },
        dc: { '1X': 1.22, X2: 2.4, 12: 1.3 },
        ou: {},
    });
    assert.deepEqual(out, {
        market: '1X',
        price: 1.22,
        confidence: 0.8969,
        market_prob: 0.8969,
        stats_prob: null,
        api_prob: null,
        weights: { market: 1, stats: null, api: null },
        samples: { home_n: 0, away_n: 0, h2h_n: 0 },
        stats_gap: null,
        runners_up: [
            {
                market: '12',
                price: 1.3,
                confidence: 0.8454,
                market_prob: 0.8454,
                stats_prob: null,
                api_prob: null,
                weights: { market: 1, stats: null, api: null },
            },
            {
                market: '1',
                price: 1.25,
                confidence: 0.7423,
                market_prob: 0.7423,
                stats_prob: null,
                api_prob: null,
                weights: { market: 1, stats: null, api: null },
            },
        ],
    });
});

// --- bookIntegrity / selectFamilyBook ---

test('bookIntegrity: overround window + completeness', () => {
    assert.deepEqual(bookIntegrity([2.0, 3.6, 3.4]).ok, true);            // ~1.07 vig
    assert.equal(bookIntegrity([2.6, 4.2, 4.0]).reason, 'overround_low');  // sum < 1 = palp/boost
    assert.equal(bookIntegrity([1.5, 2.5, 2.5]).reason, 'overround_high'); // 1.47 margin-loaded
    assert.equal(bookIntegrity([2.0, null, 3.4]).reason, 'incomplete');
});
test('selectFamilyBook: prefers betpawa, rejects divergent books', () => {
    const keys = ['GG', 'NG'];
    const ok = selectFamilyBook({ betpawa: { GG: 1.9, NG: 1.9 }, betika: { GG: 1.95, NG: 1.85 } }, keys);
    assert.equal(ok.book.GG, 1.9);
    // betika says GG 80%, betpawa says 50% -> divergence veto
    const div = selectFamilyBook({ betpawa: { GG: 1.9, NG: 1.9 }, betika: { GG: 1.18, NG: 4.8 } }, keys);
    assert.equal(div.book, null);
    assert.equal(div.reason, 'book_divergence');
    // single provider, sane book -> accepted with measured overround
    const solo = selectFamilyBook({ betpawa: { GG: 1.9, NG: 1.9 } }, keys);
    assert.ok(solo.overround > 1.0 && solo.book);
});

// --- buildTipBooks (M3 Task 6): one fixture's raw odds rows -> family books ---
// Walks raw {provider,type_name,name,handicap,price} rows through canonicalMarket,
// keeps FT-only books, groups per provider (lowest price), resolves team-total
// sides, and runs the new families through selectFamilyBook (overrounds/rejects
// audit). x12/dc/ou keep the legacy simple grouping (byte-compat: bestTip devigs
// them internally with no overround band).

test('buildTipBooks assembles canonical + new-family books from mixed providers', () => {
    const rows = [
        { provider: 'betpawa', type_name: '1X2 | Full Time', name: '1', price: 1.8 },
        { provider: 'betpawa', type_name: '1X2 | Full Time', name: 'X', price: 3.5 },
        { provider: 'betpawa', type_name: '1X2 | Full Time', name: '2', price: 4.2 },
        // betika-only BTTS book (live spelling)
        { provider: 'betika', type_name: 'BOTH TEAMS TO SCORE (GG/NG)', name: 'YES', price: 1.85 },
        { provider: 'betika', type_name: 'BOTH TEAMS TO SCORE (GG/NG)', name: 'NO', price: 1.9 },
    ];
    const books = buildTipBooks(rows, { homeName: 'Arsenal', awayName: 'Chelsea' });
    assert.ok(books.x12);                       // betpawa 1X2 present
    assert.equal(books.x12['1'], 1.8);
    assert.ok(books.btts);                       // betika GG/NG present -> both families
    assert.equal(books.btts.GG, 1.85);
    assert.ok(books.overrounds.btts > 1);        // accepted book -> overround recorded
});

test('buildTipBooks resolves team-total side by name and excludes unmatched teams', () => {
    // 'FOO TOTAL' matches neither home nor away -> excluded, no crash
    const unmatched = buildTipBooks([
        { provider: 'betika', type_name: 'FOO TOTAL', name: 'OVER 1.5', handicap: 1.5, price: 1.7 },
        { provider: 'betika', type_name: 'FOO TOTAL', name: 'UNDER 1.5', handicap: 1.5, price: 2.0 },
    ], { homeName: 'Arsenal', awayName: 'Chelsea' });
    assert.deepEqual(unmatched.tt, { H: {}, A: {} });
    assert.equal(unmatched.overrounds.tt, undefined);
    assert.equal(unmatched.rejects.tt, undefined);
    // The same team-total, but the name IS the home side -> resolved into tt.H
    const matched = buildTipBooks([
        { provider: 'betika', type_name: 'ARSENAL TOTAL', name: 'OVER 1.5', handicap: 1.5, price: 1.7 },
        { provider: 'betika', type_name: 'ARSENAL TOTAL', name: 'UNDER 1.5', handicap: 1.5, price: 2.0 },
    ], { homeName: 'Arsenal', awayName: 'Chelsea' });
    assert.ok(matched.tt.H[1.5]);
    assert.equal(matched.tt.H[1.5].over, 1.7);
    assert.deepEqual(matched.tt.A, {});
});

test('buildTipBooks keeps only full-time O/U lines (period-tagged excluded)', () => {
    const rows = [
        { provider: 'betpawa', type_name: 'Over/Under | Full Time', name: 'Over', handicap: 2.5, price: 1.9 },
        { provider: 'betpawa', type_name: 'Over/Under | Full Time', name: 'Under', handicap: 2.5, price: 1.95 },
        // 1st-half total -> period-tagged -> excluded from the FT O/U book
        { provider: 'betika', type_name: '1ST HALF - TOTAL', name: 'OVER 1.5', handicap: 1.5, price: 1.8 },
        { provider: 'betika', type_name: '1ST HALF - TOTAL', name: 'UNDER 1.5', handicap: 1.5, price: 1.9 },
    ];
    const books = buildTipBooks(rows, { homeName: 'A', awayName: 'B' });
    assert.ok(books.ou[2.5]);
    assert.equal(books.ou[1.5], undefined);   // period-tagged line never enters ou
});

test('buildTipBooks records a rejects reason for a palpable-error family book', () => {
    // GG 2.6 / NG 4.8 -> overround ~0.59 < minOverround -> overround_low
    const rows = [
        { provider: 'betpawa', type_name: 'Both Teams To Score | Full Time', name: 'Yes', price: 2.6 },
        { provider: 'betpawa', type_name: 'Both Teams To Score | Full Time', name: 'No', price: 4.8 },
    ];
    const books = buildTipBooks(rows, { homeName: 'A', awayName: 'B' });
    assert.equal(books.btts, null);
    assert.equal(books.rejects.btts, 'overround_low');
});

test('bestTip stamps book_overround from the family overrounds input (Task 5 gap)', () => {
    const agg = { n: 6, winRate: 0.5, drawRate: 0.2, lossRate: 0.3, overRates: O(0.8), bttsRate: 0.9, oddRate: 0.5, scoredOverRates: O(0.8), concededOverRates: O(0.7) };
    const tip = bestTip({
        btts: { GG: 1.55, NG: 2.3 }, home: agg, away: agg, h2h: { n: 0 }, apiPercents: null,
        overrounds: { btts: 1.07 },
    }, { minConfidence: 0.5 });
    assert.equal(tip.market, 'GG');
    assert.equal(tip.book_overround, 1.07);
});

// --- stats beta-shrink (2026-07-26) -----------------------------------------
// Every other rate in the codebase is shrunk. This one was not, so a 5-game
// window could assert stats_prob = 1.000 outright and three such tips lost.

test('a perfect short record never asserts certainty', () => {
    const perfect = { n: 6, winRate: 1, drawRate: 0, lossRate: 0, overRates: O(1),
        bttsRate: 1, oddRate: 0.5, scoredOverRates: O(1), concededOverRates: O(0) };
    const hopeless = { n: 6, winRate: 0, drawRate: 0, lossRate: 1, overRates: O(1),
        bttsRate: 1, oddRate: 0.5, scoredOverRates: O(0), concededOverRates: O(1) };
    const inputs = { x12: { 1: 1.5, X: 4, 2: 6 }, dc: null, ou: {},
        home: perfect, away: hopeless, h2h: { n: 0 }, apiPercents: null };
    const raw = bestTip(inputs, { minConfidence: 0, statsShrinkK: 0 });
    const shrunk = bestTip(inputs, { minConfidence: 0 });
    assert.equal(raw.stats_prob, 1);          // what shipped before
    assert.ok(shrunk.stats_prob < 1);         // and must never happen again
    assert.ok(shrunk.stats_prob > 0.75);      // ...without gutting real evidence
    assert.equal(shrunk.market, raw.market);  // the PICK is unchanged
});

test('shrinkage scales with sample size, not just rate', () => {
    const mk = n => ({ n, winRate: 1, drawRate: 0, lossRate: 0, overRates: O(1),
        bttsRate: 1, oddRate: 0.5, scoredOverRates: O(1), concededOverRates: O(0) });
    const away = { n: 30, winRate: 0, drawRate: 0, lossRate: 1, overRates: O(1),
        bttsRate: 1, oddRate: 0.5, scoredOverRates: O(0), concededOverRates: O(1) };
    const at = n => bestTip({ x12: { 1: 1.5, X: 4, 2: 6 }, dc: null, ou: {},
        home: mk(n), away, h2h: { n: 0 }, apiPercents: null }, { minConfidence: 0 }).stats_prob;
    // a deeper sample is pulled less far toward 0.5
    assert.ok(at(30) > at(12));
    assert.ok(at(12) > at(6));
});

test('statsShrinkK is configurable and 0 restores the old behaviour', () => {
    assert.equal(DEFAULT_TIP.statsShrinkK, 5);
    const agg = { n: 6, winRate: 1, drawRate: 0, lossRate: 0, overRates: O(1),
        bttsRate: 1, oddRate: 0.5, scoredOverRates: O(1), concededOverRates: O(0) };
    const away = { ...agg, winRate: 0, lossRate: 1, scoredOverRates: O(0), concededOverRates: O(1) };
    const inputs = { x12: { 1: 1.5, X: 4, 2: 6 }, dc: null, ou: {}, home: agg, away, h2h: { n: 0 }, apiPercents: null };
    assert.ok(bestTip(inputs, { minConfidence: 0, statsShrinkK: 20 }).stats_prob
        < bestTip(inputs, { minConfidence: 0, statsShrinkK: 5 }).stats_prob);
});
