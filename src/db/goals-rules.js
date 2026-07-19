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

// Per-line gate thresholds (M3, scoreOverLine). Only 2.5 is tuned today
// (the historical backtest above); a line with no entry here can NEVER fire
// hot - other lines are added ONLY by the Task 10 backtest re-run.
export const LINE_THRESHOLDS = { 2.5: DEFAULT_THRESHOLDS };

// Parse an O/U lines CSV ('2.5' / '1.5, 2.5') to unique positive finite
// numbers. ONE definition (M6): config.js's HOTPICK_LINES zod transform
// delegates here AND src/hotpicks.js parses the admin-override value through
// it - an already-parsed array (the config default reaching effective())
// passes through so callers never care which layer produced the value.
export function parseLinesCsv(v) {
    if (Array.isArray(v)) return [...new Set(v.map(Number).filter(n => Number.isFinite(n) && n > 0))];
    return [...new Set(String(v ?? '').split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0))];
}

// Full-time total-goals lines (mirrors markets.js/tip-rules.js OU_LINES).
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];

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

// Per-line share of games whose total goals beat the line (same accumulation-
// loop idiom as tip-rules.js's _overRates, kept separate here so this file
// stays zero-import).
function _overRates(games) {
    const rates = {};
    for (const line of OU_LINES) {
        rates[line] = _round(games.filter(f => f.ft_home + f.ft_away > line).length / games.length);
    }
    return rates;
}

// Aggregate goal behavior over one team's last-`window` finished games
// against opponents other than `opponentId` (vs-others semantics, matching
// computePrematch). `overRate` (legacy, byte-compat) uses total goals >= 3
// (i.e. over the 2.5 line); `overRates` carries the same rate per O/U line.
export function teamGoalsAggregates(rows, teamId, opponentId, cutoff, window) {
    const recent = _qualifying(rows, cutoff)
        .filter(f => !_isPair(f, teamId, opponentId))
        .slice(0, window);
    const n = recent.length;
    if (!n) return { n: 0, gfAvg: null, gaAvg: null, avgTotal: null, overRate: null, overRates: null, bttsRate: null };
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
        overRates: _overRates(recent),
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
// `overRate` (legacy, byte-compat) uses total goals >= 3 (over the 2.5
// line); `overRates` carries the same rate per O/U line.
export function h2hGoalsAggregates(rows, homeId, awayId, cutoff, window) {
    const meetings = _qualifying(rows, cutoff)
        .filter(f => _isPair(f, homeId, awayId))
        .slice(0, window);
    const n = meetings.length;
    if (!n) return { n: 0, overRate: null, overRates: null, avgTotal: null };
    let total = 0, over = 0;
    for (const f of meetings) {
        total += f.ft_home + f.ft_away;
        if (f.ft_home + f.ft_away >= 3) over++;
    }
    return { n, overRate: _round(over / n), overRates: _overRates(meetings), avgTotal: _round(total / n) };
}

// Interpret an API-Football prediction row against the over-`line` thesis
// (default 2.5, the original over-2.5 behavior).
//   pred: { under_over, advice } | null | undefined
// Returns 'support' | 'contradict' | null (absent/unreadable = neutral).
// under_over is a signed line string: "+2.5" advises over 2.5, "-3.5" advises
// under 3.5. Over advice at/above `line` supports; under advice at/below
// `line` contradicts (e.g. under 3.5 says nothing about over 2.5). Falls
// back to scanning the advice text ("... and -2.5 goals") when under_over
// is absent.
export function apiPredictionSignal(pred, line = 2.5) {
    let signed = pred?.under_over ?? null;
    if (signed == null && pred?.advice) {
        const m = /([+-]\d+(?:\.\d+)?)\s*goals/i.exec(pred.advice);
        if (m) signed = m[1];
    }
    if (signed == null) return null;
    const predLine = Number(signed);
    if (!Number.isFinite(predLine) || predLine === 0) return null;
    if (predLine > 0) return predLine >= line ? 'support' : null;
    return -predLine <= line ? 'contradict' : null;
}

// Score one fixture against the over-`line` concurrence gates (M3: any O/U
// line, not just 2.5).
//   home/away: teamGoalsAggregates() results
//   h2h: h2hGoalsAggregates() result
//   line: the O/U line to evaluate (e.g. 2.5); looks up LINE_THRESHOLDS[line]
//         (falls back to DEFAULT_THRESHOLDS - callers gate which lines are
//         allowed to fire hot by only invoking lines WITH a LINE_THRESHOLDS
//         entry, see src/hotpicks.js)
//   market: { impliedOver } | null (missing odds) - impliedOver must already
//           be devigged for THIS line's over/under pair
//   api: apiPredictionSignal(pred, line) result ('support'|'contradict'|null)
//   opts: threshold overrides + requireMarket (default true; the backtest
//         passes false - no historical odds exist)
// Returns { hot, score, signals, api_supports }:
//   hot - every gate passed;
//   score - composite 0..1 confidence (weighted blend of the probabilistic
//           signals, +/- API nudge) for ranking and display only - the
//           boolean gates alone decide hot;
//   signals - [{key, value, threshold, pass}] audit trail (ledger/tooltips).
export function scoreOverLine({ home, away, h2h, market, api }, line, opts = {}) {
    const t = { requireMarket: true, ...(LINE_THRESHOLDS[line] ?? DEFAULT_THRESHOLDS), ...opts };
    // Line-specific over rate, falling back to the legacy overRate field
    // only at the 2.5 line (byte-compat with pre-M3 callers/tests that never
    // populated overRates).
    const hOver = home.overRates?.[line] ?? (line === 2.5 ? home.overRate : null);
    const aOver = away.overRates?.[line] ?? (line === 2.5 ? away.overRate : null);
    const hhOver = h2h.overRates?.[line] ?? (line === 2.5 ? h2h.overRate : null);
    const impliedOver = market?.impliedOver ?? null;
    const signals = [
        { key: 'home_sample', value: home.n, threshold: t.minGames, pass: home.n >= t.minGames },
        { key: 'away_sample', value: away.n, threshold: t.minGames, pass: away.n >= t.minGames },
        { key: 'home_avg_total', value: home.avgTotal, threshold: t.minAvgTotal, pass: home.avgTotal != null && home.avgTotal >= t.minAvgTotal },
        { key: 'home_over_rate', value: hOver, threshold: t.minOverRate, pass: hOver != null && hOver >= t.minOverRate },
        { key: 'away_avg_total', value: away.avgTotal, threshold: t.minAvgTotal, pass: away.avgTotal != null && away.avgTotal >= t.minAvgTotal },
        { key: 'away_over_rate', value: aOver, threshold: t.minOverRate, pass: aOver != null && aOver >= t.minOverRate },
        {
            key: 'market_implied_over', value: impliedOver, threshold: t.minImpliedOver,
            // Missing odds fail the gate unless the caller opted out (backtest)
            pass: impliedOver != null ? impliedOver >= t.minImpliedOver : !t.requireMarket,
        },
        {
            key: 'h2h_over_rate', value: hhOver, threshold: t.h2hMinOverRate,
            // Veto-only gate: a thin H2H sample is neutral, not a pass/fail
            pass: !(h2h.n >= t.h2hMinMeetings && hhOver < t.h2hMinOverRate),
        },
        { key: 'api_prediction', value: api ?? null, threshold: 'not contradict', pass: api !== 'contradict' },
    ];
    const hot = signals.every(s => s.pass);

    // Composite confidence: weighted average of available probability-like
    // signals, renormalized when one is missing, nudged by the API verdict.
    const parts = [];
    if (hOver != null) parts.push([0.25, hOver]);
    if (aOver != null) parts.push([0.25, aOver]);
    if (impliedOver != null) parts.push([0.3, impliedOver]);
    if (h2h.n >= t.h2hMinMeetings && hhOver != null) parts.push([0.2, hhOver]);
    const weight = parts.reduce((sum, [w]) => sum + w, 0);
    let score = weight ? parts.reduce((sum, [w, v]) => sum + w * v, 0) / weight : 0;
    if (api === 'support') score = Math.min(1, score + 0.05);
    else if (api === 'contradict') score = Math.max(0, score - 0.1);

    return { hot, score: _round(score), signals, api_supports: api == null ? null : api === 'support' };
}

// Over 2.5 is the original, still-live shortcut (byte-compat wrapper).
export function scoreOver25(inputs, opts = {}) {
    return scoreOverLine(inputs, 2.5, opts);
}
