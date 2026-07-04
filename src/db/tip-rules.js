// Pure "best tip" deduction: the safest bettable outcome for one fixture
// across the canonical markets (1X2, double chance, every O/U line), scored
// by a blended confidence - vig-removed market probability corroborated by
// rolling history rates and API-Football percentages. Zero project imports
// (like goals-rules.js) so tests run without .env/DB.
//
// A price floor keeps tips meaningful: near-certain markets priced at ~1.0x
// (O 0.5 against two scoring sides) are excluded - what remains at high
// confidence is the "hidden gem" the column exists to surface.
//
// Division of labor: callers filter fixtures to FINAL_STATUSES in SQL; the
// aggregates enforce non-null FT scores and kickoff strictly before the
// analyzed fixture's kickoff (the leak-free cutoff).

export const DEFAULT_TIP = {
    teamWindow: 7,       // rolling last-N games per team (vs other opponents)
    minGames: 5,         // minimum sample before a team's rates count as evidence
    h2hMinMeetings: 3,   // minimum meetings before H2H rates count as evidence
    minPrice: 1.2,       // tips priced below this pay too little to matter
    minConfidence: 0.5,  // no tip at all below this blend
    // Blend weights, renormalized over the components actually available
    weights: { market: 0.6, stats: 0.3, api: 0.1 },
};

// Full-time total-goals lines (mirrors markets.js OU_LINES)
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];

const _round = v => Math.round(v * 10000) / 10000;

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

// Per-line share of games whose total goals beat the line
function _overRates(games) {
    const rates = {};
    for (const line of OU_LINES) {
        rates[line] = _round(games.filter(f => f.ft_home + f.ft_away > line).length / games.length);
    }
    return rates;
}

// Outcome rates over one team's last-`window` finished games against
// opponents other than `opponentId` (vs-others semantics, like goals-rules).
export function teamOutcomeAggregates(rows, teamId, opponentId, cutoff, window) {
    const recent = _qualifying(rows, cutoff)
        .filter(f => !_isPair(f, teamId, opponentId))
        .slice(0, window);
    const n = recent.length;
    if (!n) return { n: 0, winRate: null, drawRate: null, lossRate: null, overRates: null };
    let w = 0, d = 0;
    for (const f of recent) {
        const [gf, ga] = f.home_team_id === teamId ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) w++;
        else if (gf === ga) d++;
    }
    return {
        n,
        winRate: _round(w / n),
        drawRate: _round(d / n),
        lossRate: _round((n - w - d) / n),
        overRates: _overRates(recent),
    };
}

// Outcome rates over the pair's last-`window` finished meetings, from the
// analyzed fixture's home-team perspective.
export function h2hOutcomeAggregates(rows, homeId, awayId, cutoff, window) {
    const meetings = _qualifying(rows, cutoff)
        .filter(f => _isPair(f, homeId, awayId))
        .slice(0, window);
    const n = meetings.length;
    if (!n) return { n: 0, homeWinRate: null, drawRate: null, awayWinRate: null, overRates: null };
    let hw = 0, d = 0;
    for (const f of meetings) {
        const [gf, ga] = f.home_team_id === homeId ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) hw++;
        else if (gf === ga) d++;
    }
    return {
        n,
        homeWinRate: _round(hw / n),
        drawRate: _round(d / n),
        awayWinRate: _round((n - hw - d) / n),
        overRates: _overRates(meetings),
    };
}

// Vig-removed probabilities for a full market group of decimal prices;
// null when any price is missing or degenerate (<= 1).
function _devig(prices) {
    const inv = prices.map(p => (Number(p) > 1 ? 1 / Number(p) : null));
    if (inv.some(v => v == null)) return null;
    const sum = inv.reduce((a, b) => a + b, 0);
    return inv.map(v => v / sum);
}

// Mean of the non-null components, or null when none qualify
function _mean(components) {
    const vals = components.filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Cheap evidence screen run BEFORE bestTip: a fixture without enough
// independent evidence never gets a tip at all. Without it the blend silently
// renormalizes to market-only - and the market component is the bookmaker's
// own devigged opinion, which cannot beat the vig by itself (the prime
// false-positive source this gate exists to kill).
//   x12/dc/ou: market groups as passed to bestTip (null / {} when absent)
//   home/away: any aggregates carrying the qualifying sample size `n`
//              (the writer reuses the hot-gate teamGoalsAggregates results)
// Returns { eligible: true, reason: null } or { eligible: false, reason }
// where reason is a short marker surfaced by the web UI (<= 64 chars), e.g.
// 'insufficient_history: home 2/5' or 'no_markets'.
export function tipEligibility({ x12, dc, ou, home, away }, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    // TODO(user contribution): the eligibility rules are a betting-domain
    // judgment call - which conditions disqualify a fixture, in what order,
    // with what reason detail. Expected shape (~8 lines):
    //   - either team's sample below t.minGames -> insufficient_history
    //     (include the offending side(s) and counts in the reason);
    //   - no market group at all (no x12, no dc, no O/U pair) -> no_markets;
    //   - otherwise eligible.
    // Placeholder passes everything through so live runs keep today's
    // behavior until the real rules land (tests specify the contract).
    void t; void x12; void dc; void ou; void home; void away;
    return { eligible: true, reason: null };
}

// Did a settled fixture hit one canonical market? (tip settlement)
export function tipHit(market, ftHome, ftAway) {
    const total = ftHome + ftAway;
    switch (market) {
        case '1': return ftHome > ftAway;
        case 'X': return ftHome === ftAway;
        case '2': return ftHome < ftAway;
        case '1X': return ftHome >= ftAway;
        case 'X2': return ftHome <= ftAway;
        case '12': return ftHome !== ftAway;
        default: {
            const ou = /^([OU]) (\d\.5)$/.exec(market);
            if (!ou) throw new TypeError(`Unknown tip market: ${market}`);
            return ou[1] === 'O' ? total > Number(ou[2]) : total < Number(ou[2]);
        }
    }
}

// Choose the safest bettable outcome for one fixture.
//   x12: {'1','X','2'} -> price | null; dc: {'1X','X2','12'} -> price | null
//   ou: { [line]: { over, under } } (only lines with a full pair)
//   home/away: teamOutcomeAggregates(); h2h: h2hOutcomeAggregates()
//   apiPercents: { home, draw, away } fractions 0..1 | null
// Returns { market, price, confidence, market_prob, stats_prob, api_prob,
// weights, samples, runners_up } - weights are the renormalized blend weights
// actually applied, samples the evidence sizes, runners_up the next two
// candidates (justification breakdown persisted as fixture_predictions
// .tip_breakdown) - or null when nothing clears the price/confidence floors.
export function bestTip({ x12, dc, ou, home, away, h2h, apiPercents }, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    const w = t.weights;

    // Market probabilities. Double-chance probs derive from the devigged 1X2
    // book when present (one consistent book); its own trio is the fallback.
    const p12 = x12 ? _devig([x12['1'], x12['X'], x12['2']]) : null;
    const pdcOwn = dc ? _devig([dc['1X'], dc['X2'], dc['12']]) : null;
    const marketProb = {
        1: p12?.[0], X: p12?.[1], 2: p12?.[2],
        '1X': p12 ? p12[0] + p12[1] : pdcOwn?.[0],
        X2: p12 ? p12[1] + p12[2] : pdcOwn?.[1],
        12: p12 ? p12[0] + p12[2] : pdcOwn?.[2],
    };

    // Stats support per outcome: mean of whichever evidence streams qualify
    // (each team's sample independently, H2H only when established).
    const hOk = home.n >= t.minGames, aOk = away.n >= t.minGames, hhOk = h2h.n >= t.h2hMinMeetings;
    const statsProb = {
        1: _mean([hOk ? home.winRate : null, aOk ? away.lossRate : null, hhOk ? h2h.homeWinRate : null]),
        X: _mean([hOk ? home.drawRate : null, aOk ? away.drawRate : null, hhOk ? h2h.drawRate : null]),
        2: _mean([hOk ? home.lossRate : null, aOk ? away.winRate : null, hhOk ? h2h.awayWinRate : null]),
    };
    statsProb['1X'] = statsProb['2'] == null ? null : 1 - statsProb['2'];
    statsProb['X2'] = statsProb['1'] == null ? null : 1 - statsProb['1'];
    statsProb['12'] = statsProb['X'] == null ? null : 1 - statsProb['X'];
    const statsOver = line => _mean([
        hOk ? home.overRates[line] : null,
        aOk ? away.overRates[line] : null,
        hhOk ? h2h.overRates[line] : null,
    ]);

    // API-Football 1X2 percentages back the result markets only
    const api = apiPercents && [apiPercents.home, apiPercents.draw, apiPercents.away].every(v => v != null)
        ? {
            1: apiPercents.home, X: apiPercents.draw, 2: apiPercents.away,
            '1X': apiPercents.home + apiPercents.draw,
            X2: apiPercents.draw + apiPercents.away,
            12: apiPercents.home + apiPercents.away,
        }
        : null;

    const candidates = [];
    const consider = (market, price, mkt, stats, apiP) => {
        if (mkt == null || !(Number(price) >= t.minPrice)) return;
        const parts = [[w.market, mkt], ...(stats != null ? [[w.stats, stats]] : []), ...(apiP != null ? [[w.api, apiP]] : [])];
        const weight = parts.reduce((sum, [wt]) => sum + wt, 0);
        const confidence = parts.reduce((sum, [wt, v]) => sum + wt * v, 0) / weight;
        candidates.push({
            market,
            price: Number(price),
            confidence: _round(Math.min(1, confidence)),
            market_prob: _round(mkt),
            stats_prob: stats == null ? null : _round(stats),
            api_prob: apiP == null ? null : _round(apiP),
            // Effective weights after renormalizing over the available parts
            weights: {
                market: _round(w.market / weight),
                stats: stats == null ? null : _round(w.stats / weight),
                api: apiP == null ? null : _round(w.api / weight),
            },
        });
    };

    for (const key of ['1', 'X', '2']) {
        if (x12) consider(key, x12[key], marketProb[key], statsProb[key], api?.[key]);
    }
    for (const key of ['1X', 'X2', '12']) {
        if (dc) consider(key, dc[key], marketProb[key], statsProb[key], api?.[key]);
    }
    for (const [line, pair] of Object.entries(ou ?? {})) {
        const probs = _devig([pair.over, pair.under]);
        if (!probs) continue;
        const over = statsOver(Number(line));
        consider(`O ${line}`, pair.over, probs[0], over, null);
        consider(`U ${line}`, pair.under, probs[1], over == null ? null : 1 - over, null);
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.confidence - a.confidence || b.price - a.price);
    if (candidates[0].confidence < t.minConfidence) return null;
    return {
        ...candidates[0],
        samples: { home_n: home.n, away_n: away.n, h2h_n: h2h.n },
        runners_up: candidates.slice(1, 3),
    };
}
