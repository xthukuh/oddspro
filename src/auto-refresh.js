import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { runStartPipeline, runDateRefresh } from './pipeline.js';
import { settleApisportsResults } from './apisports.js';
import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { saveMatches, oddsExcludeIds } from './db/store.js';
import { db } from './db/connection.js';
import { linkMatches } from './link.js';
import { settleHotPicks } from './hotpicks.js';
import { settleDailySlips } from './daily-slip.js';
import { settleUserSlips } from './user-slips.js';
import { purgeExpiredAuth } from './auth.js';
import { pruneTrackEvents } from './track.js';
import {
    parseDailyTime, eatDateKey, eatMinutesOfDay, isFullDue, isLightDue, trimLogTail, refreshOutcome,
    shouldConsumeRefreshRequest, summarizeSteps, summarizeTimings, makeStepGuard, hasDataBearingSuccess, shouldStampFreshness,
    hasOddsSaveData, fullSweepAttemptVerdict,
} from './db/auto-rules.js';
import { parseOddsTiers, lightPassIdle } from './db/odds-refresh-rules.js';
import { effective } from './settings.js';
import { _date, _dtime, debugLog } from './utils.js';
import { isWriter } from './db/lease.js';
import { bumpWarehouseVersion, getMeta, refreshMetaMemo, setMeta, warehouseVersion, lastSuccessMemo } from './meta.js';
import { columnCatalog } from './db/records.js';
import { recordRun, runDetector, pruneRuns } from './notices.js';

// In-process auto-refresh: the always-on server (`npm run serve`) keeps the
// warehouse near real time without external cron - a cheap LIGHT pass every
// AUTO_LIGHT_MINUTES (settle scores/outcomes, today's odds, link, settle
// picks) and the FULL pipeline once per EAT day at AUTO_FULL_AT. This module
// also owns the single-slot job state so auto and manual (POST /api/refresh)
// runs literally share one guard - parallel refreshes would deadlock on
// InnoDB delete+insert gap locks (same rule as `_batch` concurrency 1).
//
// Multi-instance: the live host runs three concurrent `src/server.js`
// processes. Only the writer instance (src/db/lease.js's `isWriter()`) ticks
// the scheduler - a follower's `tick()` returns immediately. `data_version`/
// `last_success` used to be per-process; they now live in the shared `meta`
// table (src/meta.js) so every instance answers the same freshness signal
// regardless of which one actually ran the job.

// Single-slot job state. `mode` distinguishes manual/light/full; `dates` is
// the scope the run covers (the web client reloads only when its loaded date
// is in scope); `date` = dates[0] kept for backward compat with older payload
// consumers.
export const refreshJob = {
    running: false,
    mode: null,
    date: null,
    dates: [],
    step: null,
    last_step: null,        // step reached at finish/cancel (survives after step->null)
    started_at: null,
    finished_at: null,
    error: null,
    cancelled: false,       // last run was aborted by the user (F3)
    cancelRequested: false, // cooperative-cancel flag the run polls between steps
    summary: null,
};

// Success-only per-date freshness (date -> epoch ms). Backs the manual
// cache-reuse answer. Deliberately SEPARATE from server.js's manual cooldown
// map: auto runs must never stamp the cooldown, or a 10-minute light cadence
// would keep today permanently on manual cooldown.
const lastFresh = new Map();

// When the light pass last actually SCRAPED odds (idle skips don't stamp) -
// feeds lightPassIdle's bounded-discovery cadence. In-memory: a restart
// simply runs the next pass (fail-open).
let lastOddsScrapeMs = null;

// Column-catalog persistence throttle (writer-only, see _storeColumnCatalog).
let lastCatalogStoreMs = 0;
const CATALOG_STORE_INTERVAL_MS = 30 * 60_000;

export function lastFreshAt(date) {
    return lastFresh.get(date) ?? null;
}

// Poll payload: the job state plus the SHARED freshness signal + writer flag.
// data_version/last_success come from the meta memo (src/meta.js), not the
// local mirrors above, so a follower instance reports exactly what the
// writer last recorded.
export function refreshStatus() {
    return { ...refreshJob, data_version: warehouseVersion(), last_success: lastSuccessMemo(), writer: isWriter() };
}

// Persist the discovered column catalog to shared meta so follower instances
// can serve it (src/server.js's startCatalogWarm) without running their own
// odds_markets scan. Writer-only, throttled to once per 30 min - a light
// pass every few minutes must not repeat the scan; the daily full sweep
// always refreshes it. Best-effort - never throws into the job's finally.
async function _storeColumnCatalog(mode) {
    if (!isWriter()) return;
    const now = Date.now();
    if (mode !== 'full' && now - lastCatalogStoreMs < CATALOG_STORE_INTERVAL_MS) return;
    lastCatalogStoreMs = now;
    await setMeta('column_catalog', await columnCatalog());
}

// Per-date: when the writer's tick last actually STARTED a job for a
// consumed refresh_request. Deliberately a SEPARATE map from server.js's own
// per-date manual-cooldown map (module-private there, only tracks a
// writer-direct POST click) - the two paths get independent cooldown clocks,
// but the SAME REFRESH_COOLDOWN_MINUTES knob and the same abuse-prevention
// intent: a follower can't force a real sweep more than once per window by
// clicking repeatedly, exactly like a writer-direct click can't.
const lastQueuedManualMs = new Map();

// Cross-instance manual-refresh handoff: a follower `src/server.js` instance
// cannot run POST /api/refresh's job itself (a second writer would deadlock
// on the same InnoDB gap locks the single-slot job guard exists to prevent -
// see startJob above), so it stores the request in shared meta instead
// (`refresh_request`, src/meta.js). The writer's own tick consumes it here,
// at the top - before its own full/light due checks - so a follower-triggered
// refresh starts within one 30s tick, gated by the SAME two guards
// server.js's own POST handler applies to a writer-direct click:
// REFRESH_CACHE_MINUTES (skip a date refreshed moments ago) and
// REFRESH_COOLDOWN_MINUTES (skip a date consumed moments ago) - see pure
// shouldConsumeRefreshRequest (src/db/auto-rules.js). Never throws - a
// read/write hiccup just means the request is retried on the next tick.
async function consumePendingRefreshRequest() {
    if (refreshJob.running) return;
    let request;
    try {
        request = await getMeta('refresh_request');
    } catch (e) {
        console.error('[auto] refresh_request read failed:', e?.message ?? e);
        return;
    }
    if (!request) return; // nothing pending
    const decision = shouldConsumeRefreshRequest(request, {
        nowMs: Date.now(),
        lastFreshMs: lastFreshAt(request.date),
        lastManualMs: lastQueuedManualMs.get(request.date) ?? null,
        cacheMinutes: effective('REFRESH_CACHE_MINUTES'),
        cooldownMinutes: effective('REFRESH_COOLDOWN_MINUTES'),
    });
    if (decision === 'fresh' || decision === 'cooldown') {
        console.info(`[auto] queued refresh for ${request.date} skipped: ${decision}`);
    } else if (decision === 'invalid') {
        console.warn('[auto] refresh_request malformed - dropping:', JSON.stringify(request));
    }
    try {
        // Clear the slot on EVERY outcome, not just 'run': a 'fresh'/
        // 'cooldown' skip is a settled answer for THIS click (a later click
        // gets its own fresh evaluation against then-current guard state,
        // never a resurrected old one), and 'invalid' is unrecoverable
        // garbage. Clearing BEFORE starting the job specifically: if the
        // clear itself fails, skip this tick rather than risk relaunching
        // the same request every 30s.
        await setMeta('refresh_request', null);
    } catch (e) {
        console.error('[auto] refresh_request clear failed:', e?.message ?? e);
        return;
    }
    if (decision !== 'run') return;
    lastQueuedManualMs.set(request.date, Date.now());
    startJob({
        mode: 'manual',
        dates: [request.date],
        run: (onStep, shouldCancel) => runDateRefresh(request.date, onStep, shouldCancel),
    });
}

// Claim the slot and fire `run(onStep)` without awaiting. Returns false when
// a job is already running (callers 409/skip). `onFinish(refreshJob)` always
// runs last - server.js stamps its manual cooldown there.
export function startJob({ mode, dates, run, onFinish = null }) {
    if (refreshJob.running) return false;
    const startedMs = Date.now();
    Object.assign(refreshJob, {
        running: true,
        mode,
        date: dates[0] ?? null,
        dates,
        step: 'starting',
        last_step: null,
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        cancelled: false,
        cancelRequested: false,
        summary: null,
    });
    // The run polls shouldCancel() between steps and aborts cooperatively; the
    // cancelRequested flag is the source of truth for the finish classifier.
    run(step => { refreshJob.step = step; }, () => refreshJob.cancelRequested)
        .then(summary => { refreshJob.summary = summary ?? null; })
        .catch(e => {
            refreshJob.error = String(e?.message ?? e);
            if (!refreshJob.cancelRequested) console.error(e); // a cancel abort isn't an error
        })
        .finally(() => {
            const outcome = refreshOutcome(refreshJob); // 'ok' | 'error' | 'cancelled'
            refreshJob.running = false;
            refreshJob.last_step = refreshJob.step;
            refreshJob.step = null;
            refreshJob.finished_at = new Date().toISOString();
            refreshJob.cancelled = outcome === 'cancelled';
            if (outcome === 'cancelled') refreshJob.error = null; // user abort, not a failure
            // 'partial' (Task A) still moved data IF a data-bearing step
            // (results or a provider's odds) actually succeeded - a pass
            // where only link/settle-picks succeeded against otherwise-failed
            // steps collected nothing new and must not be reported fresh
            // (shouldStampFreshness, src/db/auto-rules.js, fix round 1).
            if (shouldStampFreshness(outcome, refreshJob.summary)) {
                for (const d of dates) lastFresh.set(d, Date.now());
                // Cross-instance meta: bump the shared warehouse_version and
                // record last_success so every instance's next refreshStatus()
                // read sees this completion - there is no per-process mirror
                // to update here, `refreshStatus()` answers entirely from the
                // meta memo (`warehouseVersion()`/`lastSuccessMemo()`, see
                // src/meta.js) regardless of which instance ran the job.
                // Best-effort - a meta-write hiccup must never throw into
                // this finally block (the job already succeeded).
                bumpWarehouseVersion().then(refreshMetaMemo)
                    .catch(e => console.error('[auto] meta write failed:', e?.message ?? e));
                setMeta('last_success', { at: refreshJob.finished_at, mode, dates })
                    .catch(e => console.error('[auto] meta write failed:', e?.message ?? e));
                _storeColumnCatalog(mode)
                    .catch(e => console.error('[auto] meta write failed:', e?.message ?? e));
            }
            // Record EVERY finished run, including errors and cancels: the
            // detector reasons about the ABSENCE of runs, so a run that failed
            // is still evidence the process was alive and trying. Best-effort,
            // exactly like the meta writes above - a ledger hiccup must never
            // throw into this finally block.
            if (isWriter()) {
                recordRun({
                    started_at: refreshJob.started_at ?? new Date(startedMs).toISOString(),
                    finished_at: refreshJob.finished_at,
                    mode,
                    dates,
                    verdict: outcome,
                    step_failures: refreshJob.summary?.step_failures ?? [],
                })
                    .catch(e => console.error('[auto] run ledger write failed:', e?.message ?? e));
            }
            const secs = Math.round((Date.now() - startedMs) / 1000);
            const failedSteps = refreshJob.summary?.step_failures?.map(f => f.step) ?? [];
            // `slow=` is the per-run profile (2026-08-29 profiling pass): the
            // slowest phases of THIS run, so a sweep that drifts from 2.7h to
            // 5.5h says which phase moved without anyone re-running it. Kept
            // on the existing summary line and capped to the top few phases -
            // one line per run, so it costs the log nothing measurable, and
            // it is deliberately NOT DEBUG-gated: a 3h job that only reports
            // its own duration cannot be diagnosed after the fact.
            const slow = refreshJob.summary?.step_timings ?? '';
            _log(`${mode} ${outcome.toUpperCase()} ${secs}s dates=${dates.join(',') || '-'}`
                + (outcome === 'error' ? ` error=${refreshJob.error}` : '')
                + (outcome === 'partial' && failedSteps.length ? ` failed=${failedSteps.join(',')}` : '')
                + (slow ? ` slow=${slow}` : ''));
            refreshJob.cancelRequested = false; // clear for the next job
            try {
                onFinish?.(refreshJob);
            } catch (e) {
                console.error(e);
            }
        });
    return true;
}

// Request a cooperative cancel of the in-flight job (F3). The running job polls
// the flag between steps and stops early - already-completed steps stay (the
// pipeline is idempotent, so a later "resume" re-run is cheap). Returns false
// when nothing is running (nothing to cancel).
export function requestCancel() {
    if (!refreshJob.running) return false;
    refreshJob.cancelRequested = true;
    return true;
}

// LIGHT pass: cheapest near-real-time subset. No fixtures-by-date fetch (the
// settle refresh updates in-play statuses/scores/elapsed per id), no deep
// stats/history/snapshots/predictions/AI (those belong to the full sweep and
// manual date refreshes). Completed matches are excluded from odds scraping
// pre-fetch, and past dates are never touched.
//
// Task A (2026-08-19 durability pass, docs/research/2026-08-19-odds-durability-
// and-outage-damage.md): bookmaker odds are the only irreplaceable data this
// pipeline touches, so no earlier step may ever cost a collection window
// again. The 2026-08-16 outage was exactly that: the results-settle statement
// threw, and because the pass was a plain sequence, every step after it -
// including both providers' odds scraping - simply never ran, for three days.
// Every step below (results settle, per-provider odds, link, settle picks) is
// now independently guarded via guardStep: a throw is caught, recorded and
// logged, and the pass continues to the next step regardless. The ORDER is
// unchanged on purpose (results-first still lets completed matches shrink the
// scrapers' per-game detail requests) - only the failure-cascades-forward
// behaviour is gone. A cooperative cancel (_step's shouldCancel() throw) stays
// OUTSIDE every guarded try/catch, so it still aborts the whole pass
// immediately exactly as before - guardStep only isolates a STEP'S OWN work,
// never the cancel check that precedes it.
export async function lightRefresh(onStep = null, shouldCancel = null) {
    const today = _dtime(_date()).substring(0, 10);
    const _step = label => {
        if (typeof shouldCancel === 'function' && shouldCancel()) throw new Error('cancelled');
        console.debug(`[light ${today}] ${label}...`);
        if (typeof onStep === 'function') onStep(label);
    };
    const summary = { date: today };

    // Per-step outcomes for the guarded steps only (summarizeSteps/
    // hasDataBearingSuccess below) - the already-best-effort tail (daily/user
    // slip settle, auth purge, track prune) keeps its own try/catch and is
    // not represented here. guardStep itself (fix round 1) is the extracted,
    // independently-tested makeStepGuard - checkCancel runs OUTSIDE its try,
    // so the cancel signal always propagates uncaught and aborts the whole
    // pass, exactly as before; only an ordinary step Error is captured.
    const stepResults = [];
    const guardStep = makeStepGuard({
        results: stepResults,
        checkCancel: _step,
        onFailure: (label, message) => console.error(`[light] ${label} failed:`, message),
    });

    const r = await guardStep('results', () => settleApisportsResults());
    if (r) {
        summary.refreshed = r.refreshed;
        summary.settled = r.settled;
    }

    // Kickoff-proximity backoff + idle awareness (odds-refresh-rules). The
    // idle lookahead is clamped to the first tier boundary so an idle skip
    // can never starve the near-kickoff always-refresh guarantee that keeps
    // is_stale detection current. Both the settings reads (effective/
    // parseOddsTiers) AND the DB read live inside this ONE guarded step (fix
    // round 1, minor item): if either ever throws, that failure must not skip
    // both providers' odds guards outright - it degrades to "assume active,
    // no backoff" instead, the same fail-open direction as the DB-read
    // failure path already used.
    const nowMs = Date.now();
    const { tiers, idle } = (await guardStep('odds idle check', async () => {
        const t = parseOddsTiers(effective('ODDS_REFRESH_TIERS'));
        const lookKnob = Number(effective('AUTO_IDLE_LOOKAHEAD_MINUTES'));
        const firstTier = t?.[0]?.upToMin ?? 0;
        const todayMatches = (await db('matches')
            .where('start_time', '>=', `${today} 00:00:00`)
            .where('start_time', '<=', `${today} 23:59:59`)
            .select('completed_at',
                db.raw("DATE_FORMAT(start_time, '%Y-%m-%dT%H:%i:%s+03:00') as start_iso")))
            .map(x => ({ startMs: Date.parse(x.start_iso), completed: x.completed_at != null }));
        return {
            tiers: t,
            idle: lightPassIdle(nowMs, todayMatches, {
                lookaheadMin: lookKnob > 0 && Number.isFinite(firstTier) ? Math.max(lookKnob, firstTier) : lookKnob,
                idleEveryMin: Number(effective('AUTO_IDLE_EVERY_MINUTES')),
                lastOddsPassMs: lastOddsScrapeMs,
            }),
        };
    })) ?? { tiers: null, idle: { skip: false, reason: 'idle-check-failed-assume-active' } };
    summary.odds_pass = idle.reason;
    if (idle.skip) {
        _step('odds skipped (idle - nothing in-play, next kickoff far)');
    } else {
        lastOddsScrapeMs = nowMs;
        // The single most valuable line in this task: a failure scraping ONE
        // provider must not prevent the OTHER from being scraped, so each
        // provider is its own guarded step.
        for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
            const res = await guardStep(`${provider} odds`, async () => {
                const ex = await oddsExcludeIds(provider, `${today} 00:00:00`, { tiers, nowMs: Date.now() });
                const c = await saveMatches(await fetcher(today, ex.ids));
                debugLog(`[light] ${provider}: excluded ${ex.completed} completed + ${ex.backoff} fresh-under-backoff`);
                // CRITICAL FIX (fix round 1, 2026-08-19): a dedicated
                // freshness signal, bumped ONLY by a successful odds save -
                // matches.updated_at also moves on results/link writes that
                // have nothing to do with odds, so it can't tell "odds
                // stalled" apart from "results/link are healthy but both
                // providers are broken". Best-effort, writer-side only
                // (lightRefresh only ever runs on the writer's own tick - see
                // startAutoRefresh's isWriter() gate); never throws into this
                // step even if the meta write itself fails.
                //
                // FIX (2026-08-19, defect 3): `saveMatches` not throwing is
                // not the same as data landing - a scraper that ran but
                // returned zero games (or a save that wrote zero markets and
                // touched zero match rows) used to stamp the heartbeat anyway,
                // reading as healthy while the watchdog it exists for went
                // blind. Only stamp when hasOddsSaveData(c) says something
                // was actually written (see db/auto-rules.js).
                if (isWriter() && hasOddsSaveData(c)) {
                    setMeta('last_odds_at', new Date().toISOString())
                        .catch(e => console.error('[light] last_odds_at meta write failed:', e?.message ?? e));
                }
                return { c, ex };
            });
            if (res) {
                summary[provider] = { saved: res.c.inserted + res.c.updated, skipped: res.c.skipped, markets: res.c.markets, backoff_skipped: res.ex.backoff };
            }
        }

        await guardStep('link', () => linkMatches());
    }

    const s = await guardStep('settle picks', () => settleHotPicks());
    if (s) {
        summary.picks_settled = s.settled;
        summary.tips_settled = s.tips_settled;
    }

    // The tail: daily/user slip settle, auth housekeeping (E3) and tracking
    // retention (M6). All four are best-effort - a hiccup here must never fail
    // the data refresh - which is exactly what guardStep already provides, so
    // since 2026-08-29 they run through the SAME guard as the steps above
    // rather than four hand-rolled try/catch blocks.
    //
    // The reason is attribution: a light pass takes 37-52s on the live host and
    // its guarded steps often account for almost none of that, because on an
    // idle pass (nothing in-play, next kickoff far) the odds scrapes are
    // skipped and the remaining time is spent right here. Unrepresented work
    // cannot be profiled, so `slow=` was reporting nothing at all for those
    // passes.
    //
    // Failure semantics are unchanged in the way that matters: guardStep
    // catches and records exactly as the try/catch did, and a tail failure
    // cannot raise a spurious data notice, because the detector only derives
    // an outage span from DATA_BEARING_STEP_RE failures (results / either
    // provider's odds - see src/db/notice-rules.js) and none of these labels
    // match it. What DOES change is honest: a tail failure now downgrades the
    // run's verdict from 'ok' to 'partial' and names itself on the summary
    // line, where it used to vanish into stderr.
    const ds = await guardStep('daily-slip settle', () => settleDailySlips());
    if (ds) summary.daily_slips_settled = ds.settled;

    const us = await guardStep('user-slip settle', () => settleUserSlips());
    if (us) summary.user_slips_settled = us.settled;

    const ap = await guardStep('auth purge', () => purgeExpiredAuth());
    if (ap != null) summary.auth_purged = ap;

    // A no-op while TRACK_EVENTS_RETENTION_DAYS is 0 (the keep-forever default).
    const pruned = await guardStep('track prune', () => pruneTrackEvents());
    if (pruned) summary.track_events_pruned = pruned;

    // Final verdict over the guarded steps (results, odds idle check,
    // per-provider odds, link, settle picks). 'partial' is a normal return -
    // useful work MAY have happened, so the job's freshness stamp is gated on
    // data_bearing_ok (see startJob's finally / shouldStampFreshness) rather
    // than the verdict alone - but 'error' (every guarded step failed) throws
    // so the job's own outcome classification (refreshOutcome) honestly
    // reports the pass as a failure instead of a silent 'ok'.
    summary.step_failures = stepResults.filter(x => !x.ok).map(({ step, error }) => ({ step, error }));
    summary.steps_verdict = summarizeSteps(stepResults);
    summary.data_bearing_ok = hasDataBearingSuccess(stepResults);
    summary.step_timings = summarizeTimings(stepResults);
    if (summary.steps_verdict === 'error') {
        throw new Error(`light pass: every step failed (${summary.step_failures.map(f => `${f.step}: ${f.error}`).join('; ')})`);
    }
    return summary;
}

// Today..+days as 'YYYY-MM-DD' (same formula as runStartPipeline).
function _sweepDates(days) {
    const today = _date();
    return [...Array(days + 1)].map((_, i) =>
        _dtime(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)).substring(0, 10)
    );
}

let timer = null;
let lastLightMs = 0;
let lastFullKey = null;

// Task 2 (2026-08-19 durability pass round 2): retry state for a failing full
// sweep. fullAttempts counts attempts made for fullAttemptsDayKey (reset
// whenever the EAT day changes); lastFullKey is now stamped ONLY when a sweep
// finishes ok/partial-with-data (see the tick's onFinish below), not at
// start, so a failed sweep no longer burns the whole EAT day outright - see
// fullSweepAttemptVerdict (src/db/auto-rules.js) for the pure decision.
let fullAttempts = 0;
let fullAttemptsDayKey = null;
let fullExhaustedLoggedKey = null; // avoid re-logging 'exhausted' every 30s tick

// Start the scheduler: one coarse 30s tick decides what is due. Every tick
// first checks isWriter() - on the multi-instance host only one process ever
// runs the scheduler at a time; a follower's tick is a no-op until it wins
// the lease (src/db/lease.js). Skips while any job (manual included) holds
// the slot; every tick is exception-proof so a failed run never kills the
// interval. unref'd - the timer alone must not hold the process open during
// shutdown.
export function startAutoRefresh() {
    // AUTO_REFRESH_ENABLED + AUTO_FULL_AT are read ONCE here (restart-required
    // catalog entries); AUTO_LIGHT_MINUTES + AUTO_FULL_DAYS are read per tick
    // below (live-editable). All via the dynamic-settings service.
    if (timer || !effective('AUTO_REFRESH_ENABLED')) return false;
    const fullAt = parseDailyTime(effective('AUTO_FULL_AT'));
    const now = Date.now();
    // First light pass lands AUTO_LIGHT_MINUTES after boot; a (re)start
    // already past AUTO_FULL_AT must not fire a surprise full sweep - that
    // slot re-arms on the next EAT day.
    lastLightMs = now;
    lastFullKey = fullAt != null && eatMinutesOfDay(now) >= fullAt ? eatDateKey(now) : null;
    // Async (consumePendingRefreshRequest awaits a meta read/write) - the
    // in-flight guard stops an overlapping tick from double-consuming a
    // pending request or racing startJob's slot check, and the outer
    // try/catch/finally guarantees nothing ever throws out of the interval
    // callback regardless of where an awaited step fails.
    let tickInFlight = false;
    const tick = async () => {
        if (tickInFlight) return;
        tickInFlight = true;
        try {
            if (!isWriter()) return; // only the writer instance schedules work
            await consumePendingRefreshRequest();
            if (refreshJob.running) return;
            const nowMs = Date.now();
            if (isFullDue(nowMs, fullAt, lastFullKey)) {
                // Task 2 (2026-08-19 round 2): lastFullKey is no longer
                // stamped here at START (that used to burn the whole EAT day
                // on ANY failure, including the exact results-throw that
                // caused the 2026-08-16 outage). Instead: reset the attempt
                // counter at the EAT day boundary, ask the pure verdict
                // whether today still has retries left, and only stamp
                // lastFullKey in onFinish once the run actually lands
                // ok/partial-with-data - a failed attempt just consumes one
                // of AUTO_FULL_MAX_ATTEMPTS and the next tick tries again.
                const dayKey = eatDateKey(nowMs);
                if (dayKey !== fullAttemptsDayKey) {
                    fullAttemptsDayKey = dayKey;
                    fullAttempts = 0;
                }
                const maxAttempts = effective('AUTO_FULL_MAX_ATTEMPTS');
                const verdict = fullSweepAttemptVerdict({ dayKey, lastKey: lastFullKey, attempts: fullAttempts, maxAttempts });
                if (verdict === 'run') {
                    fullAttempts += 1;
                    const fullDays = effective('AUTO_FULL_DAYS');
                    startJob({
                        mode: 'full',
                        dates: _sweepDates(fullDays),
                        run: (onStep, shouldCancel) => runStartPipeline(fullDays, onStep, shouldCancel),
                        onFinish: job => {
                            // Only a completed sweep (ok, or partial with a
                            // data-bearing step) uses up the day - a total
                            // 'error' or a user/shutdown 'cancelled' leaves
                            // lastFullKey untouched so the next tick can
                            // retry (bounded by maxAttempts above). Built from
                            // job.cancelled/job.error/job.summary rather than
                            // re-deriving refreshOutcome(job) here: by the
                            // time onFinish runs, startJob's finally block has
                            // already reset job.cancelRequested to false for
                            // the NEXT job, so re-feeding refreshOutcome the
                            // live object would misread a cancelled run as ok.
                            const outcome = refreshOutcome({ error: job.error, cancelRequested: job.cancelled, summary: job.summary });
                            if (outcome === 'ok' || (outcome === 'partial' && job.summary?.data_bearing_ok)) {
                                lastFullKey = dayKey;
                            }
                            // Detection is a once-a-day job: it scans the whole run ledger, and a
                            // gap that matters is hours wide, so running it on the 10-minute light
                            // cadence would be pure waste. Pruning rides along for the same reason.
                            runDetector()
                                .then(r => { if (r.inserted) _log(`detector proposed ${r.inserted} notice(s)`); })
                                .catch(e => console.error('[auto] notice detector failed:', e?.message ?? e));
                            pruneRuns().catch(e => console.error('[auto] run prune failed:', e?.message ?? e));
                        },
                    });
                } else if (verdict === 'exhausted' && fullExhaustedLoggedKey !== dayKey) {
                    fullExhaustedLoggedKey = dayKey;
                    const msg = `full sweep EXHAUSTED ${maxAttempts} attempt(s) for ${dayKey} without success - waiting for the next EAT day`;
                    console.error(`[auto] ${msg}`);
                    _log(msg);
                }
            } else if (isLightDue(nowMs, lastLightMs, effective('AUTO_LIGHT_MINUTES'))) {
                lastLightMs = nowMs;
                startJob({
                    mode: 'light',
                    dates: [_dtime(_date()).substring(0, 10)],
                    run: (onStep, shouldCancel) => lightRefresh(onStep, shouldCancel),
                });
            }
        } catch (e) {
            console.error('[auto] tick failed:', e);
        } finally {
            tickInFlight = false;
        }
    };
    timer = setInterval(tick, 30_000);
    timer.unref?.();
    const fullLabel = fullAt != null ? `${effective('AUTO_FULL_AT')} EAT (+${effective('AUTO_FULL_DAYS')}d)` : 'off';
    const lightLabel = effective('AUTO_LIGHT_MINUTES') > 0 ? `every ${effective('AUTO_LIGHT_MINUTES')}m` : 'off';
    console.debug(`[auto] scheduler on - light ${lightLabel}, full ${fullLabel}`);
    _log(`scheduler started - light ${lightLabel}, full ${fullLabel}`);
    return true;
}

export function stopAutoRefresh() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
}

// Append a timestamped line to logs/auto-refresh.log, self-truncating past
// AUTO_LOG_MAX_KB (the production host has no log rotation and tight disk
// quotas). Logging must never break a job - failures degrade to console.
function _log(line) {
    if (!effective('AUTO_LOG')) return;
    const file = 'logs/auto-refresh.log';
    try {
        mkdirSync('logs', { recursive: true });
        const maxBytes = effective('AUTO_LOG_MAX_KB') * 1024;
        try {
            if (statSync(file).size > maxBytes) {
                writeFileSync(file, trimLogTail(readFileSync(file, 'utf8'), maxBytes));
            }
        } catch {
            // no log file yet
        }
        appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`);
    } catch (e) {
        console.error('[auto] log write failed:', e?.message ?? e);
    }
}
