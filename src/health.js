import { db } from './db/connection.js';
import { config } from './config.js';
import { effective } from './settings.js';
import { isWriter } from './db/lease.js';
import { sendSms } from './sms/index.js';
import { collectDbSignals, collectHost, collectApiStatus, loadAdminPhone } from './health-collect.js';
import {
    baseSnapshot, decideHealth, errorSnapshot, prevBlock, pickAlertPhone, alertText, decodeSnapshotRow,
    ledgerFreshness, snapshotDecision, nextAttempts, parseDailyTime, eatDateKey, HEALTH_HARD_TIMEOUT_MS,
} from './db/health-rules.js';

// In-app daily production health snapshot (2026-10-10). The same signals and
// verdict as the host cron script scripts/ops/prod-health.mjs (both read
// through src/health-collect.js and src/db/health-rules.js), but persisted to
// the `health_snapshots` table and read back over HTTP
// (GET /api/admin/health/ledger|latest), so monitoring survives the loss of
// SSH access or a move to another server: the weekly digest needs only the
// site URL and the admin bearer.
//
// Writer only: exactly one instance (the `oddspro:writer` lease holder) takes
// the day's snapshot, once per EAT day at or after HEALTH_SNAPSHOT_AT. A
// failed collection still lands a RED `snapshot_error` row; only a failed
// INSERT is retried (backed off, capped per day). Nothing here throws into
// the timer.

const TIMED_OUT = Symbol('timed-out');
const TICK_MS = 60_000;

function withTimeout(promise, ms) {
    let t;
    const timeout = new Promise(resolve => {
        t = setTimeout(() => resolve(TIMED_OUT), ms);
        t.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

const SNAPSHOT_COLUMNS = [
    'id',
    db.raw("DATE_FORMAT(day, '%Y-%m-%d') AS day"),
    db.raw("DATE_FORMAT(taken_at, '%Y-%m-%d %H:%i:%s') AS taken_at"),
    'verdict', 'reasons', 'payload',
];

export async function hasSnapshotForDay(day) {
    const row = await db('health_snapshots').where('day', day).first('id');
    return Boolean(row);
}

// Newest few payloads, newest first, for the flatline rule's "a day ago".
async function recentPayloads(limit = 3) {
    const rows = await db('health_snapshots').orderBy('id', 'desc').limit(limit).select('payload');
    return rows.map(r => decodeSnapshotRow({ payload: r.payload }).payload).filter(Boolean);
}

async function escalate(snap, adminPhone) {
    if (!effective('HEALTH_SNAPSHOT_SMS')) return;
    let phone = adminPhone;
    if (!phone && !config.OPS_ALERT_PHONE) phone = await loadAdminPhone(db).catch(() => null);
    const to = pickAlertPhone(config.OPS_ALERT_PHONE, phone);
    if (!to) {
        snap.reasons.push('no_alert_phone');
        return;
    }
    try {
        const res = await sendSms({ to, text: alertText(snap) });
        snap.alerted = Boolean(res && res.ok);
    } catch (e) {
        snap.reasons.push('alert_send_failed');
        snap.alert_error = String((e && e.message) || e).slice(0, 160);
    }
}

// Collect, decide, escalate on RED, persist. Resolves the stored row summary;
// throws only when the row itself could not be written (the scheduler's cue
// to retry). The admin phone lives in a local and never reaches the payload.
export async function takeHealthSnapshot({ nowMs = Date.now() } = {}) {
    let snap;
    let adminPhone = null;
    try {
        const work = (async () => {
            const s = baseSnapshot(nowMs);
            s.source = 'app';
            Object.assign(s.prev, prevBlock(await recentPayloads(), nowMs));
            adminPhone = (await collectDbSignals(db, s)).adminPhone;
            await collectHost(s, { appRoot: process.cwd(), markUnread: false });
            await collectApiStatus(s, { url: config.X_APISPORTS_URL, key: config.X_APISPORTS_KEY });
            const d = decideHealth(s);
            s.verdict = d.verdict;
            s.reasons = d.reasons;
            return s;
        })();
        const raced = await withTimeout(work, HEALTH_HARD_TIMEOUT_MS);
        if (raced === TIMED_OUT) {
            // The abandoned work keeps mutating its own object, never this one.
            work.catch(() => {});
            snap = errorSnapshot(nowMs, 'health snapshot exceeded its hard timeout', `timeout:${HEALTH_HARD_TIMEOUT_MS / 1000}s`);
        } else {
            snap = raced;
        }
    } catch (e) {
        snap = errorSnapshot(nowMs, e);
    }
    snap.source = 'app';
    if (snap.verdict === 'RED') await escalate(snap, adminPhone);
    const [id] = await db('health_snapshots').insert({
        day: snap.day,
        taken_at: db.fn.now(),
        verdict: snap.verdict,
        reasons: JSON.stringify(snap.reasons),
        payload: JSON.stringify(snap),
    });
    return { id, day: snap.day, verdict: snap.verdict, reasons: snap.reasons };
}

// Snapshots for the last `days` EAT days (today included), oldest first.
export async function healthLedger(days) {
    const rows = await db('health_snapshots')
        .whereRaw('day >= CURDATE() - INTERVAL ? DAY', [Math.max(0, days - 1)])
        .orderBy([{ column: 'day' }, { column: 'id' }])
        .select(SNAPSHOT_COLUMNS);
    const latest = rows.length ? decodeSnapshotRow(rows[rows.length - 1]) : null;
    return {
        days,
        count: rows.length,
        freshness: ledgerFreshness(latest ?? await latestRow(), Date.now(), parseDailyTime(effective('HEALTH_SNAPSHOT_AT'))),
        snapshots: rows.map(decodeSnapshotRow),
    };
}

async function latestRow() {
    const row = await db('health_snapshots').orderBy('id', 'desc').first(SNAPSHOT_COLUMNS);
    return row ? decodeSnapshotRow(row) : null;
}

export async function latestHealth() {
    const latest = await latestRow();
    return {
        freshness: ledgerFreshness(latest, Date.now(), parseDailyTime(effective('HEALTH_SNAPSHOT_AT'))),
        snapshot: latest,
    };
}

// --- scheduler (started/stopped alongside the API server) -------------------
let timer = null;
let firstRun = null;
let running = false;
let doneDay = null;
let attempts = null;

async function tick() {
    if (running) return;
    const nowMs = Date.now();
    const decision = snapshotDecision({
        nowMs,
        atMinutes: parseDailyTime(effective('HEALTH_SNAPSHOT_AT')),
        writer: isWriter(),
        doneDay,
        attempts,
    });
    if (decision !== 'take') return;
    running = true;
    const day = eatDateKey(nowMs);
    try {
        // The DB is the source of truth for "already taken today": it covers a
        // restart and a lease handoff to another instance alike.
        if (await hasSnapshotForDay(day)) {
            doneDay = day;
            return;
        }
        attempts = nextAttempts(attempts, nowMs);
        const r = await takeHealthSnapshot({ nowMs });
        doneDay = day;
        const line = `[health] snapshot ${r.day} ${r.verdict}${r.reasons.length ? ` ${r.reasons.join(', ')}` : ''}`;
        if (r.verdict === 'GREEN') console.info(line);
        else console.warn(line);
    } catch (e) {
        console.error(`[health] snapshot write failed (attempt ${attempts?.count ?? '?'}):`, e?.message ?? e);
    } finally {
        running = false;
    }
}

// First check a minute after boot (the writer lease is normally granted by
// then), then every minute; a check is a Map lookup until the slot is due and
// one indexed read per process per day after it. unref'd so the timers never
// hold the process open.
export function startHealthScheduler() {
    if (timer) return false;
    firstRun = setTimeout(tick, TICK_MS);
    firstRun.unref?.();
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    console.debug(`[health] snapshot scheduler on - daily at ${effective('HEALTH_SNAPSHOT_AT') || 'off'} EAT (writer only)`);
    return true;
}

export function stopHealthScheduler() {
    if (firstRun) { clearTimeout(firstRun); firstRun = null; }
    if (timer) { clearInterval(timer); timer = null; }
}
