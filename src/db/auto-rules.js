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
