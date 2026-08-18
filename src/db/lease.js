import { db } from './connection.js';
import { WRITER_LOCK, lockOutcome, leaseTransition } from './lease-rules.js';

// Single-writer lease over a MariaDB named lock (GET_LOCK), held on a
// PINNED connection for as long as this process is the writer. The live
// host runs three concurrent `src/server.js` processes; later tasks gate
// singleton work (the scheduler, the AI worker, geo backfill) on
// `isWriter()` so exactly one instance does it. GET_LOCK is re-entrant on
// the same connection, so re-running it every tick while we already hold
// the lock both renews it (nothing to renew - it never expires on its own)
// and doubles as a liveness check on the pinned connection.

let _writer = false;
let _conn = null;
let _since = null;
let _lastCheck = null;
let _lastError = null;
let _attempts = 0;
let _tickTimer = null;

export function isWriter() {
    return _writer;
}

export function leaseStatus() {
    return { writer: _writer, since: _since, last_check: _lastCheck, last_error: _lastError, attempts: _attempts };
}

function _applyTransition(outcome) {
    const t = leaseTransition(_writer, outcome);
    _writer = t.now;
    if (t.event === 'gained') {
        _since = Date.now();
        console.info('[lease] writer gained');
    } else if (t.event === 'lost') {
        _since = null;
        console.info('[lease] writer lost');
    }
}

async function _releasePinnedConnection() {
    if (!_conn) return;
    const conn = _conn;
    _conn = null;
    try {
        db.client.releaseConnection(conn);
    } catch {
        // ignore - the connection may already be dead
    }
}

// One attempt: acquire (or renew) the lock on the pinned connection,
// pinning a fresh connection first if we don't hold one yet. Returns
// whether this process is the writer after the attempt. Never throws -
// any failure releases the pin, marks us non-writer, and the next tick
// (or the next explicit call) starts over from a clean connection.
export async function tryAcquireWriter() {
    _attempts += 1;
    _lastCheck = Date.now();
    try {
        if (!_conn) {
            _conn = await db.client.acquireConnection();
        }
        // mysql2 raw responses come back as [rows, fields] - unwrap to rows.
        const [rows] = await db.raw('SELECT GET_LOCK(?, 0) AS got', [WRITER_LOCK]).connection(_conn);
        const outcome = lockOutcome(rows);
        _applyTransition(outcome);
        if (outcome !== 'acquired') {
            await _releasePinnedConnection();
        }
        _lastError = null;
    } catch (e) {
        _lastError = e?.message || String(e);
        await _releasePinnedConnection();
        _applyTransition('error');
    }
    return _writer;
}

export function startWriterLease(intervalMs = 30_000) {
    if (_tickTimer) return;
    tryAcquireWriter();
    _tickTimer = setInterval(tryAcquireWriter, intervalMs);
    _tickTimer.unref?.();
}

export async function stopWriterLease() {
    if (_tickTimer) {
        clearInterval(_tickTimer);
        _tickTimer = null;
    }
    if (_conn) {
        try {
            await db.raw('SELECT RELEASE_LOCK(?)', [WRITER_LOCK]).connection(_conn);
        } catch {
            // ignore - releasing a lock on a dead connection is a no-op anyway
        }
        await _releasePinnedConnection();
    }
    _writer = false;
    _since = null;
}
