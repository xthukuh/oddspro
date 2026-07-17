import { config } from './config.js';
import { db } from './db/connection.js';
import { FINAL_STATUSES } from './apisports.js';
import {
    pairedTeamGoalsAggregates, h2hGoalsAggregates, impliedProbability,
    apiPredictionSignal, scoreOverLine, LINE_THRESHOLDS,
} from './db/goals-rules.js';
import { pairedTeamOutcomeAggregates, h2hOutcomeAggregates, tipEligibility, bestTip, tipOutcome, buildTipBooks } from './db/tip-rules.js';
import { summarizePerformance } from './db/perf-rules.js';
import { aiEnabled, aiModelTag } from './ai/adjudicators.js';
import { canReuseHotVerdict, hotReviewPending, tipReviewPending } from './db/adjudicate-rules.js';
import { effective } from './settings.js';
import { debugLog } from './utils.js';

// Over 2.5 hot picks ledger (fixture_predictions): every upcoming correlated
// fixture with a pre-match snapshot gets an evaluated row (signals kept for
// calibration); `hot` marks full rule concurrence. Rows are upserted on every
// run while the fixture is upcoming; the `kickoff > NOW()` selection IS the
// freeze - past fixtures are never selected again, so the pick that stood at
// kickoff stands forever. Settlement (result_goals/outcome) is owned by the
// settle pass here and excluded from the compute upsert's merge list.
//
// AI adjudication lives in the background AI-review worker (src/ai-worker.js;
// `node src/index.js aireview` drains it manually). The sweep bills nothing:
// it only counts pending reviews and re-applies a still-reusable stored VETO
// (read-only - the AI can veto, never promote).

// Everything the compute pass owns. Settle owns result_goals/outcome and
// tip_outcome; the AI-review worker owns the 8 verdict columns (ai_verdict/
// ai_reason/ai_model/ai_review + the tip_ai_* mirrors) - excluding them here
// is what makes sweep and worker unable to clobber each other, and it also
// fixes the old bug where beyond-cap candidates had their stored verdicts
// NULLed on every sweep.
const PICK_COLUMNS = [
    'market', 'hot', 'score', 'signals', 'over_price', 'under_price', 'implied_over',
    'api_advice_supports',
    'tip_market', 'tip_price', 'tip_confidence', 'tip_breakdown', 'tip_skip_reason',
    'computed_at',
];

// Per-fixture tip books: pull this fixture set's non-stale odds rows, group
// them per fixture, and delegate the family-book assembly to buildTipBooks
// (pure, M2 canonicalMarket-keyed). x12/dc/ou keep the legacy grouping (betpawa
// first, lowest price, no overround band) for byte-compat; the new families
// (BTTS/DNB/odd-even/team-totals) are integrity-screened with overrounds/rejects
// recorded. Team-total side resolution needs the team names, so the caller
// passes namesById (fixture_id -> {homeName, awayName}). Returns
// Map(fixture_id -> buildTipBooks(...) result).
async function _loadMarkets(fixtureIds, namesById) {
    const rows = await db('odds_markets as om')
        .join('matches as m', 'm.id', 'om.match_id')
        .whereIn('m.fixture_id', fixtureIds)
        .where('om.is_stale', 0)
        .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price');
    const byFixture = new Map();
    for (const r of rows) {
        let list = byFixture.get(r.fixture_id);
        if (!list) byFixture.set(r.fixture_id, list = []);
        list.push(r);
    }
    const books = new Map();
    for (const [fixture_id, fixtureRows] of byFixture) {
        books.set(fixture_id, buildTipBooks(fixtureRows, namesById?.get(fixture_id) ?? {}, {
            minOverround: config.TIP_MIN_OVERROUND,
            maxOverround: config.TIP_MAX_OVERROUND,
            maxBookDivergence: config.TIP_MAX_BOOK_DIVERGENCE,
        }));
    }
    return books;
}

// Settle pending hot-pick and tip outcomes from canonical final scores -
// hit/miss/void decided exactly once. Cheap (pure SQL + tipOutcome loop, no
// external fetches, no AI), so the auto-refresh light pass can call it standalone.
export async function settleHotPicks() {
    const finalsIn = FINAL_STATUSES.map(() => '?').join(',');
    // Line-aware (M3): p.market is 'O <line>' (e.g. 'O 2.5', 'O 1.5');
    // SUBSTRING(p.market, 3) strips the 'O ' prefix to the line text, cast
    // to a comparable decimal. total > 2.5 === today's total >= 3 for the
    // legacy 2.5-only ledger (integer goals), so this is a no-op for every
    // row written before HOTPICK_LINES ever offered a non-2.5 line. Only
    // touches p.outcome IS NULL rows - settled rows are never revisited.
    const [settledRes] = await db.raw(
        `UPDATE fixture_predictions p JOIN fixtures f ON f.id = p.fixture_id
         SET p.result_goals = COALESCE(f.ft_home, f.goals_home) + COALESCE(f.ft_away, f.goals_away),
             p.outcome = IF(
                 COALESCE(f.ft_home, f.goals_home) + COALESCE(f.ft_away, f.goals_away)
                     > CAST(SUBSTRING(p.market, 3) AS DECIMAL(4,2)),
                 'hit', 'miss')
         WHERE p.outcome IS NULL AND f.status IN (${finalsIn})
           AND COALESCE(f.ft_home, f.goals_home) IS NOT NULL
           AND COALESCE(f.ft_away, f.goals_away) IS NOT NULL`,
        FINAL_STATUSES
    );
    const settled = settledRes.affectedRows ?? 0;

    // Settle tips the same way: any tippable market resolves from the final
    // score (pure tipOutcome); grouped into three whereIn updates. A DNB push
    // on a draw settles 'void' (stake returned - neither hit nor miss).
    const pendingTips = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNull('p.tip_outcome').whereNotNull('p.tip_market')
        .whereIn('f.status', FINAL_STATUSES)
        .select('p.fixture_id', 'p.tip_market',
            db.raw('COALESCE(f.ft_home, f.goals_home) as fh'),
            db.raw('COALESCE(f.ft_away, f.goals_away) as fa'));
    const buckets = { hit: [], miss: [], void: [] };
    for (const t of pendingTips) {
        if (t.fh == null || t.fa == null) continue;
        buckets[tipOutcome(t.tip_market, t.fh, t.fa)].push(t.fixture_id);
    }
    for (const [outcome, ids] of Object.entries(buckets)) {
        for (let i = 0; i < ids.length; i += 200) {
            await db('fixture_predictions').whereIn('fixture_id', ids.slice(i, i + 200))
                .update({ tip_outcome: outcome });
        }
    }
    const tips_settled = buckets.hit.length + buckets.miss.length + buckets.void.length;
    return { settled, tips_settled };
}

// Bulk history loader: every FINAL fixture involving any of `teamIds`,
// grouped per team (a team's own list carries games from EITHER side it
// played, same bulk load shape as prematch.js). Status filtered in SQL; the
// pure aggregates (goals-rules.js) enforce scores + kickoff cutoff per row.
// Exported and shared with src/enrich.js's AI-enrichment rolling-stats
// projection (M4.1 final review finding 1) - the "recent form" a fixture
// carries must come from ONE warehouse machinery, never a second, drifting
// definition duplicated between hot-pick evaluation and the AI prompts.
export async function loadTeamHistory(teamIds) {
    if (!teamIds.length) return new Map();
    const history = await db('fixtures')
        .whereIn('status', FINAL_STATUSES)
        .where(q => q.whereIn('home_team_id', teamIds).orWhereIn('away_team_id', teamIds))
        .select('home_team_id', 'away_team_id', 'ft_home', 'ft_away', 'kickoff');
    const targetTeams = new Set(teamIds);
    const fixturesByTeam = new Map();
    for (const f of history) {
        for (const team of [f.home_team_id, f.away_team_id]) {
            if (!targetTeams.has(team)) continue;
            let list = fixturesByTeam.get(team);
            if (!list) fixturesByTeam.set(team, list = []);
            list.push(f);
        }
    }
    return fixturesByTeam;
}

// Settle + (re)compute hot picks for all upcoming correlated fixtures.
export async function updateHotPicks() {
    const t0 = Date.now();
    // Settle first: canonical final scores decide hit/miss exactly once.
    const { settled, tips_settled } = await settleHotPicks();
    const tSettle = Date.now();

    // The pre-match snapshot EXISTS guard also guarantees the history
    // backfill ran for these fixtures (pipeline order), so the rolling
    // windows below are served from complete local history.
    const targets = await db('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .whereRaw('EXISTS (SELECT 1 FROM fixture_prematch p WHERE p.fixture_id = f.id)')
        .select('f.id', 'f.kickoff', 'f.home_team_id', 'f.away_team_id',
            'l.name as league', 'th.name as home_name', 'ta.name as away_name');
    console.debug(`Hot picks - ${settled} settled (${tips_settled} tips); ${targets.length} upcoming correlated fixtures to evaluate...`);
    if (!targets.length) {
        return {
            settled, tips_settled, fixtures: 0, written: 0, hot: 0, tips: 0, tips_skipped: 0,
            pending_reviews: { hot: 0, tips: 0 },
        };
    }

    const fixtureIds = targets.map(f => f.id);
    const teamIds = [...new Set(targets.flatMap(f => [f.home_team_id, f.away_team_id]))];

    // Finished fixtures involving any target team, grouped per team.
    const fixturesByTeam = await loadTeamHistory(teamIds);

    const namesById = new Map(targets.map(f => [f.id, { homeName: f.home_name, awayName: f.away_name }]));
    const markets = await _loadMarkets(fixtureIds, namesById);
    const apiPreds = new Map((await db('fixture_api_predictions').whereIn('fixture_id', fixtureIds))
        .map(p => [p.fixture_id, p]));
    // Existing verdict rows (worker-owned columns, read-only here): re-apply
    // a still-reusable stored VETO and count what the worker has pending.
    const existing = new Map((await db('fixture_predictions').whereIn('fixture_id', fixtureIds)
        .select('fixture_id', 'ai_verdict', 'ai_model', 'ai_review',
            'tip_ai_verdict', 'tip_ai_model', 'tip_ai_review'))
        .map(p => [p.fixture_id, p]));
    const tLoad = Date.now();

    const thresholds = {
        teamWindow: config.HOTPICK_TEAM_WINDOW,
        minGames: config.HOTPICK_MIN_GAMES,
        minOverRate: config.HOTPICK_MIN_OVER_RATE,
        minAvgTotal: config.HOTPICK_MIN_AVG_TOTAL,
        minImpliedOver: config.HOTPICK_MIN_IMPLIED_OVER,
        h2hMinOverRate: config.HOTPICK_H2H_MIN_OVER_RATE,
    };

    const rows = [];
    for (const f of targets) {
        const cutoff = new Date(f.kickoff).getTime();
        const homeRows = fixturesByTeam.get(f.home_team_id) ?? [];
        const awayRows = fixturesByTeam.get(f.away_team_id) ?? [];
        const groups = markets.get(f.id)
            ?? { x12: null, dc: null, ou: {}, btts: null, dnb: null, oddEven: null, tt: { H: {}, A: {} }, overrounds: {}, rejects: {} };
        const apiPred = apiPreds.get(f.id);
        // Fairness pairing: both teams judged over the SAME window, capped
        // at the smaller side's qualifying count (see goals-rules).
        const pair = pairedTeamGoalsAggregates(homeRows, awayRows,
            f.home_team_id, f.away_team_id, cutoff, thresholds.teamWindow);
        const h2h = h2hGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, config.PREMATCH_H2H_WINDOW);

        // Over/under hot-pick evaluation (M3, scoreOverLine): the row's
        // ledger baseline is ALWAYS the 2.5 evaluation, exactly as before M3
        // (byte-compat with today's behavior at default config). Every OTHER
        // configured line (HOTPICK_LINES) with both a full O/U pair AND a
        // LINE_THRESHOLDS entry (a line without one can never fire hot) is
        // also scored; it replaces the row's hot columns only when it fires
        // hot with a STRICTLY higher score than the current best.
        const baseP = groups.ou[2.5] ?? null;
        const baseMarket = baseP ? { ...baseP, impliedOver: impliedProbability(baseP.over, baseP.under) } : null;
        const baseApi = apiPredictionSignal(apiPred);
        const baseOut = scoreOverLine({ home: pair.home, away: pair.away, h2h, market: baseMarket, api: baseApi }, 2.5, thresholds);
        let best = { line: 2.5, p: baseP, market: baseMarket, api: baseApi, out: baseOut };
        for (const line of config.HOTPICK_LINES) {
            if (line === 2.5 || !(line in LINE_THRESHOLDS)) continue;
            const lp = groups.ou[line] ?? null;
            if (!lp) continue; // no full O/U pair at this line - nothing to evaluate
            const lMarket = { ...lp, impliedOver: impliedProbability(lp.over, lp.under) };
            const lApi = apiPredictionSignal(apiPred, line);
            const lOut = scoreOverLine({ home: pair.home, away: pair.away, h2h, market: lMarket, api: lApi }, line, thresholds);
            if (lOut.hot && lOut.score > best.out.score) {
                best = { line, p: lp, market: lMarket, api: lApi, out: lOut };
            }
        }
        const out = best.out;

        // Safest bettable outcome across every canonical market (the "Tip"
        // column) - independent of the hot verdict, same leak-free windows.
        // Eligibility screens first: thin-evidence fixtures skip the tip
        // computation entirely and record why (a market-only blend is just
        // the bookmaker's own opinion - the prime false-positive source).
        // Eligibility judges the UNCAPPED per-side pools so the skip reason
        // names the side that is actually thin (pairing would mask it).
        // League name feeds the context gate (friendly/youth = no tip).
        const elig = tipEligibility(
            { ...groups, home: { n: pair.pool.home_n }, away: { n: pair.pool.away_n }, league: f.league },
            { minGames: thresholds.minGames });
        let tip = null;
        if (elig.eligible) {
            const apiPct = apiPred && apiPred.percent_home != null && apiPred.percent_draw != null && apiPred.percent_away != null
                ? {
                    home: Number(apiPred.percent_home) / 100,
                    draw: Number(apiPred.percent_draw) / 100,
                    away: Number(apiPred.percent_away) / 100,
                }
                : null;
            tip = bestTip({
                ...groups,
                ...pairedTeamOutcomeAggregates(homeRows, awayRows,
                    f.home_team_id, f.away_team_id, cutoff, thresholds.teamWindow),
                h2h: h2hOutcomeAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, config.PREMATCH_H2H_WINDOW),
                apiPercents: apiPct,
            }, {
                teamWindow: thresholds.teamWindow,
                minGames: thresholds.minGames,
                minPrice: config.TIP_MIN_PRICE,
                minConfidence: config.TIP_MIN_CONFIDENCE,
                minUnderLine: config.TIP_MIN_UNDER_LINE,
            });
        }
        const row = {
            fixture_id: f.id,
            market: `O ${best.line}`,
            hot: out.hot,
            score: out.score,
            signals: JSON.stringify(out.signals),
            over_price: best.p?.over ?? null,
            under_price: best.p?.under ?? null,
            implied_over: best.market?.impliedOver ?? null,
            api_advice_supports: out.api_supports,
            tip_market: tip?.market ?? null,
            tip_price: tip?.price ?? null,
            tip_confidence: tip?.confidence ?? null,
            tip_breakdown: tip ? JSON.stringify(tip) : null,
            // 'no_pick' = eligible but nothing cleared the price/confidence
            // floors - distinguishable from "not enough data" in the UI
            tip_skip_reason: (elig.eligible ? (tip ? null : 'no_pick') : elig.reason)?.substring(0, 64) ?? null,
            computed_at: db.fn.now(),
        };
        // Read-only veto re-apply: a stored AI veto that is still reusable
        // for THIS evaluation (same judged score + model tag) keeps standing
        // without a call - the AI can veto, never promote. A stale or legacy
        // veto does not demote; the worker re-adjudicates it anyway.
        if (row.hot && canReuseHotVerdict(existing.get(f.id), row.score, aiModelTag())
            && existing.get(f.id).ai_verdict === 'veto') {
            row.hot = false;
        }
        rows.push(row);
    }
    const tCompute = Date.now();

    // Single-statement upsert per chunk: no delete+insert, no deadlock exposure
    for (let i = 0; i < rows.length; i += 200) {
        await db('fixture_predictions').insert(rows.slice(i, i + 200))
            .onConflict('fixture_id').merge(PICK_COLUMNS);
    }
    const tUpsert = Date.now();

    // What the AI-review worker has left to do for these rows - counted with
    // the SAME pure predicates the worker's queue uses, so the number shown
    // can never drift from the work actually pending. No AI key = the worker
    // is a no-op, so nothing is "pending".
    const pending_reviews = { hot: 0, tips: 0 };
    if (aiEnabled()) {
        const tag = aiModelTag();
        const tol = Number(effective('TIP_AI_REUSE_PRICE_TOL'));
        for (const row of rows) {
            const merged = { ...existing.get(row.fixture_id), ...row };
            if (hotReviewPending(merged, tag)) pending_reviews.hot++;
            if (tipReviewPending(merged, tag, { minConfidence: config.TIP_AI_MIN_CONFIDENCE, priceTol: tol })) {
                pending_reviews.tips++;
            }
        }
    }
    debugLog(`hotpicks: settle ${tSettle - t0}ms, load ${tLoad - tSettle}ms, `
        + `compute ${tCompute - tLoad}ms, upsert ${tUpsert - tCompute}ms `
        + `(${rows.length} rows; pending reviews hot=${pending_reviews.hot} tips=${pending_reviews.tips})`);

    return {
        settled, tips_settled,
        fixtures: targets.length,
        written: rows.length,
        hot: rows.filter(r => r.hot).length,
        tips: rows.filter(r => r.tip_market != null).length,
        tips_skipped: rows.filter(r => r.tip_skip_reason != null && r.tip_skip_reason !== 'no_pick').length,
        pending_reviews,
    };
}

// ROI / hit-rate / bucket report over the whole pick ledger (pure calc in
// src/db/perf-rules.js). Backs GET /api/performance and the CLI action.
export async function performanceSummary() {
    const rows = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .where(q => q.where('p.hot', 1).orWhere('p.ai_verdict', 'veto').orWhereNotNull('p.tip_market'))
        .select('f.kickoff', 'p.hot', 'p.score', 'p.outcome', 'p.over_price', 'p.ai_verdict',
            'p.tip_market', 'p.tip_price', 'p.tip_confidence', 'p.tip_outcome', 'p.tip_ai_verdict');
    return summarizePerformance(rows);
}

// Accuracy summary for the web header chip + hot list (GET /api/hotpicks).
export async function hotpicksSummary() {
    const [[agg]] = await db.raw(
        `SELECT
            COALESCE(SUM(p.outcome = 'hit'), 0)  AS hits_all,
            COALESCE(SUM(p.outcome = 'miss'), 0) AS misses_all,
            COALESCE(SUM(f.kickoff >= NOW() - INTERVAL 7 DAY AND p.outcome = 'hit'), 0)   AS hits_7d,
            COALESCE(SUM(f.kickoff >= NOW() - INTERVAL 7 DAY AND p.outcome = 'miss'), 0)  AS misses_7d,
            COALESCE(SUM(f.kickoff >= NOW() - INTERVAL 30 DAY AND p.outcome = 'hit'), 0)  AS hits_30d,
            COALESCE(SUM(f.kickoff >= NOW() - INTERVAL 30 DAY AND p.outcome = 'miss'), 0) AS misses_30d,
            COALESCE(SUM(p.outcome IS NULL), 0) AS pending
         FROM fixture_predictions p JOIN fixtures f ON f.id = p.fixture_id
         WHERE p.hot = 1`
    );
    const _window = (hits, misses) => {
        const picks = Number(hits) + Number(misses);
        return { picks, hits: Number(hits), misses: Number(misses), rate: picks ? Number(hits) / picks : null };
    };
    const upcoming = await db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .where('p.hot', 1).whereNull('p.outcome')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .orderBy('f.kickoff')
        .select('p.fixture_id', 'f.kickoff', 'p.score', 'p.ai_verdict', 'p.ai_reason',
            db.raw("CONCAT(th.name, ' - ', ta.name) as fixture"));
    // AI-review worker backlog, counted with the worker's own predicates
    // (adjudicate-rules) so the visible pending state can never drift from
    // the queue. One light query over upcoming reviewable rows.
    const pending_reviews = { hot: 0, tips: 0 };
    if (aiEnabled()) {
        const tag = aiModelTag();
        const tol = Number(effective('TIP_AI_REUSE_PRICE_TOL'));
        const reviewable = await db('fixture_predictions as p')
            .join('fixtures as f', 'f.id', 'p.fixture_id')
            .where('f.kickoff', '>', db.raw('NOW()'))
            .where(q => q.where('p.hot', 1).orWhereNotNull('p.tip_market'))
            .select('p.hot', 'p.score', 'p.ai_verdict', 'p.ai_model', 'p.ai_review',
                'p.tip_market', 'p.tip_price', 'p.tip_confidence',
                'p.tip_ai_verdict', 'p.tip_ai_model', 'p.tip_ai_review');
        for (const r of reviewable) {
            if (hotReviewPending(r, tag)) pending_reviews.hot++;
            if (tipReviewPending(r, tag, { minConfidence: config.TIP_AI_MIN_CONFIDENCE, priceTol: tol })) {
                pending_reviews.tips++;
            }
        }
    }
    return {
        windows: {
            '7d': _window(agg.hits_7d, agg.misses_7d),
            '30d': _window(agg.hits_30d, agg.misses_30d),
            all: _window(agg.hits_all, agg.misses_all),
        },
        pending: Number(agg.pending),
        pending_reviews,
        upcoming: upcoming.map(u => ({ ...u, score: u.score == null ? null : Number(u.score) })),
    };
}
