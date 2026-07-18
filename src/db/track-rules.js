import { z } from 'zod';

// Visitor-tracking v2 rules (admin program M2). Pure + offline-testable like
// the sibling *-rules modules: zod for the beacon request envelopes, plain
// functions for event sanitization, session resume and duration math. No DB,
// no config, no crypto - key generation lives in the src/track.js service.

// Any RFC-4122-shaped UUID (the client uses crypto.randomUUID = v4, but the
// gate only cares that it is UUID-shaped, lowercase-insensitive).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidAnonId(s) {
    return typeof s === 'string' && UUID_RE.test(s);
}

// Event names are a closed grammar, not free text: lowercase snake/dotted
// identifiers only. Values are short scalars; anything else is dropped or
// truncated by sanitizeEvents - free-form strings can never reach the DB.
export const EVENT_NAME_RE = /^[a-z][a-z0-9_.]{0,47}$/;

export function sanitizeEvents(list, { maxEvents = 25, maxValueLen = 32 } = {}) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const e of list) {
        if (out.length >= maxEvents) break;
        if (!e || typeof e !== 'object') continue;
        const name = typeof e.name === 'string' ? e.name : null;
        if (!name || !EVENT_NAME_RE.test(name)) continue;
        let value = null;
        if (typeof e.value === 'string' || typeof e.value === 'number' || typeof e.value === 'boolean') {
            value = String(e.value).slice(0, maxValueLen);
            if (value === '') value = null;
        }
        out.push({ name, value });
    }
    return out;
}

// A session is resumable while it is open and its last activity is inside the
// idle window - a reload within half an hour continues the same visit.
export function sessionResumeAllowed(session, nowMs, { windowMinutes = 30 } = {}) {
    if (!session || session.ended_at != null) return false;
    const last = new Date(session.last_active_at ?? session.started_at).getTime();
    if (!Number.isFinite(last)) return false;
    const ageMs = nowMs - last;
    return ageMs >= 0 && ageMs <= windowMinutes * 60_000;
}

// Stay duration in whole seconds: checkout time when the client said goodbye,
// else the last observed activity. Never negative; sub-second visits count 0.
export function computeDuration(startedAt, lastActiveAt, endedAt = null) {
    const start = new Date(startedAt).getTime();
    const end = new Date(endedAt ?? lastActiveAt ?? startedAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.max(0, Math.floor((end - start) / 1000));
}

// Duration histogram buckets for the admin dashboard (ordered; label = key).
export const DURATION_BUCKETS = ['<30s', '30s-2m', '2-10m', '10-30m', '>30m'];
export function durationBucket(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) return null;
    if (s < 30) return '<30s';
    if (s < 120) return '30s-2m';
    if (s < 600) return '2-10m';
    if (s < 1800) return '10-30m';
    return '>30m';
}

// --- Beacon request envelopes (zod) -----------------------------------------
// Tolerant but bounded: paths/referers trimmed to their column widths, the
// events array is validated per-item by sanitizeEvents AFTER the envelope.
const _short = max => z.string().trim().max(max).optional().nullable();

export const checkinSchema = z.object({
    anon_id: z.string().regex(UUID_RE, 'anon_id must be a UUID'),
    path: _short(512),
    referer: _short(512),
});

export const eventsSchema = z.object({
    sid: z.coerce.number().int().positive(),
    key: z.string().regex(/^[0-9a-f]{32}$/i, 'bad session key'),
    events: z.array(z.unknown()).max(100).optional().default([]),
});

export const checkoutSchema = z.object({
    sid: z.coerce.number().int().positive(),
    key: z.string().regex(/^[0-9a-f]{32}$/i, 'bad session key'),
});
