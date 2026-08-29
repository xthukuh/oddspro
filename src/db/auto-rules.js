// Pure auto-refresh scheduling rules (zero imports so tests skip config/.env).
// The scheduler (src/auto-refresh.js) ticks on a coarse interval and asks
// these predicates what is due; all times are epoch ms so tests control the
// clock. "Daily" means an EAT calendar day - the warehouse stores EAT
// wall-clock datetimes and Nairobi has no DST, so a fixed offset is exact.

export const EAT_OFFSET_MS = 3 * 3600_000;

// 'HH:MM' -> minutes of day (0..1439); ''/off/invalid -> null (mode disabled).
export function parseDailyTime(value) {
    const s = String(value ?? '').trim().toLowerCase();
    if (!s || s === 'off') return null;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Epoch ms -> 'YYYY-MM-DD' in EAT (shift, then read UTC getters).
export function eatDateKey(nowMs) {
    const d = new Date(nowMs + EAT_OFFSET_MS);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// Epoch ms -> minutes elapsed in the current EAT day.
export function eatMinutesOfDay(nowMs) {
    const d = new Date(nowMs + EAT_OFFSET_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// Daily full sweep is due once the EAT clock passes fullAtMinutes and no full
// run was started this EAT day yet (lastFullKey = eatDateKey of that start).
export function isFullDue(nowMs, fullAtMinutes, lastFullKey) {
    if (fullAtMinutes == null) return false;
    return eatMinutesOfDay(nowMs) >= fullAtMinutes && eatDateKey(nowMs) !== lastFullKey;
}

// Light pass is due every lightMinutes since the last light start; 0 = off.
export function isLightDue(nowMs, lastLightMs, lightMinutes) {
    return lightMinutes > 0 && nowMs - lastLightMs >= lightMinutes * 60_000;
}

// Classify a finished refresh job (F3). A user CANCEL wins over any error the
// cooperative abort threw - it's an intentional stop, not a failure - and only
// a clean 'ok' run bumps the data version / freshness stamps. 'partial' (Task
// A, 2026-08-19 durability pass) surfaces a light-pass run where some guarded
// steps failed and some succeeded (summary.steps_verdict, set by lightRefresh
// via summarizeSteps below) - still useful work, so it is treated like 'ok'
// for freshness-stamping purposes at the call site, but the log line honestly
// says 'partial' instead of masking the failures as a clean run.
export function refreshOutcome({ error, cancelRequested, summary } = {}) {
    if (cancelRequested) return 'cancelled';
    if (error) return 'error';
    if (summary?.steps_verdict === 'partial') return 'partial';
    return 'ok';
}

// Classify a light pass's per-step outcomes (Task A: per-step isolation so one
// step's failure can never cascade into skipping every later step - see
// docs/research/2026-08-19-odds-durability-and-outage-damage.md). `results` is
// an array of { step, ok, error? } entries pushed by lightRefresh's guardStep
// helper for each independently-isolated step (results settle, per-provider
// odds, link, settle picks) - the already-best-effort tail steps (daily/user
// slip settle, auth purge, track prune) are not represented here, they keep
// their own try/catch and never abort the pass either way. Total and
// order-independent:
//   'ok'      - every step that ran succeeded (including no steps at all)
//   'partial' - at least one step succeeded and at least one failed
//   'error'   - every step that ran failed (a total pass failure)
export function summarizeSteps(results) {
    const list = Array.isArray(results) ? results : [];
    if (!list.length) return 'ok';
    const failed = list.filter(r => !r?.ok).length;
    if (failed === 0) return 'ok';
    if (failed === list.length) return 'error';
    return 'partial';
}

// Guarded step executor for lightRefresh (fix round 1, 2026-08-19: extracted
// so the cancel-vs-failure split is independently testable without spinning
// up the DB/config-backed lightRefresh itself - the regression that matters
// most here is a swallowed cancel, which would make the cancel button a lie).
// `checkCancel(label)` runs OUTSIDE the try, so anything it throws (the
// cooperative-cancel signal) propagates OUT of the returned guard uncaught,
// aborting the whole pass immediately - only `fn`'s own thrown Error is
// captured: pushed to `results` as `{ step, ok:false, error }` and reported
// via `onFailure(label, message)`, and the guard resolves to `undefined`
// rather than rejecting. A success pushes `{ step, ok:true }` and resolves to
// `fn`'s return value. `results` is mutated in place (the same array
// lightRefresh later hands to summarizeSteps/hasDataBearingSuccess).
//
// Each result also carries `ms`, the wall-clock the step took (2026-08-29
// profiling pass). The full sweep runs 2.7-5.5h on the live host and the only
// timing it ever emitted was DEBUG-gated and keyed by step NUMBER, so a slow
// sweep could not be attributed to a phase without turning on a very noisy
// switch and mapping numbers back to labels by hand. Timing lives HERE, at
// the one choke point all three guarded paths (full sweep, light pass, single
// date refresh) already share, so one measurement covers every one of them.
// `now` is injectable purely so the offline tests stay deterministic.
// A FAILED step is timed too: a step that burns 20 minutes and then throws is
// exactly the one worth seeing.
export function makeStepGuard({ results, checkCancel = () => {}, onFailure = () => {}, now = Date.now } = {}) {
    return async function guardStep(label, fn) {
        checkCancel(label); // may throw - e.g. a cancel - never caught here
        const started = now();
        try {
            const result = await fn();
            results.push({ step: label, ok: true, ms: now() - started });
            return result;
        } catch (e) {
            const message = String(e?.message ?? e);
            results.push({ step: label, ok: false, error: message, ms: now() - started });
            onFailure(label, message);
            return undefined;
        }
    };
}

// Compact "where did the time go" profile over the guarded step results, for
// the one-line-per-run summary in logs/auto-refresh.log.
//
// Per-date labels are GROUPED into their phase before ranking: the full sweep
// emits 'betpawa odds 2026-08-29' .. '2026-09-01' as four separate guarded
// units, and four date rows each holding a quarter of the cost hide a phase
// that a single summed row makes obvious. The trailing ISO date is stripped,
// as is the explanatory parenthetical ('deep stats (final correlated
// fixtures, fetch-once)' -> 'deep stats'), which keeps one log line readable
// at a terminal width.
//
// Steps under `minMs` are dropped rather than ranked: a sweep has ~22 guarded
// units and most cost nothing, so listing them all would bury the few that
// matter. Returns '' when nothing qualifies, so the caller can append the
// clause only when it says something.
export function summarizeTimings(results, { top = 6, minMs = 1000 } = {}) {
    if (!Array.isArray(results)) return '';
    const totals = new Map();
    for (const r of results) {
        const ms = Number(r?.ms);
        if (!Number.isFinite(ms) || ms < 0) continue;
        const phase = String(r?.step ?? '')
            .replace(/\s+\d{4}-\d{2}-\d{2}$/, '')
            .replace(/\s*\(.*\)\s*$/, '')
            .trim() || 'unknown';
        totals.set(phase, (totals.get(phase) ?? 0) + ms);
    }
    return [...totals.entries()]
        .filter(([, ms]) => ms >= minMs)
        .sort((a, b) => b[1] - a[1])
        .slice(0, Math.max(0, top))
        .map(([phase, ms]) => `${phase} ${Math.round(ms / 1000)}s`)
        .join(', ');
}

// Which guarded steps count as "the warehouse actually collected something
// new" (Task 4, fix round 1, 2026-08-19; extended to the full pipeline's
// per-date labels in the 2026-08-19 round-2 durability pass). 'link' and
// 'settle picks' (and the 'odds idle check' bookkeeping step) only correlate
// or grade data that was already there - a pass where every data-bearing step
// failed and only those succeeded moved nothing forward and must not be
// reported fresh. PREFIX match (no trailing $) rather than exact, so the full
// sweep's per-date-per-provider labels ('betpawa odds 2026-08-20', 'betika
// odds 2026-08-21', ...) still count while the light pass's bare labels
// ('results', 'betpawa odds', 'betika odds') keep matching exactly as before -
// canonical fixtures ('fixtures 2026-08-20' in the full sweep) deliberately
// stay excluded, since they are cheaply refetchable and not the view-once
// asset this guarantee protects.
export const DATA_BEARING_STEP_RE = /^(results|betpawa odds|betika odds)/;

export function hasDataBearingSuccess(stepResults) {
    return Array.isArray(stepResults) && stepResults.some(r => r?.ok && DATA_BEARING_STEP_RE.test(r?.step));
}

// Whether a finished job should stamp per-date freshness (lastFresh) and bump
// the shared warehouse_version (Task 4, fix round 1, 2026-08-19). 'ok' always
// qualifies - the 'results' step is unconditionally guarded first in every
// light pass, so an 'ok' verdict (zero guarded-step failures) necessarily
// includes a data-bearing success already; full/manual jobs carry no
// steps_verdict at all and are only ever 'ok'/'error'/'cancelled'. A
// 'partial' light pass qualifies ONLY when `summary.data_bearing_ok` is true
// (see hasDataBearingSuccess above) - a pass where results and both
// providers' odds all failed, and only link/settle-picks succeeded against
// stale data, collected nothing new and must not stamp freshness.
export function shouldStampFreshness(outcome, summary = null) {
    if (outcome === 'ok') return true;
    if (outcome === 'partial') return summary?.data_bearing_ok === true;
    return false;
}

// Whether a saveMatches() counts object ({inserted, updated, skipped,
// markets}) represents real collected data (Task, 2026-08-19 durability
// pass follow-up: the collection heartbeat used to stamp `last_odds_at`
// whenever saveMatches did not throw, regardless of whether any market data
// actually arrived - a scraper that ran but returned zero games, or zero
// markets, read as healthy and defeated the watchdog built to catch exactly
// that). True when at least one odds market row was written, or at least one
// match row was inserted/updated - the three ways a save call can leave
// something new on the warehouse; false for an all-zero counts object
// (the shape saveMatches returns early with on an empty/absent games array).
export function hasOddsSaveData(counts) {
    if (!counts || typeof counts !== 'object') return false;
    return Number(counts.markets) > 0 || Number(counts.inserted) > 0 || Number(counts.updated) > 0;
}

// Decide what to do with a pending cross-instance manual-refresh request
// (src/meta.js's `refresh_request` key, written by a follower's POST
// /api/refresh - see src/server.js). The writer's tick calls this only after
// its own `refreshJob.running` early-return (see consumePendingRefreshRequest
// in src/auto-refresh.js), so busy-slot is not this function's concern - it
// judges shape plus the SAME two abuse guards server.js's own POST handler
// applies to a writer-direct click, so a follower click can't bypass them
// and force a real sweep every ~30s tick instead of once per cooldown:
//   'invalid'  - absent/malformed request (no well-shaped YYYY-MM-DD date)
//   'fresh'    - the date was refreshed within REFRESH_CACHE_MINUTES
//   'cooldown' - the date's last CONSUMED queued run started within
//                REFRESH_COOLDOWN_MINUTES (lastManualMs - see the caller's
//                own `lastQueuedManualMs` map, separate from server.js's
//                writer-direct cooldown map)
//   'run'      - go ahead and start the job
export function shouldConsumeRefreshRequest(request, {
    nowMs = Date.now(), lastFreshMs = null, lastManualMs = null, cacheMinutes = 0, cooldownMinutes = 0,
} = {}) {
    if (!request || typeof request !== 'object') return 'invalid';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(request.date ?? ''))) return 'invalid';
    if (cacheMinutes > 0 && lastFreshMs != null && nowMs - lastFreshMs < cacheMinutes * 60_000) return 'fresh';
    if (cooldownMinutes > 0 && lastManualMs != null && nowMs - lastManualMs < cooldownMinutes * 60_000) return 'cooldown';
    return 'run';
}

// Decide whether the writer's tick should attempt today's full sweep (Task 2,
// 2026-08-19 durability round 2: src/pipeline.js's runStartPipeline never
// participated in the per-step isolation lightRefresh got in round 1, and
// startAutoRefresh stamped lastFullKey at START - so a throw in an early step
// (the same results-settle throw that caused the 2026-08-16 outage) burned
// the whole EAT day: no retry until tomorrow, and the full sweep is the ONLY
// thing that fetches odds for FUTURE dates). Now lastKey is stamped by the
// caller ONLY when the run actually succeeds or partially succeeds with a
// data-bearing step (see auto-refresh.js's onFinish, mirroring
// shouldStampFreshness) - a total failure no longer burns the day outright.
// To stop a persistently broken sweep retrying every ~30s tick forever, the
// caller also tracks an attempt count that resets whenever dayKey changes
// (fullAttemptsDayKey in auto-refresh.js) and caps retries at maxAttempts.
//   'done'      - dayKey already has a completed (success/partial) sweep
//   'exhausted' - maxAttempts already spent for dayKey with no completed sweep
//   'run'       - go ahead and attempt the sweep (caller increments attempts)
export function fullSweepAttemptVerdict({ dayKey, lastKey = null, attempts = 0, maxAttempts = 3 } = {}) {
    if (dayKey === lastKey) return 'done';
    if (maxAttempts > 0 && attempts >= maxAttempts) return 'exhausted';
    return 'run';
}

// Self-truncating log: past maxBytes, keep the newest ~half starting at a
// line boundary, behind a truncation marker. Byte-approximate (log lines are
// ASCII); nowIso is injectable for deterministic tests.
export function trimLogTail(content, maxBytes, nowIso = new Date().toISOString()) {
    if (typeof content !== 'string' || content.length <= maxBytes) return content;
    let tail = content.slice(-Math.floor(maxBytes / 2));
    const nl = tail.indexOf('\n');
    if (nl !== -1) tail = tail.slice(nl + 1);
    return `[log truncated ${nowIso}]\n${tail}`;
}
