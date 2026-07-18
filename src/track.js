import { createHash, randomBytes } from 'node:crypto';
import { db } from './db/connection.js';
import { parseUserAgent } from './db/visit-rules.js';
import { sanitizeEvents, sessionResumeAllowed, computeDuration } from './db/track-rules.js';

// Visitor-tracking v2 service (admin program M2): thin knex orchestration over
// the pure track-rules. The beacon replaces the middleware as the tracking
// source on prod (Apache serves the SPA statically - page loads never reach
// Express there); the legacy `visits` middleware log stays as-is for history.
// Every entry point is best-effort at the route layer: analytics must never
// break the app, so routes swallow errors into { ok:true }.

const _trim = (s, n) => (s == null || s === '' ? null : String(s).slice(0, n));
const _sha256 = s => createHash('sha256').update(String(s)).digest('hex');

// select-insert-reselect upsert: MySQL insert..onConflict cannot return the
// existing row's id, and these tables are low-write (one hit per new UA /
// browser install), so two cheap indexed queries beat a raw upsert here.
async function _ensureRow(table, where, insertRow) {
    const found = await db(table).where(where).first();
    if (found) return found;
    try {
        const [id] = await db(table).insert(insertRow);
        return { id, ...insertRow };
    } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') return db(table).where(where).first();
        throw e;
    }
}

// Check-in: resolve device (by UA hash) + visitor (by anon UUID), then resume
// the visitor's open session on that device inside the idle window, else open
// a new one. Returns { sid, key } - the key guards event ingestion.
export async function checkin({ anonId, ua = '', ip = null, path = null, referer = null, userId = null }) {
    const now = new Date();
    const uaTrimmed = _trim(ua, 512) ?? '';
    const { deviceType, browser, os } = parseUserAgent(uaTrimmed);
    const device = await _ensureRow('visitor_devices', { ua_hash: _sha256(uaTrimmed) }, {
        ua_hash: _sha256(uaTrimmed),
        user_agent: uaTrimmed,
        device_type: deviceType,
        browser,
        os,
        first_seen_at: now,
        last_seen_at: now,
    });
    await db('visitor_devices').where({ id: device.id }).update({ last_seen_at: now });

    const visitor = await _ensureRow('visitors', { anon_id: anonId }, {
        anon_id: anonId,
        user_id: userId,
        first_seen_at: now,
        last_seen_at: now,
    });
    const patch = { last_seen_at: now };
    // Stamp identity when signed in; never erase it on a later guest visit.
    if (userId && visitor.user_id !== userId) patch.user_id = userId;
    await db('visitors').where({ id: visitor.id }).update(patch);

    const open = await db('visit_sessions')
        .where({ visitor_id: visitor.id, device_id: device.id })
        .whereNull('ended_at')
        .orderBy('id', 'desc')
        .first();
    if (open && sessionResumeAllowed(open, now.getTime())) {
        await db('visit_sessions').where({ id: open.id }).update({ last_active_at: now });
        return { sid: open.id, key: open.session_key };
    }

    const key = randomBytes(16).toString('hex');
    const [sid] = await db('visit_sessions').insert({
        visitor_id: visitor.id,
        device_id: device.id,
        session_key: key,
        ip: _trim(ip, 45),
        started_at: now,
        last_active_at: now,
        entry_path: _trim(path, 512),
        referer: _trim(referer, 512),
    });
    return { sid, key };
}

async function _session(sid, key) {
    const s = await db('visit_sessions').where({ id: sid }).first();
    if (!s || s.session_key !== key) return null;
    return s;
}

// Event batch = heartbeat: even an empty (fully-sanitized-away) batch bumps
// last_active_at, so the client needs no separate keepalive ping. An unknown
// or ended session answers { recheck:true } - the client re-checks-in.
export async function ingestEvents(sid, key, rawEvents) {
    const s = await _session(sid, key);
    if (!s || s.ended_at != null) return { ok: false, recheck: true };
    const now = new Date();
    const events = sanitizeEvents(rawEvents);
    if (events.length) {
        await db('visit_events').insert(events.map(e => ({
            session_id: s.id,
            name: e.name,
            value: e.value,
            occurred_at: now,
        })));
    }
    await db('visit_sessions').where({ id: s.id }).update({
        last_active_at: now,
        events_count: db.raw('events_count + ?', [events.length]),
    });
    return { ok: true, accepted: events.length };
}

export async function checkout(sid, key) {
    const s = await _session(sid, key);
    if (!s) return { ok: false };
    if (s.ended_at != null) return { ok: true };
    const now = new Date();
    await db('visit_sessions').where({ id: s.id }).update({
        ended_at: now,
        duration_seconds: computeDuration(s.started_at, s.last_active_at, now),
    });
    return { ok: true };
}

// Today's (or a given EAT day's) unique PEOPLE + session count for the public
// status-bar badge - v2 twin of visits.js#dailyUniqueVisitors. A person is a
// user account when the visitor is linked, else the anonymous visitor row, so
// one signed-in human on two devices counts once.
export async function dailyUniqueSessions(date = null) {
    const q = db('visit_sessions as s').join('visitors as vi', 'vi.id', 's.visitor_id');
    if (date) q.whereRaw('DATE(s.started_at) = ?', [date]);
    else q.whereRaw('DATE(s.started_at) = CURDATE()');
    const [r] = await q
        .countDistinct({ unique: db.raw("IFNULL(CONCAT('u', vi.user_id), CONCAT('v', s.visitor_id))") })
        .count({ total: '*' });
    return { date: date ?? null, unique: Number(r.unique) || 0, total: Number(r.total) || 0 };
}
