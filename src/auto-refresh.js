import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { runStartPipeline } from './pipeline.js';
import { settleApisportsResults } from './apisports.js';
import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { saveMatches, oddsExcludeIds } from './db/store.js';
import { db } from './db/connection.js';
import { linkMatches } from './link.js';
import { settleHotPicks } from './hotpicks.js';
import { purgeExpiredAuth } from './auth.js';
import { parseDailyTime, eatDateKey, eatMinutesOfDay, isFullDue, isLightDue, trimLogTail, refreshOutcome } from './db/auto-rules.js';
import { parseOddsTiers, lightPassIdle } from './db/odds-refresh-rules.js';
import { effective } from './settings.js';
import { _date, _dtime, debugLog } from './utils.js';

// In-process auto-refresh: the always-on server (`npm run serve`) keeps the
// warehouse near real time without external cron - a cheap LIGHT pass every
// AUTO_LIGHT_MINUTES (settle scores/outcomes, today's odds, link, settle
// picks) and the FULL pipeline once per EAT day at AUTO_FULL_AT. This module
// also owns the single-slot job state so auto and manual (POST /api/refresh)
// runs literally share one guard - parallel refreshes would deadlock on
// InnoDB delete+insert gap locks (same rule as `_batch` concurrency 1).

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

// Monotonic data version, bumped only on SUCCESSFUL completions - the web
// app's slow poll compares it to decide "new data landed, silently reload".
// Resets on restart (clients treat their first observation as baseline).
let dataVersion = 0;
let lastSuccess = null; // { at, mode, dates }

// Success-only per-date freshness (date -> epoch ms). Backs the manual
// cache-reuse answer. Deliberately SEPARATE from server.js's manual cooldown
// map: auto runs must never stamp the cooldown, or a 10-minute light cadence
// would keep today permanently on manual cooldown.
const lastFresh = new Map();

// When the light pass last actually SCRAPED odds (idle skips don't stamp) -
// feeds lightPassIdle's bounded-discovery cadence. In-memory: a restart
// simply runs the next pass (fail-open).
let lastOddsScrapeMs = null;

export function lastFreshAt(date) {
    return lastFresh.get(date) ?? null;
}

// Poll payload: the job state plus the freshness signal.
export function refreshStatus() {
    return { ...refreshJob, data_version: dataVersion, last_success: lastSuccess };
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
            if (outcome === 'ok') {
                dataVersion += 1;
                lastSuccess = { at: refreshJob.finished_at, mode, dates };
                for (const d of dates) lastFresh.set(d, Date.now());
            }
            const secs = Math.round((Date.now() - startedMs) / 1000);
            _log(`${mode} ${outcome.toUpperCase()} ${secs}s dates=${dates.join(',') || '-'}`
                + (outcome === 'error' ? ` error=${refreshJob.error}` : ''));
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
export async function lightRefresh(onStep = null, shouldCancel = null) {
    const today = _dtime(_date()).substring(0, 10);
    const _step = label => {
        if (typeof shouldCancel === 'function' && shouldCancel()) throw new Error('cancelled');
        console.debug(`[light ${today}] ${label}...`);
        if (typeof onStep === 'function') onStep(label);
    };
    const summary = { date: today };

    _step('results');
    const r = await settleApisportsResults();
    summary.refreshed = r.refreshed;
    summary.settled = r.settled;

    // Kickoff-proximity backoff + idle awareness (odds-refresh-rules), knobs
    // late-read per pass. The idle lookahead is clamped to the first tier
    // boundary so an idle skip can never starve the near-kickoff
    // always-refresh guarantee that keeps is_stale detection current.
    const nowMs = Date.now();
    const tiers = parseOddsTiers(effective('ODDS_REFRESH_TIERS'));
    const lookKnob = Number(effective('AUTO_IDLE_LOOKAHEAD_MINUTES'));
    const firstTier = tiers?.[0]?.upToMin ?? 0;
    const todayMatches = (await db('matches')
        .where('start_time', '>=', `${today} 00:00:00`)
        .where('start_time', '<=', `${today} 23:59:59`)
        .select('completed_at',
            db.raw("DATE_FORMAT(start_time, '%Y-%m-%dT%H:%i:%s+03:00') as start_iso")))
        .map(x => ({ startMs: Date.parse(x.start_iso), completed: x.completed_at != null }));
    const idle = lightPassIdle(nowMs, todayMatches, {
        lookaheadMin: lookKnob > 0 && Number.isFinite(firstTier) ? Math.max(lookKnob, firstTier) : lookKnob,
        idleEveryMin: Number(effective('AUTO_IDLE_EVERY_MINUTES')),
        lastOddsPassMs: lastOddsScrapeMs,
    });
    summary.odds_pass = idle.reason;
    if (idle.skip) {
        _step('odds skipped (idle - nothing in-play, next kickoff far)');
    } else {
        lastOddsScrapeMs = nowMs;
        for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
            _step(`${provider} odds`);
            const ex = await oddsExcludeIds(provider, `${today} 00:00:00`, { tiers, nowMs: Date.now() });
            const c = await saveMatches(await fetcher(today, ex.ids));
            summary[provider] = { saved: c.inserted + c.updated, skipped: c.skipped, markets: c.markets, backoff_skipped: ex.backoff };
            debugLog(`[light] ${provider}: excluded ${ex.completed} completed + ${ex.backoff} fresh-under-backoff`);
        }

        _step('link');
        await linkMatches();
    }

    _step('settle picks');
    const s = await settleHotPicks();
    summary.picks_settled = s.settled;
    summary.tips_settled = s.tips_settled;

    // Auth housekeeping (E3): drop long-expired sessions/OTP rows. Best-effort -
    // a purge hiccup must never fail the data refresh.
    try {
        summary.auth_purged = await purgeExpiredAuth();
    } catch (e) {
        console.error('[light] auth purge failed:', e?.message ?? e);
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

// Start the scheduler: one coarse 30s tick decides what is due. Skips while
// any job (manual included) holds the slot; every tick is exception-proof so
// a failed run never kills the interval. unref'd - the timer alone must not
// hold the process open during shutdown.
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
    const tick = () => {
        try {
            if (refreshJob.running) return;
            const nowMs = Date.now();
            if (isFullDue(nowMs, fullAt, lastFullKey)) {
                // Stamp at START: one attempt per EAT day even on failure -
                // no retry storms of an expensive sweep (failures land in the
                // log; the next light pass still keeps data moving).
                lastFullKey = eatDateKey(nowMs);
                const fullDays = effective('AUTO_FULL_DAYS');
                startJob({
                    mode: 'full',
                    dates: _sweepDates(fullDays),
                    run: (onStep, shouldCancel) => runStartPipeline(fullDays, onStep, shouldCancel),
                });
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
    if (!config.AUTO_LOG) return;
    const file = 'logs/auto-refresh.log';
    try {
        mkdirSync('logs', { recursive: true });
        const maxBytes = config.AUTO_LOG_MAX_KB * 1024;
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
