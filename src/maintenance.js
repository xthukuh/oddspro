import { effective } from './settings.js';
import { maintenanceInfo } from './db/maintenance-rules.js';

// Live maintenance state for the serve process: the thin settings-reading shell
// around the pure state machine in src/db/maintenance-rules.js (which the web
// imports VERBATIM, so there is exactly one definition of "are we down").
//
// The window lives in the settings catalog (group `maintenance`), not a table,
// so every read is an effective() lookup and past-end auto-expiry is decided by
// the pure machine - a forgotten toggle can never hold a stale 503.

export function maintenanceNow(nowMs = Date.now()) {
    return maintenanceInfo({
        scheduled: effective('MAINTENANCE_SCHEDULED'),
        start: effective('MAINTENANCE_START'),
        end: effective('MAINTENANCE_END'),
        message: effective('MAINTENANCE_MESSAGE'),
    }, nowMs);
}

// Is a window ACTIVE right now? Short-circuits on the scheduled flag so the
// common (off) case costs one catalog Map lookup - this sits on the request
// hot path in server.js and on two scheduler ticks.
//
// QUIESCE POLICY (decided 2026-07-21): an active window pauses the BILLED and
// outbound-facing background work - the AI review worker and the geo backfill -
// but deliberately NOT the auto-refresh light pass. Rationale: a declared
// downtime should not quietly bill Gemini or call a third-party geo API while
// visitors are being told the site is unavailable, but the warehouse should
// still be current the moment the window ends. Odds/results ingestion is the
// product's reason to exist and it does not spend per-call money.
//
// Deliberately NOT applied to: the manual refresh endpoint (admins are exempt
// from the gate and may want exactly that during a window) or the DB
// export/import job (windows exist partly to run those).
export function maintenanceActive(nowMs = Date.now()) {
    if (!effective('MAINTENANCE_SCHEDULED')) return false;
    return maintenanceNow(nowMs).state === 'active';
}
