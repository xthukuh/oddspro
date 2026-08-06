// Goal model: one fitted scoring intensity per fixture, from which EVERY market
// probability is derived coherently.
//
// WHY THIS REPLACES THE EMPIRICAL RATES
// The blend's stats component asked each market its own separate question: "what
// share of this team's last 6 games went over 2.5?" With a 6-game window that
// answer can only be one of {0, 1/6, 2/6, ...} - a 17-point grid - and each line
// is counted independently, so the engine could believe P(O 1.5)=0.67 and
// P(O 2.5)=0.83 at the same time. That is not a noisy estimate of the truth; it
// is not a probability distribution at all.
//
// A goal model asks ONE question - how many goals will each side score? - and
// reads every market off the answer. Three consequences:
//   1. COHERENCE by construction. P(O 1.5) >= P(O 2.5) always, because both come
//      from the same score matrix. The lattice in ladder-rules and the model can
//      no longer disagree.
//   2. POOLING. Every historical goal informs every line, so a 6-game window
//      yields a smooth intensity instead of a 17-point grid.
//   3. REACH. Markets with no empirical counterpart (correct score, team totals
//      at unseen lines) fall out for free.
//
// Standard independent-Poisson with the Dixon-Coles low-score correction, team
// strengths estimated by shrunk exposure ratios with exponential time decay.
// Deliberately NOT a numerical optimiser: a closed-form ratio estimator is
// stable on the 5-40 matches a team actually has here, needs no convergence
// checks, and cannot silently return a bad fit on thin data.
//
// Pure module - zero imports. Leak-free by contract: the caller passes only
// matches that kicked off before the fixture being predicted.

export const DEFAULT_MODEL = {
    // Half-life in days for match weighting. 180 means a game six months old
    // counts half as much as yesterday's. Football form decays; a flat window
    // treats a September thrashing as equal evidence to last week's.
    halfLifeDays: 180,
    // Shrinkage pseudo-exposure for team strength. A team with little history is
    // pulled toward league-average (strength 1.0). k=4 means "about four
    // matches' worth of prior belief that this side is unremarkable".
    shrinkK: 4,
    // Dixon-Coles dependence parameter. Independent Poisson systematically
    // under-predicts 0-0 and 1-1 and over-predicts 1-0 and 0-1; rho corrects the
    // four low-score cells. -0.05 is the conventional value and is not fitted
    // here - fitting one global rho on 15 days of data would be noise.
    rho: -0.05,
    // Score matrix extent. P(4+ goals for one side) is already tiny; 10 makes
    // the residual mass negligible without a huge matrix.
    maxGoals: 10,
    // Global fallback intensities when a league has no usable history at all.
    // Long-run football averages, used only as a floor.
    fallbackHome: 1.45,
    fallbackAway: 1.15,
    // Minimum matches in a league before its own baseline is trusted over the
    // global one.
    leagueMinMatches: 20,
};

const _clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// exp(-ln2 * age / halfLife)
function _weight(kickoffMs, cutoffMs, halfLifeDays) {
    const ageDays = Math.max(0, (cutoffMs - kickoffMs) / 86400000);
    return Math.pow(2, -ageDays / halfLifeDays);
}

// Fit team attack/defence strengths and league baselines from finished matches.
//
// `matches` rows need: home_team_id, away_team_id, ft_home, ft_away, kickoff,
// league_id. Rows at or after `cutoff` are DROPPED here rather than trusted to
// the caller - the leak guard belongs where the data is read.
//
// Returns a model object consumable by predictFixture().
export function fitGoalModel(matches, cutoff, opts = {}) {
    const o = { ...DEFAULT_MODEL, ...opts };
    const cutoffMs = typeof cutoff === 'number' ? cutoff : new Date(cutoff).getTime();

    // --- pass 1: league baselines (weighted mean goals by venue)
    const league = new Map();       // league_id -> { wHome, wAway, w }
    const usable = [];
    for (const m of matches) {
        if (m.ft_home == null || m.ft_away == null) continue;
        const ts = new Date(m.kickoff).getTime();
        if (!(ts < cutoffMs)) continue;                      // strict: no same-instant leak
        const w = _weight(ts, cutoffMs, o.halfLifeDays);
        if (!(w > 0)) continue;
        usable.push({ ...m, _w: w });
        const key = m.league_id ?? 0;
        let L = league.get(key);
        if (!L) league.set(key, L = { wHome: 0, wAway: 0, w: 0, n: 0 });
        L.wHome += w * m.ft_home; L.wAway += w * m.ft_away; L.w += w; L.n++;
    }
    let gH = 0, gA = 0, gW = 0;
    for (const L of league.values()) { gH += L.wHome; gA += L.wAway; gW += L.w; }
    const globalHome = gW > 0 ? gH / gW : o.fallbackHome;
    const globalAway = gW > 0 ? gA / gW : o.fallbackAway;

    const baseline = new Map();
    for (const [key, L] of league) {
        // A thin league borrows the global mean; a deep one uses its own.
        const trust = L.n >= o.leagueMinMatches ? 1 : L.n / o.leagueMinMatches;
        baseline.set(key, {
            home: _clamp(trust * (L.wHome / L.w) + (1 - trust) * globalHome, 0.2, 5),
            away: _clamp(trust * (L.wAway / L.w) + (1 - trust) * globalAway, 0.2, 5),
            n: L.n,
        });
    }
    const baseOf = id => baseline.get(id ?? 0)
        ?? { home: globalHome, away: globalAway, n: 0 };

    // --- pass 2: team exposure. `scored` vs what an average side would have
    // scored in the same fixtures; likewise `conceded`.
    const team = new Map();
    const T = id => {
        let t = team.get(id);
        if (!t) team.set(id, t = { scored: 0, expScored: 0, conceded: 0, expConceded: 0, w: 0, n: 0 });
        return t;
    };
    for (const m of usable) {
        const b = baseOf(m.league_id);
        const h = T(m.home_team_id), a = T(m.away_team_id);
        h.scored += m._w * m.ft_home; h.expScored += m._w * b.home;
        h.conceded += m._w * m.ft_away; h.expConceded += m._w * b.away;
        a.scored += m._w * m.ft_away; a.expScored += m._w * b.away;
        a.conceded += m._w * m.ft_home; a.expConceded += m._w * b.home;
        h.w += m._w; a.w += m._w; h.n++; a.n++;
    }

    // Shrunk ratio: (observed + k*expected_prior) / (expected + k*expected_prior).
    // A side with no history lands exactly on 1.0.
    const strength = new Map();
    for (const [id, t] of team) {
        const kS = o.shrinkK * (t.n ? t.expScored / t.n : 1);
        const kC = o.shrinkK * (t.n ? t.expConceded / t.n : 1);
        strength.set(id, {
            attack: _clamp((t.scored + kS) / (t.expScored + kS || 1), 0.25, 4),
            defence: _clamp((t.conceded + kC) / (t.expConceded + kC || 1), 0.25, 4),
            n: t.n,
        });
    }

    return { baseline, baseOf, strength, globalHome, globalAway, opts: o, matches: usable.length };
}

const _NEUTRAL = { attack: 1, defence: 1, n: 0 };

// Dixon-Coles low-score dependence correction.
function _tau(h, a, lh, la, rho) {
    if (h === 0 && a === 0) return 1 - lh * la * rho;
    if (h === 0 && a === 1) return 1 + lh * rho;
    if (h === 1 && a === 0) return 1 + la * rho;
    if (h === 1 && a === 1) return 1 - rho;
    return 1;
}

function _poisson(lambda, max) {
    const out = new Array(max + 1);
    let p = Math.exp(-lambda);
    out[0] = p;
    for (let k = 1; k <= max; k++) { p = p * lambda / k; out[k] = p; }
    return out;
}

// Predicted scoring intensities and the full score matrix for one fixture.
export function predictFixture(model, homeTeamId, awayTeamId, leagueId) {
    const o = model.opts;
    const b = model.baseOf(leagueId);
    const H = model.strength.get(homeTeamId) ?? _NEUTRAL;
    const A = model.strength.get(awayTeamId) ?? _NEUTRAL;

    const lambdaHome = _clamp(b.home * H.attack * A.defence, 0.05, 8);
    const lambdaAway = _clamp(b.away * A.attack * H.defence, 0.05, 8);

    const ph = _poisson(lambdaHome, o.maxGoals);
    const pa = _poisson(lambdaAway, o.maxGoals);
    const matrix = [];
    let total = 0;
    for (let h = 0; h <= o.maxGoals; h++) {
        matrix[h] = new Array(o.maxGoals + 1);
        for (let a = 0; a <= o.maxGoals; a++) {
            const v = ph[h] * pa[a] * _tau(h, a, lambdaHome, lambdaAway, o.rho);
            matrix[h][a] = v; total += v;
        }
    }
    // Renormalise: the tau correction and the truncation both cost mass.
    if (total > 0) for (let h = 0; h <= o.maxGoals; h++) for (let a = 0; a <= o.maxGoals; a++) matrix[h][a] /= total;

    return {
        lambdaHome, lambdaAway, matrix,
        samples: { home_n: H.n, away_n: A.n, league_n: b.n },
    };
}

const _round = v => Math.round(v * 10000) / 10000;
const OU_LINES = [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5];

// Read every canonical market off the score matrix. Keys match tip-rules'
// vocabulary exactly, so the result drops straight into the blend.
export function marketProbabilities(pred) {
    const m = pred.matrix, n = m.length - 1;
    const out = {};
    let home = 0, draw = 0, away = 0, btts = 0, odd = 0;
    const totalAt = new Array(2 * n + 1).fill(0);
    const homeGoals = new Array(n + 1).fill(0);
    const awayGoals = new Array(n + 1).fill(0);

    for (let h = 0; h <= n; h++) {
        for (let a = 0; a <= n; a++) {
            const p = m[h][a];
            if (h > a) home += p; else if (h === a) draw += p; else away += p;
            if (h > 0 && a > 0) btts += p;
            if ((h + a) % 2 === 1) odd += p;
            totalAt[h + a] += p;
            homeGoals[h] += p; awayGoals[a] += p;
        }
    }
    out['1'] = _round(home); out.X = _round(draw); out['2'] = _round(away);
    out['1X'] = _round(home + draw); out.X2 = _round(draw + away); out['12'] = _round(home + away);
    out.GG = _round(btts); out.NG = _round(1 - btts);
    out.ODD = _round(odd); out.EVEN = _round(1 - odd);
    // Draw-no-bet renormalises over the non-draw outcomes.
    const nd = home + away;
    out.DNB1 = _round(nd > 0 ? home / nd : 0.5);
    out.DNB2 = _round(nd > 0 ? away / nd : 0.5);

    // Total goals - monotone by construction, which the empirical rates were not.
    let cum = 0;
    const over = {};
    for (let t = 0; t < totalAt.length; t++) { cum += totalAt[t]; over[t] = cum; }
    for (const line of OU_LINES) {
        const atOrBelow = over[Math.floor(line)] ?? 1;
        out[`O ${line}`] = _round(1 - atOrBelow);
        out[`U ${line}`] = _round(atOrBelow);
    }

    // Team totals, same construction per side.
    const side = (arr, tag) => {
        let c = 0; const cumv = [];
        for (let g = 0; g < arr.length; g++) { c += arr[g]; cumv[g] = c; }
        for (const line of OU_LINES) {
            const below = cumv[Math.floor(line)] ?? 1;
            out[`TT:${tag}:O ${line}`] = _round(1 - below);
            out[`TT:${tag}:U ${line}`] = _round(below);
        }
    };
    side(homeGoals, 'H'); side(awayGoals, 'A');
    return out;
}

// Convenience: fit -> predict -> markets, for one fixture.
export function modelMarkets(model, homeTeamId, awayTeamId, leagueId) {
    return marketProbabilities(predictFixture(model, homeTeamId, awayTeamId, leagueId));
}
