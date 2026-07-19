// Pure scheduled-maintenance rules (M14, spec decisions 16-18). Zero imports -
// shared VERBATIM by the server 503 gate (src/server.js) and the web client's
// own-clock switch (web/src/App.jsx, out-of-root import like magic-rules), so
// the two can never disagree about what the window means. State lives in the
// settings catalog (group `maintenance`) - no table; a window whose end has
// passed is automatically 'off', so a forgotten toggle can never leave a
// stale 503.
//
// Times are EAT wall-clock 'YYYY-MM-DD HH:mm' strings parsed with an explicit
// +03:00 offset (the KICKOFF_SQL_EXPR lesson): a bare datetime string decodes
// in the HOST's local timezone, so an off-EAT server or browser would shift
// the whole window.

export const DEFAULT_MAINTENANCE_MESSAGE =
    'We will have scheduled maintenance downtime from ${downtime_start} to ${downtime_end}';

// Catalog pattern sources (kept as strings so entries JSON-serialize to the
// admin editor). Blank is valid for all three - an empty window is simply off.
export const MAINT_DT_PATTERN = '^$|^\\d{4}-\\d{2}-\\d{2} ([01]?\\d|2[0-3]):[0-5]\\d$';
// Closed placeholder set (campaign renderTemplate discipline): any ${...}
// other than the two known placeholders is rejected AT SAVE by this pattern;
// a literal non-brace $ stays allowed.
export const MAINT_MSG_PATTERN =
    '^(?:[^$]|\\$(?!\\{)|\\$\\{(?:downtime_start|downtime_end)\\})*$';

const DT_RX = /^(\d{4})-(\d{2})-(\d{2}) ([01]?\d|2[0-3]):([0-5]\d)$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 'YYYY-MM-DD HH:mm' (EAT) -> epoch ms, or null on junk/impossible dates.
// V8's parser ROLLS OVER out-of-range days ('2026-02-31' -> March 3) instead
// of answering NaN, so the calendar components are round-trip-checked: shift
// the instant by +3h and read it with UTC getters (= EAT wall-clock).
function _dtMs(s) {
    const m = DT_RX.exec(String(s ?? '').trim());
    if (!m) return null;
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:00+03:00`);
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms + 3 * 3_600_000);
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return ms;
}

// Validated window or null. Reversed/equal bounds are null - an inverted
// window must read as "no window", never as an always-on 503.
export function parseMaintenanceWindow(start, end) {
    const startMs = _dtMs(start);
    const endMs = _dtMs(end);
    if (startMs == null || endMs == null || endMs <= startMs) return null;
    return { start: String(start).trim(), end: String(end).trim(), startMs, endMs };
}

// The ms-based state core - the client re-evaluates cached epoch bounds on
// its own clock through THIS function, so server and browser share one
// definition of active/scheduled/expired.
export function maintenanceStateAt(startMs, endMs, nowMs) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 'off';
    if (nowMs >= endMs) return 'off'; // past-end auto-expiry - never a stale 503
    return nowMs >= startMs ? 'active' : 'scheduled';
}

// cfg { scheduled, start, end } -> 'off' | 'scheduled' | 'active'.
export function maintenanceState(cfg, nowMs) {
    if (!cfg?.scheduled) return 'off';
    const w = parseMaintenanceWindow(cfg.start, cfg.end);
    return w ? maintenanceStateAt(w.startMs, w.endMs, nowMs) : 'off';
}

// 'YYYY-MM-DD HH:mm' -> 'Sat 19 Jul, 22:30' for the rendered notice. Day-of-
// week is computed in UTC-space over the calendar date (no host-timezone
// decode). Total: junk returns the raw string.
export function formatMaintenanceDt(s) {
    const m = DT_RX.exec(String(s ?? '').trim());
    if (!m) return String(s ?? '');
    const [, y, mo, d, h, mi] = m;
    const dow = DOW[new Date(Date.UTC(+y, +mo - 1, +d)).getUTCDay()];
    return `${dow} ${+d} ${MONTHS[+mo - 1]}, ${h.padStart(2, '0')}:${mi}`;
}

// Render the notice. Total by design: blank template falls to the default,
// a null window renders empty placeholder values, and an UNKNOWN ${...} stays
// literal (MAINT_MSG_PATTERN already rejected it at save - render must never
// throw in a request path).
export function renderMaintenanceNotice(template, window) {
    const t = String(template ?? '').trim() || DEFAULT_MAINTENANCE_MESSAGE;
    const vals = {
        downtime_start: window ? formatMaintenanceDt(window.start) : '',
        downtime_end: window ? formatMaintenanceDt(window.end) : '',
    };
    return t.replace(/\$\{(downtime_start|downtime_end)\}/g, (_, k) => vals[k]);
}

// Banner-dismiss key: dismissal is per window, so an EDITED window (either
// bound) re-surfaces the banner while the same window stays dismissed.
export function windowSignature(start, end) {
    return `${String(start ?? '').trim()}|${String(end ?? '').trim()}`;
}

// Retry-After header value while active: seconds to the window's end.
export function retryAfterSeconds(endMs, nowMs) {
    return Math.max(0, Math.ceil((endMs - nowMs) / 1000));
}

// The payload object the server ships (503 bodies + GET /api/refresh) and the
// client caches in oddspro.maintenance. Epoch bounds ride along so the
// browser's own-clock timers never re-parse wall-clock strings.
export function maintenanceInfo(cfg, nowMs) {
    const state = maintenanceState(cfg, nowMs);
    if (state === 'off') {
        return { state, start: null, end: null, start_ms: null, end_ms: null, message: null, signature: null };
    }
    const w = parseMaintenanceWindow(cfg.start, cfg.end);
    return {
        state,
        start: w.start,
        end: w.end,
        start_ms: w.startMs,
        end_ms: w.endMs,
        message: renderMaintenanceNotice(cfg.message, w),
        signature: windowSignature(w.start, w.end),
    };
}
