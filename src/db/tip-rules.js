// Pure "best tip" deduction: the safest bettable outcome for one fixture
// across the canonical markets (1X2, double chance, every O/U line), scored
// by a blended confidence - vig-removed market probability corroborated by
// rolling history rates and API-Football percentages. Imports ONLY M2's
// canonicalMarket (itself a zero-dependency pure module - the magic-rules ->
// perf-rules cross-pure precedent), so tests still run without .env/DB.
//
// A price floor keeps tips meaningful: near-certain markets priced at ~1.0x
// (O 0.5 against two scoring sides) are excluded - what remains at high
// confidence is the "hidden gem" the column exists to surface.
//
// Division of labor: callers filter fixtures to FINAL_STATUSES in SQL; the
// aggregates enforce non-null FT scores and kickoff strictly before the
// analyzed fixture's kickoff (the leak-free cutoff).
import { canonicalMarket } from '../markets.js';

export const DEFAULT_TIP = {
    teamWindow: 7,       // rolling last-N games per team (vs other opponents)
    minGames: 5,         // minimum sample before a team's rates count as evidence
    h2hMinMeetings: 3,   // minimum meetings before H2H rates count as evidence
    minPrice: 1.2,       // tips priced below this pay too little to matter.
                         // NB this floor is a VALUE floor, not a safety floor -
                         // it deliberately excludes the safest bets on the board.
                         // The safety product is the separate Banker output
                         // (src/db/ladder-rules.js), which has its own 1.01
                         // floor. Do not lower this one to chase accuracy: that
                         // conflates the two jobs again.
    minConfidence: 0.5,  // no tip at all below this blend
    minUnderLine: 4.5,   // no Under tips below this line (near-Unders bet against
                         // goals with no demonstrated edge: 61.9% realized vs
                         // 78.1% break-even over the 2026-07-04 cohort)
    // Markets barred from winning the candidate race - same yield-to-the-next
    // mechanism as minUnderLine above. Listed markets never become the tip.
    //
    // SHIPPED EMPTY ON PURPOSE (2026-07-26). The mechanism is built and tested;
    // the evidence for using it is NOT settled, and the two honest readings
    // disagree in SIGN:
    //   - Over the live settled ledger (1,199 tips), 12 ran -8.8% flat-stake ROI
    //     with a day-clustered 95% CI of [-16.9,-1.7], and U 3.5 -8.7%
    //     CI[-15.6,-1.6]. Both CIs exclude zero. Suppressing them there lifts
    //     ledger ROI -4.0% -> -2.2%.
    //   - Re-deriving every tip from the warehouse under the CURRENT config
    //     reverses it: 12 becomes the BEST market at -0.1% (n=59) and U 3.5
    //     -0.4% (n=165) against -6.2% for everything else, so suppressing them
    //     makes the book WORSE (-5.1% -> -5.6%).
    // The live ledger spans two config regimes (TIP_MIN_PRICE moved 1.20->1.35
    // mid-window, TIP_MIN_UNDER_LINE 4.5->3.5), which is the known ledger-split
    // trap; the re-derivation applies one config uniformly but uses history
    // depth the engine did not have at the time. Neither is clean. A result that
    // flips sign under a reasonable re-analysis is not a result.
    // Re-test once the ledger holds >= 800 settled tips generated under ONE
    // unchanged config before turning this on.
    suppressedMarkets: [],
    // Fixture-level veto: when the winning candidate's rolling-stats support
    // sits this far BELOW its devigged market probability, tip nothing.
    //
    // ALSO SHIPPED OFF (null). On the live ledger this looked strong - stats
    // 0.08-0.20 below market ran 66.7% against a 76.2% implied (-9.6pp, ROI
    // -12.5%, n=69). Re-derived under the current config it does essentially
    // nothing: -5.1% -> -4.9% ROI while discarding 44 fixtures, comfortably
    // inside the noise. Not worth the lost volume until it replicates.
    //
    // When enabled this does NOT yield to the runner-up (the runner-up is scored
    // off the same disagreeing evidence); bestTip reports the veto and the
    // caller drops the tip. Both semantics were tested; the fixture-level drop
    // measured better.
    statsVetoGap: null,
    // Beta-shrink pseudo-counts for the stats component. Every OTHER rate in the
    // codebase is shrunk (magic-rules' shrunkRate, safePrior); this one was not,
    // so a 5-game window could assert stats_prob = 1.000 outright. Observed live:
    // Petrocub-Milsami U 3.5 at 1.000 -> 5-0; Crvena Zvezda-Macva U 4.5 at 1.000
    // -> 5-0; Mjallby-Vasteraas TT:A:O 0.5 at 1.000 -> 0-0. Each component is
    // pulled toward 0.5 by its OWN sample size, so a thin side is damped harder
    // than a deep one. k=3 on a 6-7 game window turns a 1.000 into ~0.80.
    // Set to 0 to restore the pre-2026-07-26 raw means.
    //
    // k=5 was chosen by A/B over the whole 16-day window (scripts/simulate.js
    // --tipeval), NOT by taste:
    //   k=0  hit 75.8%  ROI -4.1%   (OVER -4.2%  UNDER -3.2%  RESULT -4.9%)
    //   k=3  hit 75.8%  ROI -4.6%   (OVER -4.4%  UNDER -2.8%  RESULT -6.4%)
    //   k=5  hit 76.4%  ROI -4.1%   (OVER -1.9%  UNDER -2.8%  RESULT -6.7%)
    // k=3 is strictly worse than doing nothing. k=5 is ROI-NEUTRAL against the
    // status quo and buys +0.6pp of hit rate, so it ships on correctness grounds
    // (a 5-game window must not assert certainty) at no measured cost. It is not
    // a performance win and must not be described as one.
    statsShrinkK: 5,
    // How much of the stats component comes from the fitted goal model
    // (src/db/goal-model.js) rather than the empirical rolling rates.
    // 0 = pure empirical (pre-2026-07-26 behaviour), 1 = pure model.
    // Only applies to markets the model actually covers AND when the caller
    // supplies `modelProbs`; everything else falls through to the rates.
    // SHIPPED AT 0, and the reason is the most important finding in the project.
    //
    // The goal model is a BETTER PREDICTOR than the rolling rates - it wins on
    // log-loss in 9 of 10 markets over 1,818 fixtures. It is also a WORSE BETTOR:
    //   modelWeight 0    hit 76.4%  ROI -4.1%
    //   modelWeight 0.5  hit 75.0%  ROI -6.2%
    //   modelWeight 1    hit 75.1%  ROI -5.7%
    //
    // Why: the devigged market price beats BOTH estimators on every market
    // tested. So a more accurate stats term simply agrees with the price more
    // often, and agreeing with the price means paying the vig. Betting the
    // model's disagreements is worse still, and MONOTONICALLY so - over 55,234
    // model-vs-price comparisons, ROI fell from -9.4% at any claimed edge to
    // -15.9% at edge > 0.25, every CI excluding zero. Those disagreements are
    // model error, not market error.
    //
    // The corollary is uncomfortable but load-bearing: the stats component is
    // not earning its 0.3 weight by predicting. It earns it by DECORRELATING the
    // pick from the price - dropping it entirely gives -4.5%, and pure market
    // gives -5.6%. Noise that pulls selection off the shortest (highest-vig)
    // prices helps; accuracy does not.
    //
    // Keep the model. It is the right foundation, it is coherent where the rates
    // were not, and any future work needs it. Do not raise this weight without
    // re-running scripts/simulate.js --tipeval and beating -4.1%.
    modelWeight: 0,
    // Blend weights, renormalized over the components actually available
    weights: { market: 0.6, stats: 0.3, api: 0.1 },
    // Bookmaker-trick guards (spec §4.2, M3): a family book's implied-
    // probability sum must land in this band - below minOverround smells
    // like a palpable error / boosted price, above maxOverround is margin
    // loading so heavy the devigged number is meaningless.
    minOverround: 1.01,
    maxOverround: 1.30,
    // Cross-provider devigged-probability divergence veto (any outcome)
    maxBookDivergence: 0.15,
    // How the two displayed runners-up are chosen from the ranked remainder.
    // Injected rather than imported: the real filter lives in ladder-rules.js
    // (coherentAlternatives), which imports tipOutcome from THIS module - taking
    // it as an option is what keeps that dependency one-way. Default is the
    // pre-2026-07-26 behaviour, so a caller that passes nothing is byte-compatible.
    //   (chosenMarket, rankedRemainder, limit) => candidate[]
    alternatives: (_chosen, rest, limit) => rest.slice(0, limit),
};

// League names whose history evidence is invalid for tipping: preseason
// friendlies (rotated squads, mismatched tiers - form windows come from last
// competitive season) and youth/reserve competitions (erratic lineups).
// Validated against all 296 warehouse league names 2026-07-05: 21 matches,
// all genuine, no false positives ("USL League Two", "K League 1" pass).
export const TIP_CONTEXT_EXCLUDE = /friendl|\bu-?\d{2}\b|youth|reserve|junior/i;

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
    if (!n) {
        return {
            n: 0, winRate: null, drawRate: null, lossRate: null, overRates: null,
            bttsRate: null, oddRate: null, scoredOverRates: null, concededOverRates: null,
        };
    }
    let w = 0, d = 0;
    let btts = 0, odd = 0;
    const scoredOver = Object.fromEntries(OU_LINES.map(l => [l, 0]));
    const concededOver = Object.fromEntries(OU_LINES.map(l => [l, 0]));
    for (const f of recent) {
        const [gf, ga] = f.home_team_id === teamId ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) w++;
        else if (gf === ga) d++;
        if (f.ft_home > 0 && f.ft_away > 0) btts++;
        if ((f.ft_home + f.ft_away) % 2 === 1) odd++;
        for (const l of OU_LINES) {
            if (gf > l) scoredOver[l]++;
            if (ga > l) concededOver[l]++;
        }
    }
    return {
        n,
        winRate: _round(w / n),
        drawRate: _round(d / n),
        lossRate: _round((n - w - d) / n),
        overRates: _overRates(recent),
        bttsRate: _round(btts / n),
        oddRate: _round(odd / n),
        scoredOverRates: Object.fromEntries(OU_LINES.map(l => [l, _round(scoredOver[l] / n)])),
        concededOverRates: Object.fromEntries(OU_LINES.map(l => [l, _round(concededOver[l] / n)])),
    };
}

// Fairness pairing (mirrors goals-rules pairedTeamGoalsAggregates): both
// teams judged over the SAME number of games, capped at the smaller side's
// qualifying count - mixed windows bias the blended stats support.
export function pairedTeamOutcomeAggregates(homeRows, awayRows, homeId, awayId, cutoff, window) {
    let home = teamOutcomeAggregates(homeRows, homeId, awayId, cutoff, window);
    let away = teamOutcomeAggregates(awayRows, awayId, homeId, cutoff, window);
    const cap = Math.min(home.n, away.n);
    if (home.n > cap) home = teamOutcomeAggregates(homeRows, homeId, awayId, cutoff, cap);
    if (away.n > cap) away = teamOutcomeAggregates(awayRows, awayId, homeId, cutoff, cap);
    return { home, away };
}

// Outcome rates over the pair's last-`window` finished meetings, from the
// analyzed fixture's home-team perspective.
export function h2hOutcomeAggregates(rows, homeId, awayId, cutoff, window) {
    const meetings = _qualifying(rows, cutoff)
        .filter(f => _isPair(f, homeId, awayId))
        .slice(0, window);
    const n = meetings.length;
    if (!n) {
        return {
            n: 0, homeWinRate: null, drawRate: null, awayWinRate: null, overRates: null,
            bttsRate: null, oddRate: null,
        };
    }
    let hw = 0, d = 0;
    let btts = 0, odd = 0;
    for (const f of meetings) {
        const [gf, ga] = f.home_team_id === homeId ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) hw++;
        else if (gf === ga) d++;
        if (f.ft_home > 0 && f.ft_away > 0) btts++;
        if ((f.ft_home + f.ft_away) % 2 === 1) odd++;
    }
    return {
        n,
        homeWinRate: _round(hw / n),
        drawRate: _round(d / n),
        awayWinRate: _round((n - hw - d) / n),
        overRates: _overRates(meetings),
        bttsRate: _round(btts / n),
        oddRate: _round(odd / n),
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

// Bookmaker-trick guards (spec §4.2). A family book must be complete and its
// implied-probability sum inside a sane band: below 1.0 smells like a palpable
// error / boosted price masquerading as a hidden gem; far above it is margin
// loading so heavy the devigged number is meaningless.
export function bookIntegrity(prices, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    const inv = prices.map(p => (Number(p) > 1 ? 1 / Number(p) : null));
    if (inv.some(v => v == null)) return { ok: false, overround: null, reason: 'incomplete' };
    const overround = _round(inv.reduce((a, b) => a + b, 0));
    if (overround < t.minOverround) return { ok: false, overround, reason: 'overround_low' };
    if (overround > t.maxOverround) return { ok: false, overround, reason: 'overround_high' };
    return { ok: true, overround, reason: null };
}

// Pick one provider's FULL family book (betpawa first, betika fallback -
// mixing providers inside one group breaks the vig removal), guarded by
// bookIntegrity and a cross-provider divergence veto: when both books are
// complete but disagree beyond maxBookDivergence on any outcome's devigged
// probability, one of them is likely a trap or error - no tip.
export function selectFamilyBook(providers, keys, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    const books = [];
    for (const p of ['betpawa', 'betika']) {
        const m = providers?.[p];
        if (!m || !keys.every(k => Number(m[k]) > 1)) continue;
        const prices = keys.map(k => m[k]);
        const integ = bookIntegrity(prices, t);
        books.push({ provider: p, book: Object.fromEntries(keys.map(k => [k, Number(m[k])])), ...integ, probs: _devig(prices) });
    }
    const sane = books.filter(b => b.ok);
    if (!sane.length) return { book: null, overround: books[0]?.overround ?? null, reason: books[0]?.reason ?? 'incomplete' };
    if (sane.length === 2) {
        const gap = Math.max(...keys.map((k, i) => Math.abs(sane[0].probs[i] - sane[1].probs[i])));
        if (gap > t.maxBookDivergence) return { book: null, overround: sane[0].overround, reason: 'book_divergence' };
    }
    return { book: sane[0].book, overround: sane[0].overround, reason: null };
}

// --- buildTipBooks (M3 Task 6): raw odds rows -> per-family tip books --------
// One fixture's raw odds_markets rows -> the family books bestTip/tipEligibility
// consume. Rows are canonicalized via M2's canonicalMarket and kept FULL-TIME
// only (any period-tagged descriptor is dropped). x12/dc/ou reproduce the legacy
// hotpicks _loadMarkets grouping EXACTLY (first provider carrying the full book,
// lowest price per key, NO overround band) so canonical-only fixtures keep their
// pre-M3 tips byte-for-byte - bestTip devigs those groups itself. The new
// two-way families (BTTS/DNB/odd-even/team-totals) run through selectFamilyBook,
// recording each accepted book's overround (`overrounds`) and each genuine
// refusal's reason (`rejects`, audit) - an 'incomplete' book (family simply not
// offered) is silently skipped. Team totals are routed to home/away from
// canonicalMarket's `tt` (side directly, else EXACT normalized team-name match;
// no fuzzy matching - an unresolved side is excluded).
const _X12_KEYS = ['1', 'X', '2'];
const _DC_KEYS = ['1X', 'X2', '12'];
const _OU_KEY_RE = /^[OU] \d+\.5$/;
const _SIMPLE_FT_KEYS = new Set(['1', 'X', '2', '1X', 'X2', '12', 'GG', 'NG', 'DNB1', 'DNB2', 'ODD', 'EVEN']);
const _upper = s => String(s ?? '').trim().toUpperCase();

// First provider (betpawa preferred) carrying the FULL key set, lowest price
// per key already folded in. No overround band - byte-compatible with the
// pre-M3 _loadMarkets grouping.
function _simpleGroup(providers, keys) {
    for (const p of ['betpawa', 'betika']) {
        const m = providers[p];
        if (m && keys.every(k => Number(m[k]) > 1)) {
            return Object.fromEntries(keys.map(k => [k, Number(m[k])]));
        }
    }
    return null;
}

export function buildTipBooks(oddsRows, { homeName, awayName } = {}, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    const H = _upper(homeName), A = _upper(awayName);

    // Per-provider bag of lowest canonical prices (FULL TIME only). Team-total
    // rows are side-resolved into TT:<H|A>:<ouKey> book keys here so a two-way
    // over/under book can be paired per side+line downstream.
    const providers = {};
    for (const r of oddsRows) {
        const desc = canonicalMarket(r);
        if (desc.period != null) continue;               // FT only
        let bookKey = null;
        if (_SIMPLE_FT_KEYS.has(desc.key) || _OU_KEY_RE.test(desc.key)) {
            bookKey = desc.key;
        } else if (desc.group === 'team_total') {
            const side = desc.tt?.side === 'home' ? 'H'
                : desc.tt?.side === 'away' ? 'A'
                    : desc.tt?.team && _upper(desc.tt.team) === H ? 'H'
                        : desc.tt?.team && _upper(desc.tt.team) === A ? 'A'
                            : null;
            const ouKey = desc.key.startsWith('TT:') ? desc.key.slice(3) : null; // 'O 2.5'
            if (side && ouKey && _OU_KEY_RE.test(ouKey)) bookKey = `TT:${side}:${ouKey}`;
        }
        if (!bookKey) continue;                          // untippable / unresolved -> drop
        const price = Number(r.price);                   // DECIMAL arrives as string
        const bag = (providers[r.provider] ??= {});
        if (bag[bookKey] == null || price < bag[bookKey]) bag[bookKey] = price; // lowest price
    }

    // Legacy canonical groups (byte-compat, no overround band).
    const x12 = _simpleGroup(providers, _X12_KEYS);
    const dc = _simpleGroup(providers, _DC_KEYS);
    const ou = {};
    for (const line of OU_LINES) {
        const pair = _simpleGroup(providers, [`O ${line}`, `U ${line}`]);
        if (pair) ou[line] = { over: pair[`O ${line}`], under: pair[`U ${line}`] };
    }

    // New two-way families via selectFamilyBook (integrity-screened).
    const overrounds = {}, rejects = {};
    const _family = (name, keys) => {
        const sel = selectFamilyBook(providers, keys, t);
        if (sel.book) { overrounds[name] = sel.overround; return sel.book; }
        if (sel.reason && sel.reason !== 'incomplete') rejects[name] = sel.reason;
        return null;
    };
    const btts = _family('btts', ['GG', 'NG']);
    const dnb = _family('dnb', ['DNB1', 'DNB2']);
    const oddEven = _family('oddEven', ['ODD', 'EVEN']);

    // Team totals: one two-way book per resolved (side, line). bestTip stamps a
    // single overrounds.tt on every TT candidate, so the first accepted book's
    // overround represents the family (margin transparency, not per-line).
    const tt = { H: {}, A: {} };
    let ttReject = null;
    for (const side of ['H', 'A']) {
        for (const line of OU_LINES) {
            const oKey = `TT:${side}:O ${line}`, uKey = `TT:${side}:U ${line}`;
            const sel = selectFamilyBook(providers, [oKey, uKey], t);
            if (sel.book) {
                tt[side][line] = { over: sel.book[oKey], under: sel.book[uKey] };
                if (overrounds.tt == null) overrounds.tt = sel.overround;
            } else if (sel.reason && sel.reason !== 'incomplete') {
                ttReject = ttReject || sel.reason;
            }
        }
    }
    if (overrounds.tt == null && ttReject) rejects.tt = ttReject;

    return { x12, dc, ou, btts, dnb, oddEven, tt, overrounds, rejects };
}

// Mean of the non-null components, or null when none qualify
function _mean(components) {
    const vals = components.filter(v => v != null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

// Beta-shrink one observed rate toward 0.5 by its own sample size. A rate seen
// over n games carries n pseudo-observations against k of "no information", so
// thin evidence is pulled to the middle and deep evidence is left alone. 0.5 is
// the max-entropy prior on purpose: shrinking toward the MARKET probability
// would make the stats component collinear with the market component, which is
// the one thing the blend must not do.
const _shrink = (rate, n, k) =>
    (rate == null ? null : k > 0 ? (rate * (n ?? 0) + k * 0.5) / ((n ?? 0) + k) : rate);

// Mean over [rate, sampleSize] pairs, each shrunk before averaging.
function _shrunkMean(pairs, k) {
    return _mean(pairs.map(([rate, n]) => _shrink(rate, n, k)));
}

// Cheap evidence screen run BEFORE bestTip: a fixture without enough
// independent evidence never gets a tip at all. Without it the blend silently
// renormalizes to market-only - and the market component is the bookmaker's
// own devigged opinion, which cannot beat the vig by itself (the prime
// false-positive source this gate exists to kill).
//   x12/dc/ou/btts/dnb/oddEven/tt: market groups as passed to bestTip (null /
//              {} when absent) - ANY one of the seven being present suffices
//   home/away: any aggregates carrying the qualifying sample size `n`
//              (the writer reuses the hot-gate teamGoalsAggregates results)
//   league: league name (optional) - friendly/youth/reserve competitions are
//           ineligible outright, the biggest settled-loss driver found in the
//           2026-07-05 failure analysis (-14.12u of -15.60u)
// Returns { eligible: true, reason: null } or { eligible: false, reason }
// where reason is a short marker surfaced by the web UI (<= 64 chars), e.g.
// 'insufficient_history: home 2/5' or 'no_markets'.
export function tipEligibility({ x12, dc, ou, btts, dnb, oddEven, tt, home, away, league }, opts = {}) {
    const t = { ...DEFAULT_TIP, ...opts };
    // Context invalidity trumps sample size: rolling form says nothing about
    // a preseason exhibition or a youth side's next lineup.
    if (league != null && TIP_CONTEXT_EXCLUDE.test(league)) {
        return { eligible: false, reason: 'context: friendly/youth league' };
    }
    // ONE thin side already disqualifies: the stats support for any outcome
    // blends both teams' evidence (a home-win tip needs home's win rate AND
    // away's loss rate), so a single thin sample poisons the whole blend.
    const thin = [];
    if (home.n < t.minGames) thin.push(`home ${home.n}/${t.minGames}`);
    if (away.n < t.minGames) thin.push(`away ${away.n}/${t.minGames}`);
    if (thin.length) return { eligible: false, reason: `insufficient_history: ${thin.join(', ')}` };
    const anyBook = x12 || dc || Object.keys(ou ?? {}).length
        || btts || dnb || oddEven || Object.keys(tt?.H ?? {}).length || Object.keys(tt?.A ?? {}).length;
    if (!anyBook) return { eligible: false, reason: 'no_markets' };
    return { eligible: true, reason: null };
}

const _TT_KEY = /^TT:(H|A):([OU]) (\d+\.5)$/;

// Settle any tippable market from the final score: 'hit' | 'miss' | 'void'.
// 'void' = stake returned (DNB push on a draw). Throws on unknown keys -
// a persisted unknown tip_market is a bug and must be loud (server); browser
// call sites use tipHitSafe below.
export function tipOutcome(market, ftHome, ftAway) {
    const total = ftHome + ftAway;
    const _b = v => (v ? 'hit' : 'miss');
    switch (market) {
        case '1': return _b(ftHome > ftAway);
        case 'X': return _b(ftHome === ftAway);
        case '2': return _b(ftHome < ftAway);
        case '1X': return _b(ftHome >= ftAway);
        case 'X2': return _b(ftHome <= ftAway);
        case '12': return _b(ftHome !== ftAway);
        case 'GG': return _b(ftHome > 0 && ftAway > 0);
        case 'NG': return _b(!(ftHome > 0 && ftAway > 0));
        case 'DNB1': return ftHome === ftAway ? 'void' : _b(ftHome > ftAway);
        case 'DNB2': return ftHome === ftAway ? 'void' : _b(ftHome < ftAway);
        case 'ODD': return _b(total % 2 === 1);
        case 'EVEN': return _b(total % 2 === 0);
        default: {
            const ou = /^([OU]) (\d+\.5)$/.exec(market);
            if (ou) return _b(ou[1] === 'O' ? total > Number(ou[2]) : total < Number(ou[2]));
            const tt = _TT_KEY.exec(market);
            if (!tt) throw new TypeError(`Unknown tip market: ${market}`);
            const goals = tt[1] === 'H' ? ftHome : ftAway;
            return _b(tt[2] === 'O' ? goals > Number(tt[3]) : goals < Number(tt[3]));
        }
    }
}

// Legacy boolean contract (canonical call sites): hit-or-not. A DNB void is
// NOT a hit. Still throws on unknown keys.
export function tipHit(market, ftHome, ftAway) {
    return tipOutcome(market, ftHome, ftAway) === 'hit';
}

// Never-throw variant for browser code paths (unknown/legacy keys -> null).
export function tipHitSafe(market, ftHome, ftAway) {
    try { return tipOutcome(market, ftHome, ftAway); } catch { return null; }
}

// Choose the safest bettable outcome for one fixture.
//   x12: {'1','X','2'} -> price | null; dc: {'1X','X2','12'} -> price | null
//   ou: { [line]: { over, under } } (only lines with a full pair)
//   btts: {GG,NG} -> price | null; dnb: {DNB1,DNB2} -> price | null
//   oddEven: {ODD,EVEN} -> price | null
//   tt: { H: { [line]: {over,under} }, A: { [line]: {over,under} } }
//       (team totals, FT only - one side's goals vs a line)
//   home/away: teamOutcomeAggregates(); h2h: h2hOutcomeAggregates()
//   apiPercents: { home, draw, away } fractions 0..1 | null (backs
//       result/double-chance candidates only)
//   modelProbs: { [market]: probability } | null - fitted goal-model output
//       (goal-model.js marketProbabilities). Supplies the stats component for
//       every market it covers, blended at opts.modelWeight.
//   overrounds: { [family]: number } | undefined - each new family's
//       devigged-book overround (selectFamilyBook), surfaced back as
//       book_overround on the winning pick + each runner-up (spec §4.2
//       margin transparency). Books arrive ALREADY integrity-screened by
//       the caller; bestTip itself does no book validation. The legacy
//       x12/dc/ou candidates never carry an overround (byte-compat).
// Returns { market, price, confidence, market_prob, stats_prob, api_prob,
// weights, samples, runners_up, book_overround? } - weights are the
// renormalized blend weights actually applied, samples the evidence sizes,
// runners_up the next two candidates (justification breakdown persisted as
// fixture_predictions.tip_breakdown) - or null when nothing clears the
// price/confidence floors.
export function bestTip({ x12, dc, ou, btts, dnb, oddEven, tt, home, away, h2h, apiPercents, overrounds, modelProbs }, opts = {}) {
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
    const k = t.statsShrinkK ?? 0;
    const _sm = pairs => _shrunkMean(pairs, k);
    const statsProb = {
        1: _sm([[hOk ? home.winRate : null, home.n], [aOk ? away.lossRate : null, away.n], [hhOk ? h2h.homeWinRate : null, h2h.n]]),
        X: _sm([[hOk ? home.drawRate : null, home.n], [aOk ? away.drawRate : null, away.n], [hhOk ? h2h.drawRate : null, h2h.n]]),
        2: _sm([[hOk ? home.lossRate : null, home.n], [aOk ? away.winRate : null, away.n], [hhOk ? h2h.awayWinRate : null, h2h.n]]),
    };
    statsProb['1X'] = statsProb['2'] == null ? null : 1 - statsProb['2'];
    statsProb['X2'] = statsProb['1'] == null ? null : 1 - statsProb['1'];
    statsProb['12'] = statsProb['X'] == null ? null : 1 - statsProb['X'];
    const statsOver = line => _sm([
        [hOk ? home.overRates[line] : null, home.n],
        [aOk ? away.overRates[line] : null, away.n],
        [hhOk ? h2h.overRates[line] : null, h2h.n],
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
    const suppressed = new Set(t.suppressedMarkets ?? []);
    // The stats component, resolved. A fitted goal model answers ONE question
    // (how many goals will each side score?) and reads every market off the
    // answer, so its numbers are mutually coherent - P(O 1.5) >= P(O 2.5) always.
    // The empirical rates could not promise that: each line was a separate count
    // over ~6 games, i.e. a 17-point grid, and adjacent lines could contradict.
    // Where the model has an opinion it is blended in at modelWeight; where it
    // does not, the rates stand unchanged.
    const _stats = (market, empirical) => {
        const mp = modelProbs?.[market];
        if (mp == null) return empirical;
        if (empirical == null) return _round(mp);
        const w = Math.min(1, Math.max(0, t.modelWeight ?? 0));
        return _round(w * mp + (1 - w) * empirical);
    };
    const consider = (market, price, mkt, stats, apiP, overround) => {
        stats = _stats(market, stats);
        if (mkt == null || !(Number(price) >= t.minPrice)) return;
        // Barred markets yield to the next-best candidate, exactly like a
        // sub-minUnderLine Under does. They are never merely down-ranked -
        // a market with a CI entirely below zero has no rank worth having.
        if (suppressed.has(market)) return;
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
            // Family book overround (spec §4.2 margin transparency) - only
            // stamped when the caller supplies one. The legacy x12/dc/ou
            // blocks below never pass this arg, so their candidates carry
            // no such key (byte-compat with the pre-M3 return shape).
            ...(overround != null ? { overround } : {}),
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
        // Near-Unders are excluded (see DEFAULT_TIP.minUnderLine); suppressed
        // lines simply yield to the next-best candidate.
        if (Number(line) >= t.minUnderLine) {
            consider(`U ${line}`, pair.under, probs[1], over == null ? null : 1 - over, null);
        }
    }

    // -- new-family candidates (M3): BTTS, draw-no-bet, odd/even, team totals --

    if (btts) {
        const probs = _devig([btts.GG, btts.NG]);
        if (probs) {
            const gg = _sm([[hOk ? home.bttsRate : null, home.n], [aOk ? away.bttsRate : null, away.n], [hhOk ? h2h.bttsRate : null, h2h.n]]);
            consider('GG', btts.GG, probs[0], gg, null, overrounds?.btts);
            consider('NG', btts.NG, probs[1], gg == null ? null : 1 - gg, null, overrounds?.btts);
        }
    }
    if (dnb) {
        const probs = _devig([dnb.DNB1, dnb.DNB2]);
        if (probs) {
            // Renormalized win-vs-win: a draw voids DNB, so the two win
            // probabilities alone (not the draw-inclusive 1/2 shares) decide
            // which side is favored - null when either side is unqualified.
            const w1 = statsProb['1'], w2 = statsProb['2'];
            const dnb1 = w1 != null && w2 != null && (w1 + w2) > 0 ? w1 / (w1 + w2) : null;
            consider('DNB1', dnb.DNB1, probs[0], dnb1, null, overrounds?.dnb);
            consider('DNB2', dnb.DNB2, probs[1], dnb1 == null ? null : 1 - dnb1, null, overrounds?.dnb);
        }
    }
    if (oddEven) {
        const probs = _devig([oddEven.ODD, oddEven.EVEN]);
        if (probs) {
            const odd = _sm([[hOk ? home.oddRate : null, home.n], [aOk ? away.oddRate : null, away.n], [hhOk ? h2h.oddRate : null, h2h.n]]);
            consider('ODD', oddEven.ODD, probs[0], odd, null, overrounds?.oddEven);
            consider('EVEN', oddEven.EVEN, probs[1], odd == null ? null : 1 - odd, null, overrounds?.oddEven);
        }
    }
    for (const side of ['H', 'A']) {
        for (const [line, pair] of Object.entries(tt?.[side] ?? {})) {
            const probs = _devig([pair.over, pair.under]);
            if (!probs) continue;
            const scoredSide = side === 'H' ? home : away, otherSide = side === 'H' ? away : home;
            const over = _sm([
                [(side === 'H' ? hOk : aOk) ? scoredSide.scoredOverRates?.[line] : null, scoredSide.n],
                [(side === 'H' ? aOk : hOk) ? otherSide.concededOverRates?.[line] : null, otherSide.n],
            ]);
            consider(`TT:${side}:O ${line}`, pair.over, probs[0], over, null, overrounds?.tt);
            // minUnderLine does NOT apply to TT Unders - it is a total-goals
            // rule and team-total lines are 0.5-3.5 by nature; only the
            // global minPrice floor (enforced inside consider) applies here.
            consider(`TT:${side}:U ${line}`, pair.under, probs[1], over == null ? null : 1 - over, null, overrounds?.tt);
        }
    }

    if (!candidates.length) return null;
    candidates.sort((a, b) => b.confidence - a.confidence || b.price - a.price);
    if (candidates[0].confidence < t.minConfidence) return null;
    // Surface the internal `overround` field as `book_overround` on the way
    // out (spec §4.2 margin transparency). Candidates without one (every
    // legacy x12/dc/ou pick, and any new-family pick when the caller didn't
    // supply overrounds) pass through unchanged - the byte-compat gate for
    // canonical-only callers turns on this being a no-op in that case.
    const _surfaceOverround = c => {
        if (c.overround == null) return c;
        const { overround, ...rest } = c;
        return { ...rest, book_overround: overround };
    };
    // One-sided stats veto (see DEFAULT_TIP.statsVetoGap). Reported, not
    // enforced: bestTip stays a calculator and the caller decides what a veto
    // means (hotpicks drops the tip and records the reason). That split keeps
    // the whole candidate breakdown inspectable in tests instead of collapsing
    // to a bare null.
    const winner = candidates[0];
    const gap = winner.stats_prob == null || winner.market_prob == null
        ? null
        : _round(winner.stats_prob - winner.market_prob);
    const veto = t.statsVetoGap != null && gap != null && gap < t.statsVetoGap
        ? 'stats_below_market'
        : null;

    return {
        ..._surfaceOverround(winner),
        samples: { home_n: home.n, away_n: away.n, h2h_n: h2h.n },
        // Distance between our stats support and the book's own number. Kept on
        // every tip (not just vetoed ones) so the ledger can measure the rule
        // that is now acting on it.
        stats_gap: gap,
        ...(veto ? { veto } : {}),
        // "Close alternatives" must actually BE alternatives. Measured over the
        // 1,199-tip ledger, 2.6% of displayed candidate pairs were logically
        // contradictory (O 2.5 beside U 2.5) and 6.3% were nested (O 1.5 beside
        // O 2.5 - the same call at a different rung, which is the Banker's job).
        // The filter is injected via opts.alternatives; see DEFAULT_TIP.
        runners_up: t.alternatives(winner.market, candidates.slice(1), 2).map(_surfaceOverround),
    };
}
