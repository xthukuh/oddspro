import { config } from './config.js';
import { db } from './db/connection.js';
import { FINAL_STATUSES } from './apisports.js';
import { whereMarket } from './markets.js';
import {
    teamGoalsAggregates, h2hGoalsAggregates, impliedProbability,
    apiPredictionSignal, scoreOver25,
} from './db/goals-rules.js';
import { aiEnabled, adjudicateHotPick } from './ai.js';
import { _batch, _progress } from './utils.js';

// Over 2.5 hot picks ledger (fixture_predictions): every upcoming correlated
// fixture with a pre-match snapshot gets an evaluated row (signals kept for
// calibration); `hot` marks full rule concurrence, optionally adjudicated by
// the OpenRouter AI (env-gated, fail-open). Rows are upserted on every run
// while the fixture is upcoming; the `kickoff > NOW()` selection IS the
// freeze - past fixtures are never selected again, so the pick that stood at
// kickoff stands forever. Settlement (result_goals/outcome) is owned by the
// settle pass here and excluded from the compute upsert's merge list.

// Everything the compute pass owns (settle owns result_goals/outcome)
const PICK_COLUMNS = [
    'market', 'hot', 'score', 'signals', 'over_price', 'under_price', 'implied_over',
    'api_advice_supports', 'ai_verdict', 'ai_reason', 'ai_model', 'computed_at',
];

// Best available O/U 2.5 price pair per fixture: betpawa first, betika only
// when betpawa lacks a full book (betika odds carry no probability metadata
// but its prices still make a valid two-way normalization).
async function _loadMarketPrices(fixtureIds) {
    const byFixture = new Map();
    for (const [key, side] of [['O 2.5', 'over'], ['U 2.5', 'under']]) {
        const rows = await whereMarket(
            db('odds_markets as om')
                .join('matches as m', 'm.id', 'om.match_id')
                .whereIn('m.fixture_id', fixtureIds)
                .where('om.is_stale', 0)
                .select('m.fixture_id', 'm.provider', 'om.price'),
            key
        );
        for (const r of rows) {
            let providers = byFixture.get(r.fixture_id);
            if (!providers) byFixture.set(r.fixture_id, providers = {});
            (providers[r.provider] ??= {})[side] = Number(r.price); // DECIMAL arrives as string
        }
    }
    const best = new Map();
    for (const [fixture_id, providers] of byFixture) {
        const complete = ['betpawa', 'betika'].find(p => providers[p]?.over && providers[p]?.under);
        const pick = providers[complete] ?? providers.betpawa ?? providers.betika;
        if (pick) best.set(fixture_id, pick);
    }
    return best;
}

// Settle + (re)compute hot picks for all upcoming correlated fixtures.
export async function updateHotPicks() {
    // Settle first: canonical final scores decide hit/miss exactly once.
    const finalsIn = FINAL_STATUSES.map(() => '?').join(',');
    const [settledRes] = await db.raw(
        `UPDATE fixture_predictions p JOIN fixtures f ON f.id = p.fixture_id
         SET p.result_goals = COALESCE(f.ft_home, f.goals_home) + COALESCE(f.ft_away, f.goals_away),
             p.outcome = IF(COALESCE(f.ft_home, f.goals_home) + COALESCE(f.ft_away, f.goals_away) >= 3, 'hit', 'miss')
         WHERE p.outcome IS NULL AND f.status IN (${finalsIn})
           AND COALESCE(f.ft_home, f.goals_home) IS NOT NULL
           AND COALESCE(f.ft_away, f.goals_away) IS NOT NULL`,
        FINAL_STATUSES
    );
    const settled = settledRes.affectedRows ?? 0;

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
    console.debug(`Hot picks - ${settled} settled; ${targets.length} upcoming correlated fixtures to evaluate...`);
    if (!targets.length) return { settled, fixtures: 0, written: 0, hot: 0, ai: { confirmed: 0, vetoed: 0, errors: 0 } };

    const fixtureIds = targets.map(f => f.id);
    const teamIds = [...new Set(targets.flatMap(f => [f.home_team_id, f.away_team_id]))];

    // Finished fixtures involving any target team, grouped per team (same
    // bulk load as prematch.js). Status filtered in SQL; the calc enforces
    // scores + kickoff cutoff per row.
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

    const prices = await _loadMarketPrices(fixtureIds);
    const apiPreds = new Map((await db('fixture_api_predictions').whereIn('fixture_id', fixtureIds))
        .map(p => [p.fixture_id, p]));
    // Existing rows: reuse AI verdicts when the evaluation is unchanged
    const existing = new Map((await db('fixture_predictions').whereIn('fixture_id', fixtureIds)
        .select('fixture_id', 'score', 'ai_verdict', 'ai_reason', 'ai_model'))
        .map(p => [p.fixture_id, p]));

    const thresholds = {
        teamWindow: config.HOTPICK_TEAM_WINDOW,
        minGames: config.HOTPICK_MIN_GAMES,
        minOverRate: config.HOTPICK_MIN_OVER_RATE,
        minAvgTotal: config.HOTPICK_MIN_AVG_TOTAL,
        minImpliedOver: config.HOTPICK_MIN_IMPLIED_OVER,
        h2hMinOverRate: config.HOTPICK_H2H_MIN_OVER_RATE,
    };

    const rows = [], candidates = [];
    for (const f of targets) {
        const cutoff = new Date(f.kickoff).getTime();
        const homeRows = fixturesByTeam.get(f.home_team_id) ?? [];
        const awayRows = fixturesByTeam.get(f.away_team_id) ?? [];
        const p = prices.get(f.id) ?? null;
        const market = p ? { ...p, impliedOver: impliedProbability(p.over, p.under) } : null;
        const api = apiPredictionSignal(apiPreds.get(f.id));
        const out = scoreOver25({
            home: teamGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, thresholds.teamWindow),
            away: teamGoalsAggregates(awayRows, f.away_team_id, f.home_team_id, cutoff, thresholds.teamWindow),
            h2h: h2hGoalsAggregates(homeRows, f.home_team_id, f.away_team_id, cutoff, config.PREMATCH_H2H_WINDOW),
            market, api,
        }, thresholds);
        const row = {
            fixture_id: f.id,
            market: 'O 2.5',
            hot: out.hot,
            score: out.score,
            signals: JSON.stringify(out.signals),
            over_price: p?.over ?? null,
            under_price: p?.under ?? null,
            implied_over: market?.impliedOver ?? null,
            api_advice_supports: out.api_supports,
            ai_verdict: null,
            ai_reason: null,
            ai_model: null,
            computed_at: db.fn.now(),
        };
        rows.push(row);
        if (out.hot) candidates.push({ f, row, out, market, api });
    }

    // AI adjudication - only rule-passing candidates, optional and fail-open.
    const ai = { confirmed: 0, vetoed: 0, errors: 0 };
    if (aiEnabled() && candidates.length) {
        const tick = _progress('Hot picks - AI adjudication');
        await _batch(candidates, async (c, i, len) => {
            const prev = existing.get(c.f.id);
            const unchanged = prev && ['confirm', 'veto'].includes(prev.ai_verdict)
                && Number(prev.score) === c.row.score;
            let verdict;
            if (unchanged) {
                // Same evaluation as the last billed call: reuse the verdict
                verdict = { verdict: prev.ai_verdict, reason: prev.ai_reason, model: prev.ai_model };
            } else {
                try {
                    verdict = await adjudicateHotPick({
                        fixture: `${c.f.home_name} - ${c.f.away_name}`,
                        kickoff: c.f.kickoff,
                        league: c.f.league,
                        signals: c.out.signals,
                        market: c.market,
                        api: c.api,
                    });
                } catch (e) {
                    console.warn(`[!] AI adjudication failed for fixture ${c.f.id} (rule verdict kept): ${e?.message ?? e}`);
                    verdict = { verdict: 'error', reason: null, model: config.HOTPICK_AI_MODEL };
                }
            }
            c.row.ai_verdict = verdict.verdict;
            c.row.ai_reason = verdict.reason;
            c.row.ai_model = verdict.model;
            if (verdict.verdict === 'veto') c.row.hot = false; // AI can veto, never promote
            ai[{ confirm: 'confirmed', veto: 'vetoed', error: 'errors' }[verdict.verdict]]++;
            tick(len);
        }, 1);
    }

    // Single-statement upsert per chunk: no delete+insert, no deadlock exposure
    for (let i = 0; i < rows.length; i += 200) {
        await db('fixture_predictions').insert(rows.slice(i, i + 200))
            .onConflict('fixture_id').merge(PICK_COLUMNS);
    }
    return { settled, fixtures: targets.length, written: rows.length, hot: rows.filter(r => r.hot).length, ai };
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
    return {
        windows: {
            '7d': _window(agg.hits_7d, agg.misses_7d),
            '30d': _window(agg.hits_30d, agg.misses_30d),
            all: _window(agg.hits_all, agg.misses_all),
        },
        pending: Number(agg.pending),
        upcoming: upcoming.map(u => ({ ...u, score: u.score == null ? null : Number(u.score) })),
    };
}
