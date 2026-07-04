// Pure Over 2.5 goals deduction rules shared by the pick writer
// (src/hotpicks.js) and the backtest script (scripts/backtest-hotpicks.js).
// Zero imports on purpose (like prematch-calc.js) so tests run without .env/DB.
//
// Division of labor: callers filter fixtures to FINAL_STATUSES in SQL; these
// helpers enforce the row-level rules - non-null FT scores and kickoff
// strictly before the analyzed fixture's kickoff (the leak-free cutoff).
//
// Philosophy: precision over recall. A fixture is hot ONLY when every
// independent evidence stream agrees (strict AND gates); most days that
// shortlists few or zero games, by design.

// Default gate thresholds, tuned by the historical backtest
// (scripts/backtest-hotpicks.js, 2026-07-03: 10,678 finished fixtures,
// baseline over-2.5 rate 54.3%; this combination hit 73.2% precision on the
// stats gates alone - market/API gates only tighten it further). Overridable
// via HOTPICK_* env vars. teamWindow must stay <= ~8: the history backfill
// fetches only PREMATCH_TEAM_WINDOW + PREMATCH_H2H_WINDOW (10) games/team.
export const DEFAULT_THRESHOLDS = {
    teamWindow: 7,        // rolling last-N games per team (vs other opponents)
    minGames: 5,          // minimum qualifying sample per team
    minOverRate: 0.6,     // share of last-N games with 3+ total goals, per team
    minAvgTotal: 3.2,     // average total goals per game, per team
    minImpliedOver: 0.52, // vig-removed market P(over 2.5) floor
    h2hMinOverRate: 0.4,  // H2H veto: meetings exist but rarely go over
    h2hMinMeetings: 3,    // ... only when at least this many meetings
};

// Vig-removed two-way implied probability of the OVER from decimal prices.
// Normalizing 1/over against the booked pair strips the bookmaker margin.
export function impliedProbability(overPrice, underPrice) {
    const o = Number(overPrice), u = Number(underPrice);
    if (!(o > 1) || !(u > 1)) return null;
    return (1 / o) / (1 / o + 1 / u);
}

// Qualifying history rows for a fixture kicking off at `cutoff` (ms):
// scored and strictly earlier, newest first (mirrors prematch-calc).
function _qualifying(rows, cutoff) {
    return rows
        .filter(f => f.ft_home != null && f.ft_away != null
            && new Date(f.kickoff).getTime() < cutoff)
        .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime());
}

const _isPair = (f, a, b) =>
    (f.home_team_id === a && f.away_team_id === b) || (f.home_team_id === b && f.away_team_id === a);

const _round = v => Math.round(v * 1000) / 1000;

// Aggregate goal behavior over one team's last-`window` finished games
// against opponents other than `opponentId` (vs-others semantics, matching
// computePrematch). Rates use total goals >= 3 (i.e. over the 2.5 line).
export function teamGoalsAggregates(rows, teamId, opponentId, cutoff, window) {
    const recent = _qualifying(rows, cutoff)
        .filter(f => !_isPair(f, teamId, opponentId))
        .slice(0, window);
    const n = recent.length;
    if (!n) return { n: 0, gfAvg: null, gaAvg: null, avgTotal: null, overRate: null, bttsRate: null };
    let gf = 0, ga = 0, over = 0, btts = 0;
    for (const f of recent) {
        const home = f.home_team_id === teamId;
        gf += home ? f.ft_home : f.ft_away;
        ga += home ? f.ft_away : f.ft_home;
        if (f.ft_home + f.ft_away >= 3) over++;
        if (f.ft_home > 0 && f.ft_away > 0) btts++;
    }
    return {
        n,
        gfAvg: _round(gf / n),
        gaAvg: _round(ga / n),
        avgTotal: _round((gf + ga) / n),
        overRate: _round(over / n),
        bttsRate: _round(btts / n),
    };
}

// Fairness pairing: both teams of one fixture must be judged over the SAME
// number of games. Mixed windows subtly bias the rate gates (a 7-game side
// needs 5/7 = 0.714 to clear a 0.6 over-rate floor while a 5-game side needs
// only 3/5 = 0.6) and the averages span different stretches of form.
// Computes each side's last-`window` aggregates, then caps BOTH at the
// smaller qualifying count, recomputing the richer side over its most recent
// `cap` games. `pool` carries the uncapped per-side counts so callers can
// still attribute WHICH side is thin (eligibility reasons).
export function pairedTeamGoalsAggregates(homeRows, awayRows, homeId, awayId, cutoff, window) {
    let home = teamGoalsAggregates(homeRows, homeId, awayId, cutoff, window);
    let away = teamGoalsAggregates(awayRows, awayId, homeId, cutoff, window);
    const pool = { home_n: home.n, away_n: away.n };
    const cap = Math.min(home.n, away.n);
    if (home.n > cap) home = teamGoalsAggregates(homeRows, homeId, awayId, cutoff, cap);
    if (away.n > cap) away = teamGoalsAggregates(awayRows, awayId, homeId, cutoff, cap);
    return { home, away, pool };
}

// Aggregate goal behavior over the pair's last-`window` finished meetings.
export function h2hGoalsAggregates(rows, homeId, awayId, cutoff, window) {
    const meetings = _qualifying(rows, cutoff)
        .filter(f => _isPair(f, homeId, awayId))
        .slice(0, window);
    const n = meetings.length;
    if (!n) return { n: 0, overRate: null, avgTotal: null };
    let total = 0, over = 0;
    for (const f of meetings) {
        total += f.ft_home + f.ft_away;
        if (f.ft_home + f.ft_away >= 3) over++;
    }
    return { n, overRate: _round(over / n), avgTotal: _round(total / n) };
}

// Interpret an API-Football prediction row against the over-2.5 thesis.
//   pred: { under_over, advice } | null | undefined
// Returns 'support' | 'contradict' | null (absent/unreadable = neutral).
// under_over is a signed line string: "+2.5" advises over 2.5, "-3.5" advises
// under 3.5. Over at line >= 2.5 supports; under at line <= 2.5 contradicts
// (under 3.5 says nothing about over 2.5). Falls back to scanning the advice
// text ("... and -2.5 goals") when under_over is absent.
export function apiPredictionSignal(pred) {
    let signed = pred?.under_over ?? null;
    if (signed == null && pred?.advice) {
        const m = /([+-]\d+(?:\.\d+)?)\s*goals/i.exec(pred.advice);
        if (m) signed = m[1];
    }
    if (signed == null) return null;
    const line = Number(signed);
    if (!Number.isFinite(line) || line === 0) return null;
    if (line > 0) return line >= 2.5 ? 'support' : null;
    return -line <= 2.5 ? 'contradict' : null;
}

// Score one fixture against the over-2.5 concurrence gates.
//   home/away: teamGoalsAggregates() results
//   h2h: h2hGoalsAggregates() result
//   market: { impliedOver } | null (missing odds)
//   api: apiPredictionSignal() result ('support'|'contradict'|null)
//   opts: DEFAULT_THRESHOLDS overrides + requireMarket (default true; the
//         backtest passes false - no historical odds exist)
// Returns { hot, score, signals, api_supports }:
//   hot - every gate passed;
//   score - composite 0..1 confidence (weighted blend of the probabilistic
//           signals, +/- API nudge) for ranking and display only - the
//           boolean gates alone decide hot;
//   signals - [{key, value, threshold, pass}] audit trail (ledger/tooltips).
export function scoreOver25({ home, away, h2h, market, api }, opts = {}) {
    const t = { requireMarket: true, ...DEFAULT_THRESHOLDS, ...opts };
    const impliedOver = market?.impliedOver ?? null;
    const signals = [
        { key: 'home_sample', value: home.n, threshold: t.minGames, pass: home.n >= t.minGames },
        { key: 'away_sample', value: away.n, threshold: t.minGames, pass: away.n >= t.minGames },
        { key: 'home_avg_total', value: home.avgTotal, threshold: t.minAvgTotal, pass: home.avgTotal != null && home.avgTotal >= t.minAvgTotal },
        { key: 'home_over_rate', value: home.overRate, threshold: t.minOverRate, pass: home.overRate != null && home.overRate >= t.minOverRate },
        { key: 'away_avg_total', value: away.avgTotal, threshold: t.minAvgTotal, pass: away.avgTotal != null && away.avgTotal >= t.minAvgTotal },
        { key: 'away_over_rate', value: away.overRate, threshold: t.minOverRate, pass: away.overRate != null && away.overRate >= t.minOverRate },
        {
            key: 'market_implied_over', value: impliedOver, threshold: t.minImpliedOver,
            // Missing odds fail the gate unless the caller opted out (backtest)
            pass: impliedOver != null ? impliedOver >= t.minImpliedOver : !t.requireMarket,
        },
        {
            key: 'h2h_over_rate', value: h2h.overRate, threshold: t.h2hMinOverRate,
            // Veto-only gate: a thin H2H sample is neutral, not a pass/fail
            pass: !(h2h.n >= t.h2hMinMeetings && h2h.overRate < t.h2hMinOverRate),
        },
        { key: 'api_prediction', value: api ?? null, threshold: 'not contradict', pass: api !== 'contradict' },
    ];
    const hot = signals.every(s => s.pass);

    // Composite confidence: weighted average of available probability-like
    // signals, renormalized when one is missing, nudged by the API verdict.
    const parts = [];
    if (home.overRate != null) parts.push([0.25, home.overRate]);
    if (away.overRate != null) parts.push([0.25, away.overRate]);
    if (impliedOver != null) parts.push([0.3, impliedOver]);
    if (h2h.n >= t.h2hMinMeetings && h2h.overRate != null) parts.push([0.2, h2h.overRate]);
    const weight = parts.reduce((sum, [w]) => sum + w, 0);
    let score = weight ? parts.reduce((sum, [w, v]) => sum + w * v, 0) / weight : 0;
    if (api === 'support') score = Math.min(1, score + 0.05);
    else if (api === 'contradict') score = Math.max(0, score - 0.1);

    return { hot, score: _round(score), signals, api_supports: api == null ? null : api === 'support' };
}
