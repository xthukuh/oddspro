// Pure production-health rules (zero project imports beyond the pure
// auto-rules clock helpers, so the offline suite and the host cron script can
// both load it without config/.env).
//
// ONE copy of the verdict logic for two callers that must never drift:
//   - the in-app daily snapshot (src/health.js, writer instance only), which
//     lands one row per EAT day in `health_snapshots` and is read back through
//     GET /api/admin/health/ledger|latest;
//   - the host cron script scripts/ops/prod-health.mjs, which imports this
//     file from the deployed app root and keeps writing ~/ops/health/.
//
// A snapshot answers two questions from cheap signals only: is collection
// running religiously, and how much history has piled up for pattern mining.
// The thresholds below are the ones the cron script shipped with on
// 2026-09-10, with two corrections (see decideHealth / fullMissingToday).

import { parseDailyTime, eatDateKey, eatMinutesOfDay } from './auto-rules.js';

export { parseDailyTime, eatDateKey, eatMinutesOfDay };

// Accumulation counters. The leading primary-key column differs per table:
// four of these are keyed on fixture_id and have no `id` column at all, which
// is why a naive MAX(id) UNION dies with "Unknown column 'id'". MAX() on the
// leading PK column is an index read either way.
export const COUNTER_TABLES = [
    ['odds_markets', 'id'],
    ['matches', 'id'],
    ['fixtures', 'id'],
    ['fixture_predictions', 'fixture_id'],
    ['fixture_api_predictions', 'fixture_id'],
    ['fixture_statistics', 'id'],
    ['fixture_events', 'id'],
    ['fixture_ai_insights', 'fixture_id'],
    ['fixture_prematch', 'fixture_id'],
    ['daily_slips', 'id'],
];

export const HEALTH_LEDGER_DEFAULT_DAYS = 14;
export const HEALTH_LEDGER_MAX_DAYS = 120;
export const HEALTH_HARD_TIMEOUT_MS = 120_000;
export const HEALTH_SNAPSHOT_MAX_ATTEMPTS = 3;          // per EAT day, failed inserts only
export const HEALTH_SNAPSHOT_RETRY_MS = 15 * 60_000;    // wait between failed attempts
export const HEALTH_STALE_AFTER_H = 26;                 // latest snapshot older than this = monitor blind
export const FULL_MISSING_AFTER_HOUR = 13;              // EAT hour; the sweep starts early and runs 2.5-7h

// collection_runs.verdict is the enum ok | partial | error | cancelled
// (src/auto-refresh.js records refreshOutcome()). The cron script as first
// shipped tested for 'failed', a value the ledger never holds, so a failed
// full sweep or failed light passes could never raise a reason. 'failed' stays
// accepted as an alias in case an older row or a future writer uses it.
const FAILED_VERDICTS = new Set(['error', 'failed']);

// EAT is UTC+3 with no DST, so shifting the epoch and slicing the UTC date is
// exact and does not depend on the host TZ being set correctly.
export function eatStamp(ms = Date.now()) {
    return new Date(ms + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

// A stored DATETIME is EAT wall clock. SQL hands it back as a formatted string
// (never a Date) so the toISOString day-shift trap cannot bite; this turns it
// back into a real instant.
export function eatStringToMs(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]);
}

export function num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function minutesSince(ms, nowMs) {
    return ms == null ? null : Math.round((nowMs - ms) / 60_000);
}

// ps etime is [[DD-]HH:]MM:SS.
export function etimeToSeconds(s) {
    const t = String(s ?? '').trim();
    let days = 0;
    let rest = t;
    const dash = t.indexOf('-');
    if (dash > 0) {
        days = Number(t.slice(0, dash)) || 0;
        rest = t.slice(dash + 1);
    }
    const parts = rest.split(':').map(Number);
    while (parts.length < 3) parts.unshift(0);
    const [h, m, sec] = parts;
    const total = days * 86_400 + h * 3600 + m * 60 + sec;
    return Number.isFinite(total) ? total : 0;
}

// The empty snapshot every reader can rely on: every key present, every
// unread value null. The ledger shape is a contract with the weekly digest.
export function baseSnapshot(nowMs = Date.now()) {
    return {
        ts: new Date(nowMs).toISOString(),
        day: eatDateKey(nowMs),
        verdict: 'GREEN',
        reasons: [],
        unread: [],
        light: { by_verdict: {}, total_24h: null, light_max_gap_min: null, last_light_at: null },
        full: null,
        full_missing_today: false,
        meta: { last_odds_at: null, odds_age_min: null, job_state: null, warehouse_version: null, last_success: null },
        fixtures_nearby: null,
        counters: { max_id: {}, rows_estimate: {}, mb: {}, finals_yesterday: null },
        coverage: { yesterday: {}, today: {}, tomorrow: {} },
        notices: { by_status: {}, newest_id: null, new_unconfirmed_24h: [] },
        host: {
            lsnode_count: null, lsnode_oldest_days: null, disk_free_gb: null,
            db_uptime_s: null, db_threads_connected: null,
        },
        api: { requests_today: null, limit_day: null, plan: null, plan_end: null, plan_days_left: null },
        watchdog: { last_log_line: null, state: null },
        prev: { ts: null, age_h: null, odds_markets_max_id: null },
        alerted: false,
        error: null,
    };
}

// Latest full-sweep row (rows newest first, as the query orders them) plus the
// [start, end] windows of every recent sweep, used to excuse light-pass gaps.
// `rows`: [{ id, verdict, s, f, sf }] with s/f EAT 'YYYY-MM-DD HH:mm:ss'.
export function summarizeFull(rows, nowMs) {
    const list = Array.isArray(rows) ? rows : [];
    const windows = list
        .map(r => [eatStringToMs(r.s), eatStringToMs(r.f) ?? nowMs])
        .filter(w => w[0] != null);
    if (!list.length) return { full: null, windows };
    const r = list[0];
    let stepFailures = [];
    try {
        stepFailures = JSON.parse(r.sf || '[]');
    } catch {
        stepFailures = [String(r.sf).slice(0, 200)];
    }
    const sMs = eatStringToMs(r.s);
    const fMs = eatStringToMs(r.f);
    return {
        windows,
        full: {
            id: r.id,
            started_at: r.s,
            finished_at: r.f ?? null,
            duration_s: sMs != null && fMs != null ? Math.round((fMs - sMs) / 1000) : null,
            verdict: r.verdict,
            step_failures: Array.isArray(stepFailures) ? stepFailures : [stepFailures],
        },
    };
}

// A full sweep only lands in collection_runs when it FINISHES, so a sweep that
// is still running at snapshot time is invisible to the ledger. The writer's
// `job_state` meta beacon (src/auto-refresh.js#startJob) closes that hole: a
// full job started today counts as started. Without it a slow sweep still
// running past 13:00 read as "missing" and raised a false RED.
// Only call it missing once the day is well past the sweep's normal window,
// so an early run never cries wolf.
export function fullMissingToday({ rows, today, nowEat, jobState } = {}) {
    const startedToday = (rows ?? []).some(r => String(r.s).slice(0, 10) === today);
    if (startedToday) return false;
    if (jobState && jobState.mode === 'full' && jobState.started_at) {
        const ms = Date.parse(jobState.started_at);
        if (Number.isFinite(ms) && eatDateKey(ms) === today) return false;
    }
    const hourEat = Number(String(nowEat ?? '').slice(11, 13));
    return Number.isFinite(hourEat) && hourEat >= FULL_MISSING_AFTER_HOUR;
}

// Light passes of the last 24h (rows oldest first: [{ verdict, s }]).
// Largest gap between consecutive passes, with any overlap with a full-sweep
// window subtracted: the light pass legitimately stands down while the sweep
// holds the single job slot, so that stretch is not a gap in collection. The
// tail from the last pass to now is measured too, so a collector that stopped
// an hour ago is visible before the next scheduled pass.
export function summarizeLight(rows, fullWindows, nowMs) {
    const light = Array.isArray(rows) ? rows : [];
    const windows = Array.isArray(fullWindows) ? fullWindows : [];
    const byVerdict = {};
    for (const r of light) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
    const excuse = (a, b) => {
        let span = b - a;
        for (const [ws, we] of windows) span -= Math.max(0, Math.min(b, we) - Math.max(a, ws));
        return span;
    };
    let maxGap = 0;
    for (let i = 1; i < light.length; i++) {
        const a = eatStringToMs(light[i - 1].s);
        const b = eatStringToMs(light[i].s);
        if (a == null || b == null) continue;
        maxGap = Math.max(maxGap, excuse(a, b));
    }
    const lastMs = light.length ? eatStringToMs(light[light.length - 1].s) : null;
    if (lastMs != null) maxGap = Math.max(maxGap, excuse(lastMs, nowMs));
    return {
        by_verdict: byVerdict,
        total_24h: light.length,
        last_light_at: light.length ? light[light.length - 1].s : null,
        light_max_gap_min: light.length > 1 ? Math.round(maxGap / 60_000) : null,
    };
}

// meta rows [{ k, v }] (v is JSON text) -> the snapshot's meta block.
export function parseMetaRows(rows, nowMs) {
    const parse = v => {
        try {
            return JSON.parse(v);
        } catch {
            return v ?? null;
        }
    };
    const byKey = Object.fromEntries((rows ?? []).map(r => [r.k, parse(r.v)]));
    const lastOdds = byKey.last_odds_at ?? null;
    const oddsMs = lastOdds ? Date.parse(lastOdds) : NaN;
    return {
        last_odds_at: lastOdds,
        odds_age_min: Number.isFinite(oddsMs) ? minutesSince(oddsMs, nowMs) : null,
        job_state: byKey.job_state ?? null,
        warehouse_version: byKey.warehouse_version ?? null,
        last_success: byKey.last_success ?? null,
    };
}

// Coverage rows [{ d, provider, n, linked }] -> { yesterday, today, tomorrow }.
export function summarizeCoverage(rows, { yday, today, tmrw } = {}) {
    const out = { yesterday: {}, today: {}, tomorrow: {} };
    const slot = { [yday]: 'yesterday', [today]: 'today', [tmrw]: 'tomorrow' };
    for (const r of rows ?? []) {
        const key = slot[r.d];
        if (key) out[key][r.provider] = { n: num(r.n), linked: num(r.linked) };
    }
    return out;
}

// The prev block for the flatline rule, from the most recent earlier snapshot
// that actually carried an odds_markets high-water mark (a snapshot_error row
// carries none and must not blind the next day's comparison). `prevs` is one
// snapshot or a newest-first list of them.
export function prevBlock(prevs, nowMs) {
    const list = Array.isArray(prevs) ? prevs : (prevs ? [prevs] : []);
    const prev = list.find(p => p && p.counters && p.counters.max_id && p.counters.max_id.odds_markets != null)
        ?? list.find(Boolean)
        ?? null;
    if (!prev) return { ts: null, age_h: null, odds_markets_max_id: null };
    const pMs = prev.ts ? Date.parse(prev.ts) : NaN;
    return {
        ts: prev.ts ?? null,
        age_h: Number.isFinite(pMs) ? Math.round(((nowMs - pMs) / 3_600_000) * 10) / 10 : null,
        odds_markets_max_id: prev.counters && prev.counters.max_id ? prev.counters.max_id.odds_markets ?? null : null,
    };
}

// The verdict. Pure: reads the snapshot, returns { verdict, reasons }; the
// caller assigns them. Reasons already present on the snapshot when this runs
// (unread:* and api_status_unavailable, collected during the read pass) are
// AMBER-weight evidence of a blind spot and are carried after the new ones.
export function decideHealth(snap) {
    const red = [];
    const amber = [];
    const light = snap.light ?? {};
    const byVerdict = light.by_verdict ?? {};
    const meta = snap.meta ?? {};
    const api = snap.api ?? {};
    const host = snap.host ?? {};
    const nearby = (snap.fixtures_nearby ?? 0) > 0;
    const age = meta.odds_age_min;

    // Staleness only counts when there is something to scrape (the watchdog's
    // own rule, src/db/watchdog-rules.js): a quiet slate is not an outage.
    if (age != null && age > 120 && nearby) red.push(`odds_stale:${age}m`);
    else if (age != null && age >= 60 && age <= 120 && nearby) amber.push(`odds_aging:${age}m`);

    if (snap.full_missing_today) red.push('full_missing_today');
    if (snap.full && FAILED_VERDICTS.has(snap.full.verdict)) red.push(`full_failed:${snap.full.id}`);
    if (snap.full && snap.full.verdict === 'partial') amber.push(`full_partial:${snap.full.id}`);

    let failed = 0;
    for (const v of FAILED_VERDICTS) failed += byVerdict[v] || 0;
    const partial = byVerdict.partial || 0;
    if (failed >= 5) red.push(`light_failed:${failed}`);
    else if (failed >= 1) amber.push(`light_failed:${failed}`);
    if (partial >= 5) amber.push(`light_partial:${partial}`);

    const gap = light.light_max_gap_min;
    if (gap != null && gap > 90) red.push(`light_gap:${gap}m`);
    else if (gap != null && gap >= 45) amber.push(`light_gap:${gap}m`);

    if (api.plan_days_left != null) {
        if (api.plan_days_left < 0) red.push(`api_plan_expired:${api.plan_end}`);
        else if (api.plan_days_left <= 10) amber.push(`api_plan_soon:${api.plan_days_left}d`);
    }
    if (api.requests_today != null && api.limit_day) {
        const pct = Math.round((api.requests_today / api.limit_day) * 100);
        if (pct > 80) amber.push(`api_quota_high:${pct}%`);
    }

    // Flatlined odds: the same odds_markets high-water mark as a day ago means
    // nothing has been written since, whatever the freshness stamp claims.
    const prev = snap.prev ?? {};
    const prevMax = prev.odds_markets_max_id;
    const curMax = snap.counters && snap.counters.max_id ? snap.counters.max_id.odds_markets : null;
    if (prevMax != null && curMax != null && prev.age_h != null && prev.age_h >= 20 && prevMax === curMax) {
        red.push(`odds_flatlined:${curMax}`);
    }

    if (host.disk_free_gb != null && host.disk_free_gb < 25) amber.push(`disk_low:${host.disk_free_gb}GB`);
    if (host.lsnode_count != null && host.lsnode_count >= 4) amber.push(`lsnode_many:${host.lsnode_count}`);
    if (host.lsnode_oldest_days != null && host.lsnode_oldest_days > 14) amber.push(`lsnode_old:${host.lsnode_oldest_days}d`);

    const newNotices = (snap.notices && snap.notices.new_unconfirmed_24h ? snap.notices.new_unconfirmed_24h : []).length;
    if (newNotices >= 1) amber.push(`notices_new:${newNotices}`);

    const carried = Array.isArray(snap.reasons) ? snap.reasons.slice() : [];
    return {
        verdict: red.length ? 'RED' : (amber.length || carried.length) ? 'AMBER' : 'GREEN',
        reasons: [...red, ...amber, ...carried],
    };
}

// The snapshot that stands in for a run that could not complete: RED, reason
// `snapshot_error` first, so the monitor still records the blind day instead
// of silently skipping it. `detail` is an extra reason (e.g. timeout:120s).
export function errorSnapshot(nowMs, error, detail = null) {
    const snap = baseSnapshot(nowMs);
    snap.verdict = 'RED';
    snap.reasons = detail ? ['snapshot_error', detail] : ['snapshot_error'];
    snap.error = String((error && error.message) || error || 'unknown error').slice(0, 300);
    return snap;
}

// RED escalation target: OPS_ALERT_PHONE first, else the active admin's
// phone (scripts/collection-watchdog.js's fallback). The phone is used for the
// send only and is never written into a snapshot.
export function pickAlertPhone(envPhone, adminPhone) {
    const env = String(envPhone ?? '').trim();
    if (env) return env;
    const adm = String(adminPhone ?? '').trim();
    return adm || null;
}

export function alertText(snap) {
    return `oddspro RED ${snap.day}: ${(snap.reasons ?? []).join(', ')}`.slice(0, 140);
}

// ?days= for GET /api/admin/health/ledger. Blank/absent = the default; any
// other value must be a whole number in 1..HEALTH_LEDGER_MAX_DAYS or the
// route answers 400 (a typo never silently becomes a different window).
export function parseLedgerDays(raw) {
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) {
        return { ok: true, days: HEALTH_LEDGER_DEFAULT_DAYS };
    }
    if (Array.isArray(raw)) return { ok: false, error: 'days must be given once' };
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) return { ok: false, error: `days must be a whole number 1..${HEALTH_LEDGER_MAX_DAYS}` };
    const n = Number(s);
    if (n < 1 || n > HEALTH_LEDGER_MAX_DAYS) {
        return { ok: false, error: `days must be between 1 and ${HEALTH_LEDGER_MAX_DAYS}` };
    }
    return { ok: true, days: n };
}

// The scheduler's per-tick question: may THIS process take today's snapshot
// now? One snapshot per EAT day, writer only, at or after the HEALTH_SNAPSHOT_AT
// slot (a boot after the slot catches up on its first tick; a boot before it
// waits, so an early-morning restart never takes a premature snapshot that
// would then stand for the whole day). Failed attempts (the row could not be
// written) back off and are capped per day. Answers one of:
// not_writer | off | done | before_slot | exhausted | backoff | take.
export function snapshotDecision({
    nowMs, atMinutes, writer, doneDay = null, attempts = null,
    maxAttempts = HEALTH_SNAPSHOT_MAX_ATTEMPTS, retryMs = HEALTH_SNAPSHOT_RETRY_MS,
} = {}) {
    if (!writer) return 'not_writer';
    if (atMinutes == null) return 'off';
    const day = eatDateKey(nowMs);
    if (doneDay === day) return 'done';
    if (eatMinutesOfDay(nowMs) < atMinutes) return 'before_slot';
    if (attempts && attempts.day === day) {
        if ((attempts.count ?? 0) >= maxAttempts) return 'exhausted';
        if (attempts.lastMs != null && nowMs - attempts.lastMs < retryMs) return 'backoff';
    }
    return 'take';
}

// Attempt bookkeeping for snapshotDecision: resets at the EAT day boundary.
export function nextAttempts(attempts, nowMs) {
    const day = eatDateKey(nowMs);
    const count = attempts && attempts.day === day ? (attempts.count ?? 0) + 1 : 1;
    return { day, count, lastMs: nowMs };
}

// A health_snapshots row as read back (JSON columns may arrive as text on
// MariaDB, where JSON is a LONGTEXT alias, or already parsed on MySQL).
export function decodeSnapshotRow(row) {
    if (!row) return null;
    const json = (v, dflt) => {
        if (v == null) return dflt;
        if (typeof v !== 'string') return v;
        try {
            return JSON.parse(v);
        } catch {
            return dflt;
        }
    };
    return {
        id: row.id,
        day: row.day,
        taken_at: row.taken_at,
        verdict: row.verdict,
        reasons: json(row.reasons, []),
        payload: json(row.payload, null),
    };
}

// Is the monitor itself alive? `latest` is a decoded row (or null). The
// digest reads this instead of inferring blindness from an empty list: no row
// at all, or a newest row older than HEALTH_STALE_AFTER_H, means nothing has
// been watching (the in-app snapshot only runs while the writer is alive).
// `missing_today` turns true once today's slot (plus 30 min grace) has passed
// without a row for today.
export function ledgerFreshness(latest, nowMs, atMinutes) {
    const today = eatDateKey(nowMs);
    const takenMs = latest ? eatStringToMs(latest.taken_at) : null;
    const ageH = takenMs != null ? Math.round(((nowMs - takenMs) / 3_600_000) * 10) / 10 : null;
    const pastSlot = atMinutes != null && eatMinutesOfDay(nowMs) >= atMinutes + 30;
    return {
        today,
        latest_day: latest ? latest.day : null,
        age_h: ageH,
        missing_today: pastSlot && (!latest || latest.day !== today),
        stale: !latest || ageH == null || ageH > HEALTH_STALE_AFTER_H,
    };
}
