import { createHash, randomBytes } from 'node:crypto';
import { db } from './db/connection.js';
import { parseUserAgent } from './db/visit-rules.js';
import { sanitizeEvents, sessionResumeAllowed, computeDuration, durationHistogram } from './db/track-rules.js';

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

// A "person" is a user account when the visitor row is linked, else the
// anonymous visitor - one signed-in human on two devices counts once. Shared
// by the badge count and every trackSummary people aggregate.
const PERSON_KEY = "IFNULL(CONCAT('u', vi.user_id), CONCAT('v', s.visitor_id))";

// Today's (or a given EAT day's) unique PEOPLE + session count for the public
// status-bar badge - v2 twin of visits.js#dailyUniqueVisitors.
export async function dailyUniqueSessions(date = null) {
    const q = db('visit_sessions as s').join('visitors as vi', 'vi.id', 's.visitor_id');
    if (date) q.whereRaw('DATE(s.started_at) = ?', [date]);
    else q.whereRaw('DATE(s.started_at) = CURDATE()');
    const [r] = await q
        .countDistinct({ unique: db.raw(PERSON_KEY) })
        .count({ total: '*' });
    return { date: date ?? null, unique: Number(r.unique) || 0, total: Number(r.total) || 0 };
}

// Pre-binned visitor/feature analytics for the admin Dashboard (M5). Raw rows
// never leave the server (lab discipline): everything aggregates here, the
// duration histogram bins via the pure durationHistogram. Date grouping stays
// in the pinned +03:00 SQL session (DATE_FORMAT strings, the magic.js idiom -
// a bare DATE() would decode to a JS Date in the NODE process's timezone).
export async function trackSummary({ days = 30 } = {}) {
    const win = q => q.whereRaw('s.started_at >= NOW() - INTERVAL ? DAY', [days]);

    const daily = await win(db('visit_sessions as s').join('visitors as vi', 'vi.id', 's.visitor_id'))
        .groupByRaw("DATE_FORMAT(s.started_at, '%Y-%m-%d')")
        .orderByRaw('1')
        .select(db.raw("DATE_FORMAT(s.started_at, '%Y-%m-%d') as day"))
        .count({ sessions: '*' })
        .countDistinct({ people: db.raw(PERSON_KEY) });

    // Durations: checkout wrote duration_seconds; abandoned sessions derive
    // started->last_active via the same pure math the checkout writer uses.
    const durRows = await win(db('visit_sessions as s'))
        .select('s.started_at', 's.last_active_at', 's.duration_seconds');
    const duration = durationHistogram(durRows.map(r =>
        r.duration_seconds ?? computeDuration(r.started_at, r.last_active_at)));

    const features = await db('visit_events as e')
        .join('visit_sessions as s', 's.id', 'e.session_id')
        .whereRaw('e.occurred_at >= NOW() - INTERVAL ? DAY', [days])
        .groupBy('e.name')
        .select('e.name')
        .count({ count: '*' })
        .countDistinct({ sessions: 'e.session_id' })
        .orderBy('count', 'desc')
        .limit(20);

    const perPerson = await win(db('visit_sessions as s').join('visitors as vi', 'vi.id', 's.visitor_id'))
        .groupByRaw(PERSON_KEY)
        .select(db.raw(`${PERSON_KEY} as person`))
        .count({ sessions: '*' });
    const people = perPerson.length;
    const repeatPeople = perPerson.filter(p => Number(p.sessions) > 1).length;

    const devices = await win(db('visit_sessions as s').join('visitor_devices as d', 'd.id', 's.device_id'))
        .groupBy('d.device_type')
        .select({ device: 'd.device_type' })
        .count({ sessions: '*' })
        .orderBy('sessions', 'desc');

    const countries = await win(db('visit_sessions as s'))
        .groupByRaw("IFNULL(s.country, '(unknown)')")
        .select(db.raw("IFNULL(s.country, '(unknown)') as country"))
        .count({ sessions: '*' })
        .orderBy('sessions', 'desc')
        .limit(12);

    const [today, [{ eventsToday }], [{ newVisitors }], [{ activeNow }]] = await Promise.all([
        dailyUniqueSessions(),
        db('visit_events').whereRaw('occurred_at >= CURDATE()').count({ eventsToday: '*' }),
        db('visitors').whereRaw('first_seen_at >= CURDATE()').count({ newVisitors: '*' }),
        db('visit_sessions').whereNull('ended_at')
            .whereRaw('last_active_at >= NOW() - INTERVAL 5 MINUTE').count({ activeNow: '*' }),
    ]);

    return {
        generated_at: new Date().toISOString(),
        window_days: days,
        today: {
            ...today,
            events: Number(eventsToday) || 0,
            new_visitors: Number(newVisitors) || 0,
            active_now: Number(activeNow) || 0,
        },
        daily: daily.map(r => ({ day: r.day, sessions: Number(r.sessions), people: Number(r.people) })),
        features: features.map(r => ({ name: r.name, count: Number(r.count), sessions: Number(r.sessions) })),
        duration,
        repeat: { people, repeat_people: repeatPeople, share: people ? Math.round((repeatPeople / people) * 1000) / 1000 : null },
        devices: devices.map(r => ({ device: r.device ?? '(unknown)', sessions: Number(r.sessions) })),
        countries: countries.map(r => ({ country: r.country, sessions: Number(r.sessions) })),
    };
}
