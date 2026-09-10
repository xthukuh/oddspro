// prod-health.mjs - zero-token daily production health snapshot for oddspro.
//
// Runs once a day on the live host, reads only cheap signals, and answers two
// questions: is collection running religiously, and how much history has piled
// up for pattern mining. Writes one JSON line per run to ~/ops/health/
// ledger.ndjson, plus latest.json and a human latest.txt. Creates an ALERT file
// on RED and removes it otherwise. Prints nothing on GREEN so cron stays quiet.
// ALWAYS exits 0: a health probe must never mail cron a stack trace.
//
// Rules that keep it safe on this host (shared cPanel, load average ~24):
//   - never scan a big table. odds_markets has 17.4M rows and no index on
//     updated_at, and the host kills long scans. Only MAX() on a primary key
//     (O(1) in InnoDB), information_schema estimates, small tables, and
//     indexed date ranges on matches.start_time / fixtures.kickoff.
//   - never read or print a secret. Credentials come from the app's own
//     connection module and config module; nothing is echoed.
//   - never touch an existing file. Everything written lives under ~/ops/health.
//
// Usage: cd ~/oddspro-app-v1.4.0 && ~/nodevenv/oddspro-app-v1.4.0/22/bin/node ~/ops/prod-health.mjs
// The cwd matters: dotenv resolves .env relative to process.cwd().

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const HOME = process.env.HOME || '/home2/oddsprok';
const APP_ROOT = `${HOME}/oddspro-app-v1.4.0`;
const OUT_DIR = `${HOME}/ops/health`;
const LEDGER = path.join(OUT_DIR, 'ledger.ndjson');
const LATEST_JSON = path.join(OUT_DIR, 'latest.json');
const LATEST_TXT = path.join(OUT_DIR, 'latest.txt');
const ALERT = path.join(OUT_DIR, 'ALERT');
const HARD_TIMEOUT_MS = 120_000;
const API_TIMEOUT_MS = 15_000;

// Accumulation counters. The leading primary-key column differs per table:
// four of these are keyed on fixture_id and have no `id` column at all, which
// is why a naive MAX(id) UNION dies with "Unknown column 'id'". MAX() on the
// leading PK column is an index read either way.
const COUNTER_TABLES = [
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

// EAT is UTC+3 with no DST, so shifting the epoch and slicing the UTC date is
// exact and does not depend on the host TZ being set correctly.
function eatDay(d = new Date()) {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

function eatStamp(d = new Date()) {
  return new Date(d.getTime() + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

// A stored DATETIME is EAT wall clock. SQL hands it back as a formatted string
// (never a Date) so the toISOString day-shift trap cannot bite; this turns it
// back into a real instant.
function eatStringToMs(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 3, +m[5], +m[6]);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function minutesSince(ms, nowMs) {
  return ms == null ? null : Math.round((nowMs - ms) / 60_000);
}

function run(cmd, args, timeout = 10_000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout) => {
      resolve(err && !stdout ? null : String(stdout || ''));
    });
  });
}

// ps etime is [[DD-]HH:]MM:SS.
function etimeToSeconds(s) {
  const t = String(s).trim();
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
  return days * 86_400 + h * 3600 + m * 60 + sec;
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
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // A truncated first slice or a half-written line: keep walking back.
      }
    }
  } catch {
    // No ledger yet - this is the first run.
  }
  return null;
}

function baseSnapshot() {
  const now = new Date();
  return {
    ts: now.toISOString(),
    day: eatDay(now),
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

// The active admin's phone, read during the DB pass and kept OUT of the
// snapshot so it never lands in the ledger. RED escalation falls back to it
// when OPS_ALERT_PHONE is unset, mirroring scripts/collection-watchdog.js.
let adminPhone = null;

async function collectDb(snap) {
  const { db, closeDb } = await import(`${APP_ROOT}/src/db/connection.js`);
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

  try {
    // A DATABASE()/NOW() probe doubles as the reachability test: if the pool
    // cannot connect this throws, and the whole run is RED db_unreachable.
    const [nowRow] = await db.raw(
      "SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s') AS now_eat, "
      + "DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today, "
      + "DATE_FORMAT(CURDATE() - INTERVAL 1 DAY, '%Y-%m-%d') AS yday, "
      + "DATE_FORMAT(CURDATE() + INTERVAL 1 DAY, '%Y-%m-%d') AS tmrw, DATABASE() AS dbname"
    );
    const clock = nowRow[0];
    snap.day = clock.today;
    snap.db_name = clock.dbname;
    snap.now_eat = clock.now_eat;
    const nowMs = eatStringToMs(clock.now_eat) ?? Date.now();

    // --- light passes, last 24h -------------------------------------------
    const light = await q('light_runs',
      "SELECT id, verdict, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS s "
      + "FROM collection_runs WHERE mode = 'light' AND started_at >= NOW() - INTERVAL 24 HOUR "
      + 'ORDER BY started_at');
    // --- full runs, last 36h ----------------------------------------------
    const fulls = await q('full_runs',
      "SELECT id, verdict, DATE_FORMAT(started_at, '%Y-%m-%d %H:%i:%s') AS s, "
      + "DATE_FORMAT(finished_at, '%Y-%m-%d %H:%i:%s') AS f, "
      + "LEFT(COALESCE(step_failures, '[]'), 2000) AS sf "
      + "FROM collection_runs WHERE mode = 'full' AND started_at >= NOW() - INTERVAL 36 HOUR "
      + 'ORDER BY id DESC LIMIT 3');

    let fullWindows = [];
    if (fulls && fulls.length) {
      fullWindows = fulls.map(r => [eatStringToMs(r.s), eatStringToMs(r.f) ?? nowMs]).filter(w => w[0] != null);
      const r = fulls[0];
      let stepFailures = [];
      try {
        stepFailures = JSON.parse(r.sf || '[]');
      } catch {
        stepFailures = [String(r.sf).slice(0, 200)];
      }
      const sMs = eatStringToMs(r.s);
      const fMs = eatStringToMs(r.f);
      snap.full = {
        id: r.id,
        started_at: r.s,
        finished_at: r.f,
        duration_s: sMs != null && fMs != null ? Math.round((fMs - sMs) / 1000) : null,
        verdict: r.verdict,
        step_failures: stepFailures,
      };
    }
    // A full sweep starts 05:00 EAT and runs 2.5-7h. Only call it missing once
    // the day is well past that, so an early run never cries wolf.
    const startedToday = (fulls || []).some(r => String(r.s).slice(0, 10) === clock.today);
    const hourEat = Number(String(clock.now_eat).slice(11, 13));
    snap.full_missing_today = !startedToday && hourEat >= 13;

    if (light) {
      const byVerdict = {};
      for (const r of light) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
      snap.light.by_verdict = byVerdict;
      snap.light.total_24h = light.length;
      snap.light.last_light_at = light.length ? light[light.length - 1].s : null;
      // Largest gap between consecutive light passes, with any overlap with a
      // full-sweep window subtracted: the light pass legitimately stands down
      // while the sweep holds the single job slot, so that stretch is not a
      // gap in collection.
      let maxGap = 0;
      for (let i = 1; i < light.length; i++) {
        const a = eatStringToMs(light[i - 1].s);
        const b = eatStringToMs(light[i].s);
        if (a == null || b == null) continue;
        let span = b - a;
        for (const [ws, we] of fullWindows) {
          span -= Math.max(0, Math.min(b, we) - Math.max(a, ws));
        }
        maxGap = Math.max(maxGap, span);
      }
      // Also measure the stretch from the last pass to now, so a collector that
      // stopped an hour ago is visible before the next scheduled pass.
      const lastMs = light.length ? eatStringToMs(light[light.length - 1].s) : null;
      if (lastMs != null) {
        let tail = nowMs - lastMs;
        for (const [ws, we] of fullWindows) {
          tail -= Math.max(0, Math.min(nowMs, we) - Math.max(lastMs, ws));
        }
        maxGap = Math.max(maxGap, tail);
      }
      snap.light.light_max_gap_min = light.length > 1 ? Math.round(maxGap / 60_000) : null;
    }

    // --- meta --------------------------------------------------------------
    const meta = await q('meta',
      "SELECT k, v FROM meta WHERE k IN ('last_odds_at', 'last_success', 'job_state', 'warehouse_version')");
    if (meta) {
      const parse = v => {
        try {
          return JSON.parse(v);
        } catch {
          return v ?? null;
        }
      };
      const byKey = Object.fromEntries(meta.map(r => [r.k, parse(r.v)]));
      snap.meta.last_odds_at = byKey.last_odds_at ?? null;
      snap.meta.last_success = byKey.last_success ?? null;
      snap.meta.job_state = byKey.job_state ?? null;
      snap.meta.warehouse_version = byKey.warehouse_version ?? null;
      const oddsMs = snap.meta.last_odds_at ? Date.parse(snap.meta.last_odds_at) : NaN;
      snap.meta.odds_age_min = Number.isFinite(oddsMs) ? minutesSince(oddsMs, nowMs) : null;
    }

    // Staleness only counts when there is something to scrape (the watchdog's
    // own rule, src/db/watchdog-rules.js): a quiet slate is not an outage.
    const nearby = await q('fixtures_nearby',
      'SELECT COUNT(*) AS n FROM matches '
      + 'WHERE start_time >= NOW() - INTERVAL 2 HOUR AND start_time <= NOW() + INTERVAL 6 HOUR');
    if (nearby) snap.fixtures_nearby = num(nearby[0].n);

    // --- accumulation counters --------------------------------------------
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

    // --- pre-match coverage by provider, indexed on matches.start_time ------
    const cov = await q('coverage',
      "SELECT DATE_FORMAT(start_time, '%Y-%m-%d') AS d, provider, COUNT(*) AS n, "
      + 'SUM(fixture_id IS NOT NULL) AS linked FROM matches '
      + 'WHERE start_time >= (CURDATE() - INTERVAL 1 DAY) AND start_time < (CURDATE() + INTERVAL 2 DAY) '
      + 'GROUP BY 1, 2');
    if (cov) {
      const slot = { [clock.yday]: 'yesterday', [clock.today]: 'today', [clock.tmrw]: 'tomorrow' };
      for (const r of cov) {
        const key = slot[r.d];
        if (key) snap.coverage[key][r.provider] = { n: num(r.n), linked: num(r.linked) };
      }
    }

    // --- data notices ------------------------------------------------------
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

    // --- server ------------------------------------------------------------
    const st = await q('db_status',
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')");
    if (st) {
      for (const r of st) {
        if (r.Variable_name === 'Uptime') snap.host.db_uptime_s = num(r.Value);
        if (r.Variable_name === 'Threads_connected') snap.host.db_threads_connected = num(r.Value);
      }
    }

    // --- alert target (never persisted) ------------------------------------
    const adm = await q('admin_phone',
      "SELECT phone FROM users WHERE role = 'admin' AND is_active = 1 AND phone IS NOT NULL AND phone <> '' ORDER BY id LIMIT 1");
    adminPhone = adm && adm[0] && adm[0].phone ? String(adm[0].phone) : null;
  } finally {
    await closeDb();
  }
}

async function collectHost(snap) {
  const ps = await run('ps', ['-u', process.env.USER || 'oddsprok', '-o', 'pid,etime,args']);
  if (ps == null) {
    snap.unread.push('lsnode');
    snap.reasons.push('unread:lsnode');
  } else {
    const lines = ps.split('\n').filter(l => l.includes(`lsnode:${APP_ROOT}/`));
    snap.host.lsnode_count = lines.length;
    let oldest = 0;
    for (const l of lines) {
      const parts = l.trim().split(/\s+/);
      oldest = Math.max(oldest, etimeToSeconds(parts[1]));
    }
    snap.host.lsnode_oldest_days = lines.length ? Math.round((oldest / 86_400) * 10) / 10 : 0;
  }

  const df = await run('df', ['-k', HOME]);
  const rows = df == null ? [] : df.trim().split('\n').slice(1).map(l => l.trim().split(/\s+/));
  const row = rows.find(r => r.length >= 4);
  snap.host.disk_free_gb = row ? Math.round((Number(row[3]) / 1_048_576) * 10) / 10 : null;
  if (snap.host.disk_free_gb == null) {
    snap.unread.push('disk');
    snap.reasons.push('unread:disk');
  }

  // Watchdog log tail, only if it is actually recent. A months-old last line is
  // not a signal, it is noise, so it reports as null.
  const line = readTailLine(`${APP_ROOT}/logs/watchdog.log`);
  if (line) {
    const m = line.match(/^\[([^\]]+)\]/);
    const ms = m ? Date.parse(m[1]) : NaN;
    if (Number.isFinite(ms) && Date.now() - ms <= 24 * 3_600_000) snap.watchdog.last_log_line = line.slice(0, 400);
  }
  try {
    snap.watchdog.state = JSON.parse(fs.readFileSync(`${APP_ROOT}/logs/watchdog-state.json`, 'utf8'));
  } catch {
    snap.watchdog.state = null;
  }
}

// The API key is read from the app's validated config and used only as a
// request header. It is never logged, never stored, never measured.
async function collectApi(snap) {
  try {
    const { config } = await import(`${APP_ROOT}/src/config.js`);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
    let json;
    try {
      const res = await fetch(`${config.X_APISPORTS_URL}/status`, {
        headers: { 'x-apisports-key': config.X_APISPORTS_KEY, Accept: 'application/json' },
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(t);
    }
    const sub = json && json.response && json.response.subscription;
    const req = json && json.response && json.response.requests;
    if (!sub || !req) throw new Error('unexpected status payload');
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

function decide(snap) {
  const red = [];
  const amber = [];
  const nearby = (snap.fixtures_nearby ?? 0) > 0;
  const age = snap.meta.odds_age_min;

  if (age != null && age > 120 && nearby) red.push(`odds_stale:${age}m`);
  else if (age != null && age >= 60 && age <= 120 && nearby) amber.push(`odds_aging:${age}m`);

  if (snap.full_missing_today) red.push('full_missing_today');
  if (snap.full && snap.full.verdict === 'failed') red.push(`full_failed:${snap.full.id}`);
  if (snap.full && snap.full.verdict === 'partial') amber.push(`full_partial:${snap.full.id}`);

  const failed = snap.light.by_verdict.failed || 0;
  const partial = snap.light.by_verdict.partial || 0;
  if (failed >= 5) red.push(`light_failed:${failed}`);
  else if (failed >= 1) amber.push(`light_failed:${failed}`);
  if (partial >= 5) amber.push(`light_partial:${partial}`);

  const gap = snap.light.light_max_gap_min;
  if (gap != null && gap > 90) red.push(`light_gap:${gap}m`);
  else if (gap != null && gap >= 45) amber.push(`light_gap:${gap}m`);

  if (snap.api.plan_days_left != null) {
    if (snap.api.plan_days_left < 0) red.push(`api_plan_expired:${snap.api.plan_end}`);
    else if (snap.api.plan_days_left <= 10) amber.push(`api_plan_soon:${snap.api.plan_days_left}d`);
  }
  if (snap.api.requests_today != null && snap.api.limit_day) {
    const pct = Math.round((snap.api.requests_today / snap.api.limit_day) * 100);
    if (pct > 80) amber.push(`api_quota_high:${pct}%`);
  }

  // Flatlined odds: the same odds_markets high-water mark as a full day ago
  // means nothing has been written since, whatever the freshness stamp claims.
  const prevMax = snap.prev.odds_markets_max_id;
  const curMax = snap.counters.max_id.odds_markets;
  if (prevMax != null && curMax != null && snap.prev.age_h != null && snap.prev.age_h >= 20 && prevMax === curMax) {
    red.push(`odds_flatlined:${curMax}`);
  }

  if (snap.host.disk_free_gb != null && snap.host.disk_free_gb < 25) amber.push(`disk_low:${snap.host.disk_free_gb}GB`);
  if (snap.host.lsnode_count != null && snap.host.lsnode_count >= 4) amber.push(`lsnode_many:${snap.host.lsnode_count}`);
  if (snap.host.lsnode_oldest_days != null && snap.host.lsnode_oldest_days > 14) {
    amber.push(`lsnode_old:${snap.host.lsnode_oldest_days}d`);
  }

  const newNotices = snap.notices.new_unconfirmed_24h.length;
  if (newNotices >= 1) amber.push(`notices_new:${newNotices}`);

  // Reasons already collected during the read pass (unread:* and
  // api_status_unavailable) are AMBER-weight evidence of a blind spot.
  const carried = snap.reasons.slice();
  snap.reasons = [...red, ...amber, ...carried];
  snap.verdict = red.length ? 'RED' : (amber.length || carried.length) ? 'AMBER' : 'GREEN';
}

function renderTxt(snap) {
  const L = [];
  const p = s => L.push(s);
  const kv = (k, v) => p(`  ${k.padEnd(24)} ${v}`);
  p(`oddspro production health  ${snap.verdict}  ${snap.day}  (generated ${eatStamp(new Date(snap.ts))} EAT)`);
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
  for (const [t] of COUNTER_TABLES) {
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

async function escalate(snap) {
  if (snap.verdict !== 'RED') return;
  const to = process.env.OPS_ALERT_PHONE || adminPhone;
  if (!to) {
    snap.reasons.push('no_alert_phone');
    return;
  }
  try {
    const { sendSms } = await import(`${APP_ROOT}/src/sms/index.js`);
    const text = `oddspro RED ${snap.day}: ${snap.reasons.join(', ')}`.slice(0, 140);
    const res = await sendSms({ to, text });
    snap.alerted = Boolean(res && res.ok);
  } catch (e) {
    snap.reasons.push('alert_send_failed');
    snap.alert_error = String((e && e.message) || e).slice(0, 160);
  }
}

function persist(snap) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const txt = renderTxt(snap);
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

async function collect() {
  const snap = baseSnapshot();
  const prev = readPrevLedgerLine();
  if (prev) {
    snap.prev.ts = prev.ts ?? null;
    const pMs = prev.ts ? Date.parse(prev.ts) : NaN;
    snap.prev.age_h = Number.isFinite(pMs) ? Math.round(((Date.now() - pMs) / 3_600_000) * 10) / 10 : null;
    snap.prev.odds_markets_max_id = prev.counters && prev.counters.max_id
      ? prev.counters.max_id.odds_markets ?? null
      : null;
  }
  try {
    await collectDb(snap);
  } catch (e) {
    snap.error = String((e && e.message) || e).slice(0, 300);
    snap.reasons.unshift('db_unreachable');
    snap.verdict = 'RED';
    await collectHost(snap).catch(() => {});
    return snap;
  }
  await collectHost(snap).catch(() => {
    snap.reasons.push('unread:host');
  });
  await collectApi(snap);
  decide(snap);
  return snap;
}

async function mainOnce() {
  let snap;
  try {
    const timeout = new Promise(resolve => {
      const t = setTimeout(() => resolve(TIMED_OUT), HARD_TIMEOUT_MS);
      t.unref();
    });
    const raced = await Promise.race([collect(), timeout]);
    if (raced === TIMED_OUT) {
      snap = baseSnapshot();
      snap.verdict = 'RED';
      snap.reasons = [`timeout:${HARD_TIMEOUT_MS / 1000}s`];
      snap.error = 'health run exceeded its hard timeout; the signals below were never populated';
      persist(snap);
      process.exit(0);
    }
    snap = raced;
    await escalate(snap);
    persist(snap);
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
