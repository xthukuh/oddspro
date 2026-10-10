// prod-health.mjs - zero-token daily production health snapshot for oddspro.
//
// Runs once a day on the live host, reads only cheap signals, and answers two
// questions: is collection running religiously, and how much history has piled
// up for pattern mining. Writes one JSON line per run to ~/ops/health/
// ledger.ndjson, plus latest.json and a human latest.txt. Creates an ALERT file
// on RED and removes it otherwise. Prints nothing on GREEN so cron stays quiet.
// ALWAYS exits 0: a health probe must never mail cron a stack trace.
//
// Since 2026-10-10 the signal readers and the verdict are NOT in this file:
// they are imported from the deployed app (src/health-collect.js and the pure
// src/db/health-rules.js), the same modules the app's own in-process snapshot
// uses (src/health.js -> health_snapshots -> GET /api/admin/health/*), so the
// cron and the app can never drift. This script only owns the host side:
// where the files go, the ps/df view of the host, and the text rendering. It
// therefore needs an app build that carries those two modules; against an
// older build it records a RED `rules_module_missing` line instead of running.
//
// Rules that keep it safe on this host (shared cPanel, high load) live with
// the readers in src/health-collect.js: no big-table scans, no secret is ever
// read into the output, everything this script writes lives under ~/ops/health.
//
// Usage: cd ~/oddspro-app-v1.4.0 && ~/nodevenv/oddspro-app-v1.4.0/22/bin/node ~/ops/prod-health.mjs
// The cwd matters: dotenv resolves .env relative to process.cwd().

import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home2/oddsprok';
const APP_ROOT = `${HOME}/oddspro-app-v1.4.0`;
const OUT_DIR = `${HOME}/ops/health`;
const LEDGER = path.join(OUT_DIR, 'ledger.ndjson');
const LATEST_JSON = path.join(OUT_DIR, 'latest.json');
const LATEST_TXT = path.join(OUT_DIR, 'latest.txt');
const ALERT = path.join(OUT_DIR, 'ALERT');

function readPrevLedgerLine() {
    try {
        const size = fs.statSync(LEDGER).size;
        const start = Math.max(0, size - 65_536);
        const buf = Buffer.alloc(size - start);
        const fd = fs.openSync(LEDGER, 'r');
        try {
            fs.readSync(fd, buf, 0, buf.length, start);
        } finally {
            fs.closeSync(fd);
        }
        const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
        const out = [];
        for (let i = lines.length - 1; i >= 0 && out.length < 3; i--) {
            try {
                out.push(JSON.parse(lines[i]));
            } catch {
                // A truncated first slice or a half-written line: keep walking back.
            }
        }
        return out;
    } catch {
        // No ledger yet - this is the first run.
        return [];
    }
}

function renderTxt(R, snap) {
    const L = [];
    const p = s => L.push(s);
    const kv = (k, v) => p(`  ${k.padEnd(24)} ${v}`);
    p(`oddspro production health  ${snap.verdict}  ${snap.day}  (generated ${R.eatStamp(Date.parse(snap.ts))} EAT)`);
    p('='.repeat(72));
    p(snap.reasons.length ? `REASONS: ${snap.reasons.join(', ')}` : 'REASONS: none - all signals within bounds');
    if (snap.error) p(`ERROR: ${snap.error}`);
    p('');
    p('COLLECTION');
    const vb = Object.entries(snap.light.by_verdict).map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
    kv('light passes 24h', `${snap.light.total_24h ?? '?'} (${vb})`);
    kv('last light pass', snap.light.last_light_at || 'none');
    kv('largest gap', snap.light.light_max_gap_min == null
        ? 'n/a'
        : `${snap.light.light_max_gap_min} min (full-sweep window excluded)`);
    if (snap.full) {
        kv('last full sweep',
            `#${snap.full.id} ${snap.full.verdict} ${snap.full.started_at} -> ${snap.full.finished_at || 'running'}`);
        kv('full duration', snap.full.duration_s == null ? 'n/a' : `${Math.round(snap.full.duration_s / 36) / 100} h`);
        kv('full step failures',
            snap.full.step_failures.length ? JSON.stringify(snap.full.step_failures).slice(0, 200) : 'none');
    } else {
        kv('last full sweep', 'none in the last 36h');
    }
    kv('full missing today', String(snap.full_missing_today));
    kv('odds freshness', snap.meta.odds_age_min == null
        ? 'unknown'
        : `${snap.meta.odds_age_min} min old (${snap.meta.last_odds_at})`);
    kv('fixtures nearby', `${snap.fixtures_nearby ?? '?'} (-2h to +6h)`);
    kv('job_state', snap.meta.job_state ? JSON.stringify(snap.meta.job_state) : 'null (idle)');
    kv('warehouse_version', String(snap.meta.warehouse_version ?? '?'));
    p('');
    p('PRE-MATCH COVERAGE (matches by provider, n / linked)');
    for (const slot of ['yesterday', 'today', 'tomorrow']) {
        const byProv = snap.coverage[slot];
        const s = Object.entries(byProv).map(([k, v]) => `${k} ${v.n}/${v.linked}`).join('   ') || 'none';
        kv(slot, s);
    }
    kv('finals yesterday', String(snap.counters.finals_yesterday ?? 'skipped'));
    p('');
    p('DATA ACCUMULATION (max key / est rows / MB)');
    for (const [t] of R.COUNTER_TABLES) {
        kv(t, `${snap.counters.max_id[t] ?? '?'}  /  ${snap.counters.rows_estimate[t] ?? '?'}  /  ${snap.counters.mb[t] ?? '?'} MB`);
    }
    if (snap.prev.ts) {
        const d = snap.prev.odds_markets_max_id != null && snap.counters.max_id.odds_markets != null
            ? snap.counters.max_id.odds_markets - snap.prev.odds_markets_max_id
            : null;
        kv('odds since last run', d == null ? 'n/a' : `+${d} rows over ${snap.prev.age_h}h`);
    } else {
        kv('odds since last run', 'no previous ledger line');
    }
    p('');
    p('NOTICES');
    kv('unconfirmed / approved', `${snap.notices.by_status.unconfirmed ?? 0} / ${snap.notices.by_status.approved ?? 0}`);
    kv('newest notice id', String(snap.notices.newest_id ?? '?'));
    kv('new unconfirmed 24h',
        snap.notices.new_unconfirmed_24h.map(n => `#${n.id} ${n.kind} ${n.at}`).join('; ') || 'none');
    p('');
    p('HOST');
    kv('lsnode instances', `${snap.host.lsnode_count ?? '?'} (oldest ${snap.host.lsnode_oldest_days ?? '?'} days)`);
    kv('disk free', `${snap.host.disk_free_gb ?? '?'} GB`);
    kv('db uptime', snap.host.db_uptime_s == null ? '?' : `${Math.round(snap.host.db_uptime_s / 3600)} h`);
    kv('db threads connected', String(snap.host.db_threads_connected ?? '?'));
    kv('api-football', snap.api.limit_day
        ? `${snap.api.plan} ${snap.api.requests_today}/${snap.api.limit_day} today, plan ends ${snap.api.plan_end} (${snap.api.plan_days_left}d)`
        : 'unavailable');
    kv('watchdog last line', snap.watchdog.last_log_line || 'nothing in 24h');
    kv('watchdog state', snap.watchdog.state ? JSON.stringify(snap.watchdog.state) : 'unreadable');
    p('');
    return L.join('\n') + '\n';
}

async function escalate(R, snap, adminPhone) {
    if (snap.verdict !== 'RED') return;
    const to = R.pickAlertPhone(process.env.OPS_ALERT_PHONE, adminPhone);
    if (!to) {
        snap.reasons.push('no_alert_phone');
        return;
    }
    try {
        const { sendSms } = await import(`${APP_ROOT}/src/sms/index.js`);
        const res = await sendSms({ to, text: R.alertText(snap) });
        snap.alerted = Boolean(res && res.ok);
    } catch (e) {
        snap.reasons.push('alert_send_failed');
        snap.alert_error = String((e && e.message) || e).slice(0, 160);
    }
}

function persist(snap, txt) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(snap) + '\n');
    fs.writeFileSync(LATEST_JSON, JSON.stringify(snap, null, 2) + '\n');
    fs.writeFileSync(LATEST_TXT, txt);
    if (snap.verdict === 'RED') {
        fs.writeFileSync(ALERT, `${snap.ts}\n${snap.reasons.join('\n')}\n`);
    } else {
        try {
            fs.unlinkSync(ALERT);
        } catch {
            // No ALERT file to clear - the normal case.
        }
    }
    // Silence is the GREEN signal: cron mails only what a run prints.
    if (snap.verdict !== 'GREEN') process.stdout.write(txt);
}

const TIMED_OUT = Symbol('timed-out');

async function collect(R, C) {
    const nowMs = Date.now();
    const snap = R.baseSnapshot(nowMs);
    snap.source = 'cron';
    Object.assign(snap.prev, R.prevBlock(readPrevLedgerLine(), nowMs));
    const hostOpts = { appRoot: APP_ROOT, diskPath: HOME, user: process.env.USER || 'oddsprok', markUnread: true };
    let adminPhone = null;
    const { db, closeDb } = await import(`${APP_ROOT}/src/db/connection.js`);
    try {
        adminPhone = (await C.collectDbSignals(db, snap)).adminPhone;
    } catch (e) {
        snap.error = String((e && e.message) || e).slice(0, 300);
        snap.reasons.unshift('db_unreachable');
        snap.verdict = 'RED';
        await C.collectHost(snap, hostOpts).catch(() => {});
        return { snap, adminPhone };
    } finally {
        await closeDb().catch(() => {});
    }
    await C.collectHost(snap, hostOpts).catch(() => {
        snap.reasons.push('unread:host');
    });
    const { config } = await import(`${APP_ROOT}/src/config.js`);
    await C.collectApiStatus(snap, { url: config.X_APISPORTS_URL, key: config.X_APISPORTS_KEY });
    const d = R.decideHealth(snap);
    snap.verdict = d.verdict;
    snap.reasons = d.reasons;
    return { snap, adminPhone };
}

async function mainOnce() {
    let R;
    let C;
    try {
        R = await import(`${APP_ROOT}/src/db/health-rules.js`);
        C = await import(`${APP_ROOT}/src/health-collect.js`);
    } catch (e) {
        // The deployed app predates the shared modules: record the blind day
        // in the shape the digest expects rather than crash or stay silent.
        try {
            const ts = new Date().toISOString();
            const snap = {
                ts, day: new Date(Date.now() + 3 * 3_600_000).toISOString().slice(0, 10), verdict: 'RED',
                reasons: ['rules_module_missing'], error: String((e && e.message) || e).slice(0, 300), source: 'cron',
            };
            persist(snap, `oddspro production health  RED  ${snap.day}\nREASONS: rules_module_missing\nERROR: ${snap.error}\n`);
        } catch {
            // Nothing left to write to.
        }
        process.exit(0);
    }
    try {
        let t;
        const timeout = new Promise(resolve => {
            t = setTimeout(() => resolve(TIMED_OUT), R.HEALTH_HARD_TIMEOUT_MS);
            t.unref();
        });
        const raced = await Promise.race([collect(R, C), timeout]);
        clearTimeout(t);
        if (raced === TIMED_OUT) {
            const snap = R.errorSnapshot(Date.now(),
                'health run exceeded its hard timeout; the signals below were never populated',
                `timeout:${R.HEALTH_HARD_TIMEOUT_MS / 1000}s`);
            snap.source = 'cron';
            persist(snap, renderTxt(R, snap));
            process.exit(0);
        }
        const { snap, adminPhone } = raced;
        await escalate(R, snap, adminPhone);
        persist(snap, renderTxt(R, snap));
    } catch (e) {
        // Last resort: the reporting layer itself failed. Say so on stderr and
        // still leave with 0, because a noisy cron failure is worse than a gap.
        try {
            process.stderr.write(`prod-health: fatal ${String((e && e.message) || e).slice(0, 300)}\n`);
        } catch {
            // stderr is gone; nothing left to do.
        }
    }
    process.exit(0);
}

mainOnce();
