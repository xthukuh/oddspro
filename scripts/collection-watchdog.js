// Stalled-collection watchdog (Task B, 2026-08-19 durability pass -
// docs/research/2026-08-19-odds-durability-and-outage-damage.md). Bookmaker
// odds are view-once: once a market closes, that price is gone from every
// public source forever, so a silent stop in the light pass is the single
// most expensive failure mode this pipeline has. Task A (src/auto-refresh.js)
// stops one step's failure from cascading into skipping every later one; this
// script is the independent outside check that collection is actually moving
// at all, so a failure mode neither step isolation nor anything inside the
// process can catch (a wedged event loop, a dead scheduler, a crashed
// Passenger worker that never restarts on its own) still gets noticed and
// acted on within one cron interval instead of three days.
//
// Run from cron every ~15 minutes, from the app root:
//   node scripts/collection-watchdog.js
//
// Reads MAX(matches.updated_at) (the freshness signal every odds write bumps)
// plus how many fixtures kick off within +-6h for context, classifies the
// reading via the pure src/db/watchdog-rules.js#collectionVerdict, and on a
// 'stale' verdict: logs loudly to logs/watchdog.log (self-truncating like
// src/auto-refresh.js's own job log), touches tmp/restart.txt so Passenger
// recycles the app (one recovery attempt per run, never more, never on
// 'ok'/'idle'), and after WATCHDOG_ALERT_AFTER consecutive stale runs sends
// one SMS to the admin via the existing SMS seam. Consecutive-stale count and
// the alert flag persist in logs/watchdog-state.json across cron runs.
//
// This is cron: it NEVER exits non-zero (a non-zero exit mails the operator
// noise on every quiet-slate tick) and NEVER throws - main() is wrapped, the
// DB pool is always closed in a finally, and the SMS path is its own
// try/catch so a provider outage can never make the watchdog itself fail.
// Everything needed to diagnose a stale reading lives in logs/watchdog.log.
import { mkdirSync, readFileSync, writeFileSync, statSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { db, closeDb } from '../src/db/connection.js';
import { loadOverrides, effective } from '../src/settings.js';
import { trimLogTail } from '../src/db/auto-rules.js';
import { collectionVerdict, nextStaleStreak, shouldAlert } from '../src/db/watchdog-rules.js';
import { sendSms } from '../src/sms/index.js';

const LOG_FILE = path.join(process.cwd(), 'logs', 'watchdog.log');
const STATE_FILE = path.join(process.cwd(), 'logs', 'watchdog-state.json');
const RESTART_FILE = path.join(process.cwd(), 'tmp', 'restart.txt');
const LOG_MAX_BYTES = 256 * 1024; // matches AUTO_LOG_MAX_KB's default cap

// Self-truncating append, mirroring src/auto-refresh.js's own _log - never
// let an error storm fill the disk. Logging must never throw the run.
function _log(line) {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    console.log(`[watchdog] ${stamped}`);
    try {
        mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        try {
            if (statSync(LOG_FILE).size > LOG_MAX_BYTES) {
                writeFileSync(LOG_FILE, trimLogTail(readFileSync(LOG_FILE, 'utf8'), LOG_MAX_BYTES));
            }
        } catch {
            // no log file yet - nothing to trim
        }
        appendFileSync(LOG_FILE, `${stamped}\n`);
    } catch (e) {
        console.error(`[watchdog] log write failed: ${e?.message ?? e}`);
    }
}

// State survives between cron runs - a fresh/corrupt file degrades to a clean
// slate (fail-open, never a reason for the run to abort).
function readState() {
    try {
        const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
        return {
            consecutiveStale: Number.isFinite(parsed?.consecutiveStale) ? parsed.consecutiveStale : 0,
            alerted: Boolean(parsed?.alerted),
        };
    } catch {
        return { consecutiveStale: 0, alerted: false };
    }
}

function writeState(state) {
    try {
        mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        writeFileSync(STATE_FILE, JSON.stringify({ ...state, updated_at: new Date().toISOString() }));
    } catch (e) {
        _log(`state write failed: ${e?.message ?? e}`);
    }
}

// One recovery action: touch tmp/restart.txt so Passenger recycles the app.
// Content is irrelevant - only the mtime matters - but a short note helps a
// human reading the file understand why it changed.
function touchRestartFile(reason) {
    try {
        mkdirSync(path.dirname(RESTART_FILE), { recursive: true });
        writeFileSync(RESTART_FILE, `${new Date().toISOString()} watchdog restart: ${reason}\n`);
        _log(`recovery: touched ${RESTART_FILE}`);
        return true;
    } catch (e) {
        _log(`recovery FAILED: could not touch ${RESTART_FILE}: ${e?.message ?? e}`);
        return false;
    }
}

// Guarded so a provider outage/misconfiguration can never fail the watchdog
// itself - SMS_ENABLED=0 already makes sendSms a console-log no-op (see
// src/sms/index.js), which is fine and not an error.
async function escalate(minutes) {
    try {
        const admin = await db('users').where({ role: 'admin', is_active: 1 }).orderBy('id').select('phone').first();
        if (!admin?.phone) {
            _log('escalation SMS skipped: no active admin user with a phone number found');
            return;
        }
        const text = `oddspro: odds collection stalled ${minutes ?? '?'} minutes, restart attempted`;
        const res = await sendSms({ to: admin.phone, text });
        _log(`escalation SMS ${res?.ok ? 'sent' : 'FAILED'} to ${admin.phone}${res?.dev ? ' (SMS disabled - logged only)' : ''}`);
    } catch (e) {
        _log(`escalation SMS FAILED: ${e?.message ?? e}`);
    }
}

async function main() {
    // CLI actions run under the SAME effective gates as the serve process
    // (src/index.js's own boot discipline) - an admin who tightened
    // WATCHDOG_STALE_MINUTES via Admin -> Settings must see it apply here too.
    await loadOverrides();

    const [{ last } = {}] = await db('matches').select(db.raw('MAX(updated_at) as last'));
    const lastOddsMs = last ? new Date(last).getTime() : null;
    const [{ c: fixturesNearby } = {}] = await db('fixtures')
        .whereRaw('kickoff BETWEEN NOW() - INTERVAL 6 HOUR AND NOW() + INTERVAL 6 HOUR')
        .select(db.raw('COUNT(*) as c'));

    const staleMinutes = Number(effective('WATCHDOG_STALE_MINUTES'));
    const quietStaleMinutes = Number(effective('WATCHDOG_QUIET_STALE_MINUTES'));
    const alertAfter = Number(effective('WATCHDOG_ALERT_AFTER'));

    const verdict = collectionVerdict({
        lastOddsMs, nowMs: Date.now(), fixturesNearby: Number(fixturesNearby) || 0, staleMinutes, quietStaleMinutes,
    });

    console.log(`[watchdog] state=${verdict.state} minutes=${verdict.minutes ?? 'n/a'} `
        + `fixturesNearby=${Number(fixturesNearby) || 0} reason="${verdict.reason}"`);

    const prev = readState();
    const streak = nextStaleStreak(verdict.state, prev.consecutiveStale);
    // The alert flag rides the same reset rule as the streak (see
    // nextStaleStreak's doc comment): cleared on 'ok', held on 'idle' and
    // while still 'stale', so a NEW stale streak escalates again but a
    // still-ongoing one only sends the ONE SMS the spec calls for.
    const alerted = verdict.state === 'ok' ? false : prev.alerted;

    if (verdict.state !== 'stale') {
        writeState({ consecutiveStale: streak, alerted });
        return;
    }

    _log(`STALE - odds collection stalled ${verdict.minutes ?? '?'} minutes (${verdict.reason}); consecutive=${streak}`);
    touchRestartFile(`stalled ${verdict.minutes ?? '?'}m, consecutive=${streak}`);

    let nextAlerted = alerted;
    if (shouldAlert(streak, alertAfter, alerted)) {
        await escalate(verdict.minutes);
        nextAlerted = true;
    }
    writeState({ consecutiveStale: streak, alerted: nextAlerted });
}

(async () => {
    try {
        await main();
    } catch (e) {
        // Never throw out of a cron script - log and still exit 0 (see the
        // file banner). Everything needed to diagnose is in logs/watchdog.log.
        console.error(`[watchdog] ERROR: ${e?.message ?? e}`);
        try { _log(`ERROR: ${e?.message ?? e}`); } catch { /* logging must never throw */ }
    } finally {
        await closeDb();
    }
})();
