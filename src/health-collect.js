import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import {
    COUNTER_TABLES, eatStringToMs, num, etimeToSeconds, summarizeFull, fullMissingToday,
    summarizeLight, parseMetaRows, summarizeCoverage,
} from './db/health-rules.js';

// The signal readers behind a production-health snapshot, shared VERBATIM by
// the in-app snapshot (src/health.js) and the host cron script
// (scripts/ops/prod-health.mjs imports this file from the deployed app root),
// so the two can never disagree about what was measured. The verdict itself is
// the pure src/db/health-rules.js.
//
// The knex instance is a PARAMETER, never imported here: the app passes its
// shared pool, the cron passes the one it imported from src/db/connection.js
// and closes it itself. Either way it is the one knex instance.
//
// Rules that keep this safe on the live host (shared cPanel, high load):
//   - never scan a big table. odds_markets has 17M+ rows and no index on
//     updated_at, and the host kills long scans. Only MAX() on a primary key
//     (O(1) in InnoDB), information_schema estimates, small tables
//     (collection_runs, meta, data_notices, users), and indexed date ranges on
//     matches.start_time / fixtures.kickoff.
//   - never read or print a secret. The admin phone is returned to the caller
//     for the RED send and never written into the snapshot.
//   - every statement is bounded by the pool's DB_STATEMENT_TIMEOUT.

const API_TIMEOUT_MS = 15_000;
const PS_TIMEOUT_MS = 5_000;

// Tolerant API-Football /status envelope: only the fields we read are pinned,
// each nullable, so a vendor-side addition or null never throws.
const apiStatusSchema = z.object({
    response: z.object({
        subscription: z.object({
            plan: z.string().nullable().optional(),
            end: z.string().nullable().optional(),
        }).passthrough(),
        requests: z.object({
            current: z.union([z.number(), z.string()]).nullable().optional(),
            limit_day: z.union([z.number(), z.string()]).nullable().optional(),
        }).passthrough(),
    }).passthrough(),
}).passthrough();

export async function loadAdminPhone(db) {
    const [rows] = await db.raw(
        "SELECT phone FROM users WHERE role = 'admin' AND is_active = 1 AND phone IS NOT NULL AND phone <> '' "
        + 'ORDER BY id LIMIT 1');
    return rows && rows[0] && rows[0].phone ? String(rows[0].phone) : null;
}

// Fill the DB-derived half of `snap` (mutated in place). Each read is its own
// labelled query: one failure records `unread:<label>` (AMBER weight in the
// verdict) and the rest still run. The first probe (clock + DATABASE()) is
// the reachability test and is allowed to throw: an unreachable DB is the
// caller's to classify. Resolves { adminPhone }.
export async function collectDbSignals(db, snap) {
    const q = async (label, sql) => {
        try {
            const [rows] = await db.raw(sql);
            return rows;
        } catch (e) {
            snap.unread.push(label);
            snap.reasons.push(`unread:${label}`);
            // The message can embed the SQL but never a credential; still truncated.
            snap.errors = snap.errors || [];
            snap.errors.push(`${label}: ${String((e && e.message) || e).slice(-160)}`);
            return null;
        }
    };

    const [nowRow] = await db.raw(
        "SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now_eat, "
        + "DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today, "
        + "DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d') AS yday, "
        + "DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d') AS tmrw, DATABASE() AS dbname");
    const clock = nowRow[0];
    snap.day = clock.today;
    snap.db_name = clock.dbname;
    snap.now_eat = clock.now_eat;
    const nowMs = eatStringToMs(clock.now_eat) ?? Date.now();

    // Light passes, last 24h, oldest first.
    const light = await q('light_runs',
        "SELECT id, verdict, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS s "
        + "FROM collection_runs WHERE mode = 'light' AND started_at >= NOW() - INTERVAL 24 HOUR "
        + 'ORDER BY started_at');
    // Full runs, last 36h, newest first.
    const fulls = await q('full_runs',
        "SELECT id, verdict, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS s, "
        + "DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s') AS f, "
        + "LEFT(COALESCE(step_failures, '[]'), 2000) AS sf "
        + "FROM collection_runs WHERE mode = 'full' AND started_at >= NOW() - INTERVAL 36 HOUR "
        + 'ORDER BY id DESC LIMIT 3');

    const { full, windows } = summarizeFull(fulls, nowMs);
    snap.full = full;
    if (light) snap.light = summarizeLight(light, windows, nowMs);

    const meta = await q('meta',
        "SELECT k, v FROM meta WHERE k IN ('last_odds_at', 'last_success', 'job_state', 'warehouse_version')");
    if (meta) snap.meta = parseMetaRows(meta, nowMs);

    // Read after meta so a sweep that is still running (not yet in the
    // ledger) is recognised through the job_state beacon.
    snap.full_missing_today = fullMissingToday({
        rows: fulls, today: clock.today, nowEat: clock.now_eat, jobState: snap.meta.job_state,
    });

    const nearby = await q('fixtures_nearby',
        'SELECT COUNT(*) AS n FROM matches '
        + 'WHERE start_time >= NOW() - INTERVAL 2 HOUR AND start_time <= NOW() + INTERVAL 6 HOUR');
    if (nearby) snap.fixtures_nearby = num(nearby[0].n);

    const maxSql = COUNTER_TABLES
        .map(([t, c]) => `SELECT '${t}' AS t, MAX(${c}) AS v FROM ${t}`)
        .join(' UNION ALL ');
    const maxRows = await q('max_id', maxSql);
    if (maxRows) for (const r of maxRows) snap.counters.max_id[r.t] = num(r.v);

    const names = COUNTER_TABLES.map(([t]) => `'${t}'`).join(',');
    const est = await q('rows_estimate',
        'SELECT TABLE_NAME AS t, TABLE_ROWS AS r, ROUND((DATA_LENGTH + INDEX_LENGTH) / 1048576, 1) AS mb '
        + 'FROM information_schema.tables '
        + `WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${names})`);
    if (est) {
        for (const r of est) {
            snap.counters.rows_estimate[r.t] = num(r.r);
            snap.counters.mb[r.t] = num(r.mb);
        }
    }

    // fixtures.kickoff carries fixtures_kickoff_index, so this is a range read.
    const finals = await q('finals_yesterday',
        'SELECT COUNT(*) AS n FROM fixtures '
        + 'WHERE kickoff >= (CURDATE() - INTERVAL 1 DAY) AND kickoff < CURDATE() '
        + "AND status IN ('FT', 'AET', 'PEN')");
    if (finals) snap.counters.finals_yesterday = num(finals[0].n);

    const cov = await q('coverage',
        "SELECT DATE_FORMAT(start_time, '%Y-%m-%d') AS d, provider, COUNT(*) AS n, "
        + 'SUM(fixture_id IS NOT NULL) AS linked FROM matches '
        + 'WHERE start_time >= (CURDATE() - INTERVAL 1 DAY) AND start_time < (CURDATE() + INTERVAL 2 DAY) '
        + 'GROUP BY 1, 2');
    if (cov) snap.coverage = summarizeCoverage(cov, clock);

    const nStat = await q('notices', 'SELECT status, COUNT(*) AS n FROM data_notices GROUP BY status');
    if (nStat) {
        for (const r of nStat) {
            if (r.status === 'unconfirmed' || r.status === 'approved') snap.notices.by_status[r.status] = num(r.n);
        }
    }
    const nNew = await q('notices_new',
        "SELECT id, kind, DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS c FROM data_notices "
        + "WHERE status = 'unconfirmed' AND created_at >= NOW() - INTERVAL 24 HOUR ORDER BY id");
    if (nNew) snap.notices.new_unconfirmed_24h = nNew.map(r => ({ id: r.id, kind: r.kind, at: r.c }));
    const nMax = await q('notices_newest', 'SELECT MAX(id) AS n FROM data_notices');
    if (nMax) snap.notices.newest_id = num(nMax[0].n);

    const st = await q('db_status', "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')");
    if (st) {
        for (const r of st) {
            if (r.Variable_name === 'Uptime') snap.host.db_uptime_s = num(r.Value);
            if (r.Variable_name === 'Threads_connected') snap.host.db_threads_connected = num(r.Value);
        }
    }

    let adminPhone = null;
    try {
        adminPhone = await loadAdminPhone(db);
    } catch {
        snap.unread.push('admin_phone');
        snap.reasons.push('unread:admin_phone');
    }
    return { adminPhone };
}

function run(cmd, args, timeout) {
    return new Promise(resolve => {
        try {
            execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout) => {
                resolve(err && !stdout ? null : String(stdout || ''));
            });
        } catch {
            resolve(null);
        }
    });
}

function readTailLine(file, bytes = 8192) {
    try {
        const size = fs.statSync(file).size;
        const start = Math.max(0, size - bytes);
        const buf = Buffer.alloc(size - start);
        const fd = fs.openSync(file, 'r');
        try {
            fs.readSync(fd, buf, 0, buf.length, start);
        } finally {
            fs.closeSync(fd);
        }
        const lines = buf.toString('utf8').replace(/\r/g, '').split('\n').filter(l => l.trim());
        return lines.length ? lines[lines.length - 1] : null;
    } catch {
        return null;
    }
}

// Host-side signals, every one best-effort. Never throws.
//   appRoot    - the app directory (logs/ lives under it; lsnode args carry it)
//   diskPath   - the filesystem to measure (defaults to appRoot)
//   user       - ps owner filter
//   markUnread - the cron reports an unreadable host signal as `unread:*`
//                (AMBER); the in-app snapshot does not, because a dev box or a
//                non-Passenger host legitimately has no lsnode and no ps, and
//                that must not turn every local snapshot AMBER.
export async function collectHost(snap, { appRoot, diskPath = appRoot, user = null, markUnread = false } = {}) {
    const unread = label => {
        if (!markUnread) return;
        snap.unread.push(label);
        snap.reasons.push(`unread:${label}`);
    };

    const ps = process.platform === 'win32'
        ? null
        : await run('ps', user ? ['-u', user, '-o', 'pid,etime,args'] : ['-e', '-o', 'pid,etime,args'], PS_TIMEOUT_MS);
    if (ps == null) {
        unread('lsnode');
    } else {
        const lines = ps.split('\n').filter(l => l.includes(`lsnode:${appRoot}/`));
        let oldest = 0;
        for (const l of lines) oldest = Math.max(oldest, etimeToSeconds(l.trim().split(/\s+/)[1]));
        // In-process, zero matches means this process is not under lsnode at
        // all (a dev box, `npm run serve`): unknown, not "no instances".
        if (lines.length || markUnread) {
            snap.host.lsnode_count = lines.length;
            snap.host.lsnode_oldest_days = lines.length ? Math.round((oldest / 86_400) * 10) / 10 : 0;
        }
    }

    try {
        const st = await fs.promises.statfs(diskPath);
        snap.host.disk_free_gb = Math.round(((Number(st.bavail) * Number(st.bsize)) / 1_073_741_824) * 10) / 10;
        if (!Number.isFinite(snap.host.disk_free_gb)) snap.host.disk_free_gb = null;
    } catch {
        snap.host.disk_free_gb = null;
    }
    if (snap.host.disk_free_gb == null) unread('disk');

    // Watchdog log tail, only if it is actually recent. A months-old last line
    // is not a signal, it is noise, so it reports as null.
    const line = readTailLine(path.join(appRoot, 'logs', 'watchdog.log'));
    if (line) {
        const m = line.match(/^\[([^\]]+)\]/);
        const ms = m ? Date.parse(m[1]) : NaN;
        if (Number.isFinite(ms) && Date.now() - ms <= 24 * 3_600_000) snap.watchdog.last_log_line = line.slice(0, 400);
    }
    try {
        snap.watchdog.state = JSON.parse(fs.readFileSync(path.join(appRoot, 'logs', 'watchdog-state.json'), 'utf8'));
    } catch {
        snap.watchdog.state = null;
    }
}

// API-Football plan and quota. The key is used only as a request header: never
// logged, never stored. A failure adds `api_status_unavailable` (AMBER). Never
// throws.
export async function collectApiStatus(snap, { url, key } = {}) {
    try {
        if (!url || !key) throw new Error('not configured');
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
        let json;
        try {
            const res = await fetch(`${url}/status`, {
                headers: { 'x-apisports-key': key, Accept: 'application/json' },
                signal: ac.signal,
            });
            if (!res.ok) throw new Error(`http ${res.status}`);
            json = await res.json();
        } finally {
            clearTimeout(t);
        }
        const parsed = apiStatusSchema.parse(json);
        const sub = parsed.response.subscription;
        const req = parsed.response.requests;
        snap.api.plan = sub.plan ?? null;
        snap.api.plan_end = sub.end ?? null;
        snap.api.requests_today = num(req.current);
        snap.api.limit_day = num(req.limit_day);
        const endMs = sub.end ? Date.parse(sub.end) : NaN;
        snap.api.plan_days_left = Number.isFinite(endMs) ? Math.round((endMs - Date.now()) / 86_400_000) : null;
    } catch {
        snap.reasons.push('api_status_unavailable');
    }
}
