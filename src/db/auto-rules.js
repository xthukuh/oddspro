// Pure auto-refresh scheduling rules (zero imports so tests skip config/.env).
// The scheduler (src/auto-refresh.js) ticks on a coarse interval and asks
// these predicates what is due; all times are epoch ms so tests control the
// clock. "Daily" means an EAT calendar day - the warehouse stores EAT
// wall-clock datetimes and Nairobi has no DST, so a fixed offset is exact.

export const EAT_OFFSET_MS = 3 * 3600_000;

// 'HH:MM' -> minutes of day (0..1439); ''/off/invalid -> null (mode disabled).
export function parseDailyTime(value) {
    const s = String(value ?? '').trim().toLowerCase();
    if (!s || s === 'off') return null;
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Epoch ms -> 'YYYY-MM-DD' in EAT (shift, then read UTC getters).
export function eatDateKey(nowMs) {
    const d = new Date(nowMs + EAT_OFFSET_MS);
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// Epoch ms -> minutes elapsed in the current EAT day.
export function eatMinutesOfDay(nowMs) {
    const d = new Date(nowMs + EAT_OFFSET_MS);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// Daily full sweep is due once the EAT clock passes fullAtMinutes and no full
// run was started this EAT day yet (lastFullKey = eatDateKey of that start).
export function isFullDue(nowMs, fullAtMinutes, lastFullKey) {
    if (fullAtMinutes == null) return false;
    return eatMinutesOfDay(nowMs) >= fullAtMinutes && eatDateKey(nowMs) !== lastFullKey;
}

// Light pass is due every lightMinutes since the last light start; 0 = off.
export function isLightDue(nowMs, lastLightMs, lightMinutes) {
    return lightMinutes > 0 && nowMs - lastLightMs >= lightMinutes * 60_000;
}

// Self-truncating log: past maxBytes, keep the newest ~half starting at a
// line boundary, behind a truncation marker. Byte-approximate (log lines are
// ASCII); nowIso is injectable for deterministic tests.
export function trimLogTail(content, maxBytes, nowIso = new Date().toISOString()) {
    if (typeof content !== 'string' || content.length <= maxBytes) return content;
    let tail = content.slice(-Math.floor(maxBytes / 2));
    const nl = tail.indexOf('\n');
    if (nl !== -1) tail = tail.slice(nl + 1);
    return `[log truncated ${nowIso}]\n${tail}`;
}
