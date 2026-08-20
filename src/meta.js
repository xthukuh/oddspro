import { db } from './db/connection.js';
import { parseMetaValue, nextVersion } from './db/meta-rules.js';

// Cross-instance meta key/value table. The live host runs three concurrent
// `src/server.js` processes; every in-process singleton (data_version,
// last_success, the discovered column catalog, a pending refresh request)
// used to be triplicated. This module is the shared home for that state:
// `meta` holds one JSON-encoded value per key, and a sync in-memory memo
// (warehouseVersion/lastSuccessMemo) lets hot paths read it without
// awaiting a query, refreshed on a short unref'd poll.

const MEMO_KEYS = ['warehouse_version', 'last_success'];

let _version = 0;
let _lastSuccess = null;
let _pollTimer = null;
let _lastErrorMessage = null;

export async function getMeta(key) {
    const row = await db('meta').where('k', key).first('v');
    return row ? parseMetaValue(row.v) : null;
}

export async function setMeta(key, value) {
    await db('meta')
        .insert({ k: key, v: JSON.stringify(value) })
        .onConflict('k').merge(['v']);
}

// Atomic v = v + 1 (stored as JSON text, so the column literally holds the
// digits of the integer). Inserts the row first if it does not exist yet -
// a fresh DB or a warehouse_version row deleted out from under us must not
// throw. Updates the sync memo so callers see the bump immediately, without
// waiting for the next poll tick.
export async function bumpWarehouseVersion() {
    const exists = await db('meta').where('k', 'warehouse_version').first('k');
    if (!exists) await setMeta('warehouse_version', 0);
    await db('meta')
        .where('k', 'warehouse_version')
        .update({ v: db.raw('CAST(CAST(v AS UNSIGNED) + 1 AS CHAR)') });
    const next = await getMeta('warehouse_version');
    const version = Number.isFinite(next) ? next : nextVersion(_version);
    _version = version;
    return version;
}

export function warehouseVersion() {
    return _version;
}

export function lastSuccessMemo() {
    return _lastSuccess;
}

// One read of both memoized keys -> refresh the sync memo. Never throws -
// a transient DB hiccup must not crash the poll timer or a caller awaiting
// this directly; the previous memo values are kept and the failure is
// logged once per distinct error message (not once per tick).
export async function refreshMetaMemo() {
    try {
        const rows = await db('meta').whereIn('k', MEMO_KEYS).select('k', 'v');
        const byKey = Object.fromEntries(rows.map(r => [r.k, parseMetaValue(r.v)]));
        if (Object.prototype.hasOwnProperty.call(byKey, 'warehouse_version')) {
            const v = byKey.warehouse_version;
            _version = Number.isFinite(v) ? v : _version;
        }
        if (Object.prototype.hasOwnProperty.call(byKey, 'last_success')) {
            _lastSuccess = byKey.last_success;
        }
        // Followers learn about a new or approved notice through the same 5s poll
        // that already carries warehouse_version. Imported lazily to keep meta.js
        // free of a cycle back through notices.js -> meta.js.
        const { refreshNoticeMemo } = await import('./notices.js');
        await refreshNoticeMemo();
        _lastErrorMessage = null;
    } catch (e) {
        const message = e?.message || String(e);
        if (message !== _lastErrorMessage) {
            _lastErrorMessage = message;
            console.error(`[meta] memo refresh failed (${message}) - keeping previous memo`);
        }
    }
}

export function startMetaPoll(intervalMs = 5000) {
    if (_pollTimer) return;
    refreshMetaMemo();
    _pollTimer = setInterval(refreshMetaMemo, intervalMs);
    _pollTimer.unref?.();
}

export function stopMetaPoll() {
    if (_pollTimer) {
        clearInterval(_pollTimer);
        _pollTimer = null;
    }
}
