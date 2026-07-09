import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { runStartPipeline } from './pipeline.js';
import { settleApisportsResults } from './apisports.js';
import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { saveMatches, completedMatchIds } from './db/store.js';
import { linkMatches } from './link.js';
import { settleHotPicks } from './hotpicks.js';
import { parseDailyTime, eatDateKey, eatMinutesOfDay, isFullDue, isLightDue, trimLogTail } from './db/auto-rules.js';
import { _date, _dtime } from './utils.js';

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
    started_at: null,
    finished_at: null,
    error: null,
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
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        summary: null,
    });
    run(step => { refreshJob.step = step; })
        .then(summary => { refreshJob.summary = summary ?? null; })
        .catch(e => {
            refreshJob.error = String(e?.message ?? e);
            console.error(e);
        })
        .finally(() => {
            refreshJob.running = false;
            refreshJob.step = null;
            refreshJob.finished_at = new Date().toISOString();
            if (!refreshJob.error) {
                dataVersion += 1;
                lastSuccess = { at: refreshJob.finished_at, mode, dates };
                for (const d of dates) lastFresh.set(d, Date.now());
            }
            const secs = Math.round((Date.now() - startedMs) / 1000);
            _log(`${mode} ${refreshJob.error ? 'FAIL' : 'ok'} ${secs}s dates=${dates.join(',') || '-'}`
                + (refreshJob.error ? ` error=${refreshJob.error}` : ''));
            try {
                onFinish?.(refreshJob);
            } catch (e) {
                console.error(e);
            }
        });
    return true;
}

// LIGHT pass: cheapest near-real-time subset. No fixtures-by-date fetch (the
// settle refresh updates in-play statuses/scores/elapsed per id), no deep
// stats/history/snapshots/predictions/AI (those belong to the full sweep and
// manual date refreshes). Completed matches are excluded from odds scraping
// pre-fetch, and past dates are never touched.
export async function lightRefresh(onStep = null) {
    const today = _dtime(_date()).substring(0, 10);
    const _step = label => {
        console.debug(`[light ${today}] ${label}...`);
        if (typeof onStep === 'function') onStep(label);
    };
    const summary = { date: today };

    _step('results');
    const r = await settleApisportsResults();
    summary.refreshed = r.refreshed;
    summary.settled = r.settled;

    for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
        _step(`${provider} odds`);
        const exclude = await completedMatchIds(provider, `${today} 00:00:00`);
        const c = await saveMatches(await fetcher(today, exclude));
        summary[provider] = { saved: c.inserted + c.updated, skipped: c.skipped, markets: c.markets };
    }

    _step('link');
    await linkMatches();

    _step('settle picks');
    const s = await settleHotPicks();
    summary.picks_settled = s.settled;
    summary.tips_settled = s.tips_settled;
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
    if (timer || !config.AUTO_REFRESH_ENABLED) return false;
    const fullAt = parseDailyTime(config.AUTO_FULL_AT);
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
                startJob({
                    mode: 'full',
                    dates: _sweepDates(config.AUTO_FULL_DAYS),
                    run: onStep => runStartPipeline(config.AUTO_FULL_DAYS, onStep),
                });
            } else if (isLightDue(nowMs, lastLightMs, config.AUTO_LIGHT_MINUTES)) {
                lastLightMs = nowMs;
                startJob({
                    mode: 'light',
                    dates: [_dtime(_date()).substring(0, 10)],
                    run: lightRefresh,
                });
            }
        } catch (e) {
            console.error('[auto] tick failed:', e);
        }
    };
    timer = setInterval(tick, 30_000);
    timer.unref?.();
    const fullLabel = fullAt != null ? `${config.AUTO_FULL_AT} EAT (+${config.AUTO_FULL_DAYS}d)` : 'off';
    const lightLabel = config.AUTO_LIGHT_MINUTES > 0 ? `every ${config.AUTO_LIGHT_MINUTES}m` : 'off';
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
