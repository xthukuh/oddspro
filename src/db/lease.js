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
let _inflight = null; // shared promise while an attempt is in flight (re-entrancy guard)

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

// Ends the pinned connection's underlying MySQL session instead of just
// returning it to the pool. Use this whenever we cannot be sure the
// connection - and the named lock its session may still hold - is actually
// healthy: a MariaDB *server-level* error (query killed, resource limit
// hit) can leave the TCP session alive while still owning
// `oddspro:writer`, and a plain `releaseConnection` would hand that live,
// lock-holding session back into the pool, where it can sit idle for the
// rest of the process's life. Destroying it closes the session, so
// MariaDB frees every lock it held server-side. It is also what correctly
// releases the lock on a clean shutdown: GET_LOCK is called every tick
// while we already hold it (see the module comment), and MariaDB
// increments a per-name counter on each successful GET_LOCK - a single
// RELEASE_LOCK only decrements it by one, so after more than one tick it
// would leave the lock held. Never throws - the connection may already be
// dead. The (now-dead) connection is still handed back to the pool so
// tarn's bookkeeping stays correct; knex's `validateConnection` rejects it
// on the pool's next acquire and tarn's destroyer callback closes it for
// good.
async function _destroyPinnedConnection() {
    if (!_conn) return;
    const conn = _conn;
    _conn = null;
    try {
        conn.destroy?.();
    } catch {
        // already dead
    }
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
//
// Re-entrancy guard: overlapping calls (a slow DB making one tick overlap
// the next, or a future manual "recheck now" caller) must never race on
// the shared `_conn`/`_writer` state across the `await` points below - the
// connection actually holding GET_LOCK could get overwritten out of `_conn`
// and leaked, while the other call's cleanup releases the wrong connection.
// All callers share one in-flight promise instead; a second call while one
// is already running just awaits the first attempt's result.
export function tryAcquireWriter() {
    if (_inflight) return _inflight;
    _inflight = _tryAcquireWriterOnce().finally(() => { _inflight = null; });
    return _inflight;
}

async function _tryAcquireWriterOnce() {
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
        // Destroy rather than release: a server-level error (e.g. the
        // connection hit `max_queries_per_hour`, or was `KILL QUERY`'d) can
        // leave the session alive and still holding `oddspro:writer` - see
        // `_destroyPinnedConnection`.
        await _destroyPinnedConnection();
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
    // Let any in-flight attempt settle first, so we never destroy the
    // connection out from under it (or read a `_conn` it is mid-swap on).
    if (_inflight) {
        await _inflight;
    }
    // Destroy the pinned connection rather than issuing a single
    // RELEASE_LOCK - see `_destroyPinnedConnection` for why one
    // RELEASE_LOCK cannot be trusted to fully release a lock re-acquired
    // every tick.
    await _destroyPinnedConnection();
    _writer = false;
    _since = null;
}
