import { db } from './db/connection.js';
import { effective } from './settings.js';
import { aiEnabled, aiModelTag, adjudicateHotPick, reviewTip } from './ai/adjudicators.js';
import { newRunGuard } from './db/ai-guard-rules.js';
import { loadTeamHistory } from './hotpicks.js';
import { effectiveAiConfig } from './enrich.js';
import { pairedTeamGoalsAggregates, h2hGoalsAggregates, apiPredictionSignal } from './db/goals-rules.js';
import {
    hotReviewPending, tipReviewPending, selectTipReviews, marketLine, latencyStats,
} from './db/adjudicate-rules.js';
import { eatDateKey } from './db/auto-rules.js';
import { KICKOFF_SQL_EXPR } from './db/ai-rules.js';
import { maintenanceActive } from './maintenance.js';
import { refreshJob } from './auto-refresh.js';
import { _batch, _progress, debugLog } from './utils.js';

// Background AI-review worker: drains the hot-pick adjudications and tip
// reviews the sweep no longer bills (T2 made the 8 verdict columns
// worker-owned). Work is selected by a DERIVED predicate - upcoming rows
// whose stored verdict is missing or stale under the adjudicate-rules reuse
// keys - so an interrupted drain auto-resumes by construction: whatever was
// persisted is no longer pending, whatever wasn't simply reappears in the
// next selection. No status column, nothing to desync.
//
// Freeze discipline: the selection is `kickoff > NOW()` and every call
// re-checks kickoff just before dialing - a fixture that kicks off first
// drops out silently (adjudicating post-kickoff is the leakage trap).
// Verdict coverage is therefore best-effort pre-kickoff; rows may settle
// with NULL verdicts, which every consumer already handles.
//
// Budget: TIP_AI_DAILY_CAP is an honest per-EAT-day count of BILLED tip
// calls (attempts, including errors - a dead API must not hammer forever).
// In-memory, day-keyed; a serve restart resets it (worst case one extra cap
// on a restart day - documented trade-off, no billing-timestamp migration).
// Hot adjudications are uncapped (a handful/day) but counted.

const CHUNK = 50;             // persist granularity: a kill loses at most one chunk of calls
const MAX_CONSEC_ERRORS = 5;  // abort the drain when the API looks dead (belt + braces with
                              // the T9 run-guard breaker, which makes refused calls instant)

const state = {
    running: false,
    day: null,
    billed_tips: 0,
    billed_hot: 0,
    last: null, // last drain summary (for logs/status probes)
};

export function aiWorkerStatus() {
    return { ...state };
}

function _rollDay(nowMs) {
    const day = eatDateKey(nowMs);
    if (state.day !== day) {
        state.day = day;
        state.billed_tips = 0;
        state.billed_hot = 0;
    }
}

// Pending rows, soonest kickoff first (verdicts must land before the freeze).
// kickoff is projected with the +03:00 offset baked in (KICKOFF_SQL_EXPR) so
// Date.parse yields the true instant on ANY host - a bare DATETIME decodes
// in the node process's local timezone, not the pinned SQL session.
async function _loadPending() {
    return db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .join('leagues as l', 'l.id', 'f.league_id')
        .join('teams as th', 'th.id', 'f.home_team_id')
        .join('teams as ta', 'ta.id', 'f.away_team_id')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .where(q => q.where('p.hot', 1).orWhereNotNull('p.tip_market'))
        .orderBy('f.kickoff')
        .select('p.fixture_id', 'p.market', 'p.hot', 'p.score',
            'p.over_price', 'p.under_price', 'p.implied_over',
            'p.ai_verdict', 'p.ai_model', 'p.ai_review',
            'p.tip_market', 'p.tip_price', 'p.tip_confidence', 'p.tip_breakdown',
            'p.tip_ai_verdict', 'p.tip_ai_model', 'p.tip_ai_review',
            'f.home_team_id', 'f.away_team_id', 'l.name as league',
            db.raw(`${KICKOFF_SQL_EXPR} as kickoff`),
            db.raw("CONCAT(th.name, ' - ', ta.name) as fixture"));
}

const _chunks = (list, size) => {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
};

const _json = v => (v == null ? null : JSON.stringify(v));

// tip_breakdown is the persisted bestTip() return, verbatim - the review
// prompt rebuilds from it with zero recomputation. A (rare, legacy) row
// without one still gets reviewed on the tip identity alone; reviewTip
// renders absent evidence fields as 'n/a'.
function _tipFromRow(r) {
    try {
        const parsed = typeof r.tip_breakdown === 'string' ? JSON.parse(r.tip_breakdown) : r.tip_breakdown;
        if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* fall through to the minimal tip */ }
    return { market: r.tip_market, price: Number(r.tip_price) };
}

// One drain pass. Returns the summary it also stores in state.last.
// `shouldStop()` is polled per call and per chunk (graceful .HALT/shutdown).
export async function drainAiReviews({ shouldStop = null } = {}) {
    if (!aiEnabled()) return { skipped: 'ai-disabled' };
    if (state.running) return { skipped: 'busy' };
    state.running = true;
    const startedMs = Date.now();
    const stop = typeof shouldStop === 'function' ? shouldStop : () => false;
    try {
        _rollDay(startedMs);
        const tag = aiModelTag();
        const tol = Number(effective('TIP_AI_REUSE_PRICE_TOL'));
        const conc = Number(effective('HOTPICK_AI_CONCURRENCY'));
        // T9 run guard: one per drain. Wall-clock budget (AI_RUN_MAX_MINUTES,
        // 0 = off) + circuit breaker (AI_BREAKER_AFTER consecutive transport/
        // parse failures) - once tripped, remaining calls refuse instantly
        // instead of burning a 60s timeout each; refusals resolve to 'error'
        // verdicts and the consec-error abort below ends the drain.
        const cfg = effectiveAiConfig();
        const guard = newRunGuard(startedMs);
        const rows = await _loadPending();
        const hotPend = rows.filter(r => hotReviewPending(r, tag));
        const tipPend = rows.filter(r => tipReviewPending(r, tag,
            { minConfidence: cfg.TIP_AI_MIN_CONFIDENCE, priceTol: tol }));

        const summary = {
            day: state.day,
            pending: { hot: hotPend.length, tips: tipPend.length },
            hot: { billed: 0, confirmed: 0, vetoed: 0, errors: 0, skipped: 0 },
            tips: { billed: 0, confirmed: 0, vetoed: 0, errors: 0, skipped: 0 },
            budget_left: Math.max(0, cfg.TIP_AI_DAILY_CAP - state.billed_tips),
            ms: 0, latency: null, aborted: null,
        };
        if (!hotPend.length && !tipPend.length) {
            summary.ms = Date.now() - startedMs;
            state.last = summary;
            return summary;
        }

        // Hot adjudications need the rolling aggregates the sweep judged with -
        // recomputed via the SAME shared machinery (loadTeamHistory +
        // goals-rules), never a second definition of "recent form".
        const teamIds = [...new Set(hotPend.flatMap(r => [r.home_team_id, r.away_team_id]))];
        const fixturesByTeam = teamIds.length ? await loadTeamHistory(teamIds) : new Map();
        const apiPreds = new Map(hotPend.length
            ? (await db('fixture_api_predictions').whereIn('fixture_id', hotPend.map(r => r.fixture_id)))
                .map(p => [p.fixture_id, p])
            : []);

        const latencies = [];
        let consecErrors = 0;

        // AI calls run concurrently (network-bound - the DB-writers
        // concurrency-1 rule does not apply); persistence is sequential
        // single-row PK UPDATEs afterwards, chunked so an interrupted drain
        // loses at most one chunk of un-persisted calls.
        const _phase = async (pend, kind, callFn, persistFn, tick) => {
            for (const chunk of _chunks(pend, CHUNK)) {
                if (stop() || consecErrors >= MAX_CONSEC_ERRORS) break;
                const results = await _batch(chunk, async r => {
                    if (stop() || Date.now() >= Date.parse(r.kickoff)) return { skip: true };
                    const t = Date.now();
                    try {
                        const verdict = await callFn(r);
                        return { verdict, ms: Date.now() - t };
                    } catch (e) {
                        console.warn(`[ai-worker] ${kind} review failed for fixture ${r.fixture_id} (kept): ${e?.message ?? e}`);
                        return { verdict: { verdict: 'error', reason: null, model: tag, review: null }, ms: Date.now() - t };
                    }
                }, conc);
                for (let i = 0; i < chunk.length; i++) {
                    const r = chunk[i], res = results[i];
                    if (!res || res.skip) { summary[kind].skipped++; continue; }
                    latencies.push(res.ms);
                    consecErrors = res.verdict.verdict === 'error' ? consecErrors + 1 : 0;
                    summary[kind].billed++;
                    if (kind === 'tips') state.billed_tips++; else state.billed_hot++;
                    summary[kind][{ confirm: 'confirmed', veto: 'vetoed', error: 'errors' }[res.verdict.verdict]]++;
                    await persistFn(r, res.verdict);
                    tick(pend.length);
                }
            }
        };

        // Hot picks first (a handful; a fresh veto should land quickly), then
        // tips under the remaining day budget.
        await _phase(hotPend, 'hot', r => {
            const cutoff = Date.parse(r.kickoff);
            const homeRows = fixturesByTeam.get(r.home_team_id) ?? [];
            const awayRows = fixturesByTeam.get(r.away_team_id) ?? [];
            const pair = pairedTeamGoalsAggregates(homeRows, awayRows,
                r.home_team_id, r.away_team_id, cutoff, cfg.HOTPICK_TEAM_WINDOW);
            const h2h = h2hGoalsAggregates(homeRows, r.home_team_id, r.away_team_id, cutoff, cfg.PREMATCH_H2H_WINDOW);
            const line = marketLine(r.market) ?? 2.5;
            const market = r.over_price == null ? null : {
                over: Number(r.over_price),
                under: r.under_price == null ? null : Number(r.under_price),
                impliedOver: r.implied_over == null ? null : Number(r.implied_over),
            };
            return adjudicateHotPick({
                fixture: r.fixture, kickoff: r.kickoff, league: r.league,
                home: pair.home, away: pair.away, h2h, market,
                api: apiPredictionSignal(apiPreds.get(r.fixture_id), line),
            }, { guard, cfg });
        }, async (r, verdict) => {
            // Fresh reviews carry their verdict-time context (judged) - the
            // row only holds the CURRENT evaluation once columns are
            // worker-owned, so "what did the verdict judge?" travels in the
            // review JSON (adjudicate-rules reads it back for reuse).
            const review = verdict.review ? { ...verdict.review, judged: { score: Number(r.score) } } : null;
            await db('fixture_predictions').where('fixture_id', r.fixture_id).update({
                ai_verdict: verdict.verdict, ai_reason: verdict.reason,
                ai_model: verdict.model, ai_review: _json(review),
                ...(verdict.verdict === 'veto' ? { hot: 0 } : {}), // AI can veto, never promote
            });
        }, _progress('[ai-worker] hot adjudication'));

        const budget = Math.max(0, cfg.TIP_AI_DAILY_CAP - state.billed_tips);
        const { billable, skipped } = selectTipReviews(tipPend.map(r => ({ ...r, reusable: false })), budget);
        summary.tips.skipped += skipped.length;
        await _phase(billable, 'tips', r => reviewTip({
            fixture: r.fixture, kickoff: r.kickoff, league: r.league, tip: _tipFromRow(r),
        }, { guard, cfg }), async (r, verdict) => {
            const review = verdict.review
                ? { ...verdict.review, judged: { tip_market: r.tip_market, tip_price: Number(r.tip_price) } }
                : null;
            await db('fixture_predictions').where('fixture_id', r.fixture_id).update({
                tip_ai_verdict: verdict.verdict, tip_ai_reason: verdict.reason,
                tip_ai_model: verdict.model, tip_ai_review: _json(review),
            });
        }, _progress('[ai-worker] tip review'));

        summary.aborted = consecErrors >= MAX_CONSEC_ERRORS ? 'consecutive-errors'
            : (stop() ? 'stop-requested' : null);
        summary.budget_left = Math.max(0, cfg.TIP_AI_DAILY_CAP - state.billed_tips);
        summary.ms = Date.now() - startedMs;
        summary.latency = latencyStats(latencies);
        state.last = summary;
        const lat = summary.latency.n
            ? ` (calls ${summary.latency.n}, avg ${Math.round(summary.latency.avg)}ms)` : '';
        const line = `[ai-worker] drain ${Math.round(summary.ms / 1000)}s - hot ${summary.hot.billed} billed `
            + `(${summary.hot.vetoed} vetoed), tips ${summary.tips.billed} billed (${summary.tips.vetoed} vetoed, `
            + `${summary.tips.skipped} over budget), budget left ${summary.budget_left}${lat}`
            + (summary.aborted ? ` [ABORTED: ${summary.aborted}]` : '');
        // A drain that billed nothing (all reused / budget-deferred) is the
        // steady state on a 60s tick - keep it out of production logs.
        if (summary.hot.billed || summary.tips.billed || summary.aborted) console.debug(line);
        else debugLog(line);
        return summary;
    } finally {
        state.running = false;
    }
}

// 60s unref'd tick, started/stopped by server.js beside the other
// schedulers. Skips while a refresh job holds the shared slot (belt +
// braces - column ownership is the real race fix) or a drain is running.
let timer = null;

export function startAiWorker() {
    if (timer) return;
    if (!aiEnabled()) {
        console.debug('[ai-worker] disabled - no GEMINI_API_KEY (rules-only verdicts).');
        return;
    }
    timer = setInterval(() => {
        if (refreshJob.running || state.running) return;
        // Quiesce during a declared maintenance window: billing Gemini while
        // visitors are being served a 503 is a surprise nobody wants on the
        // invoice. Work is a DERIVED predicate (upcoming + verdict missing or
        // stale), so a skipped tick resumes by construction - nothing to catch
        // up on, no cursor to keep. See src/maintenance.js for the full policy.
        if (maintenanceActive()) return;
        drainAiReviews().catch(e => console.warn(`[ai-worker] drain failed: ${e?.message ?? e}`));
    }, 60_000);
    timer.unref?.();
    console.debug('[ai-worker] started - drains pending AI reviews every 60s.');
}

export function stopAiWorker() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
    debugLog('[ai-worker] stopped');
}
