import { db } from './db/connection.js';
import { pickIp, buildVisitRow } from './db/visit-rules.js';

// Visitor traffic log (reads/writes the `visits` table). The write path is
// best-effort and must never break a page load; the read path backs the public
// daily-unique badge and the admin dashboard summary. All day grouping uses the
// pinned +03:00 session tz (CURDATE()/DATE() = EAT), matching the warehouse.

// Build a visits row from an express request (extraction only; the parsing +
// trimming is the pure buildVisitRow).
export function visitRowFromReq(req) {
    return buildVisitRow({
        ip: pickIp(req.headers['x-forwarded-for'], req.socket?.remoteAddress),
        ua: req.get('user-agent') || '',
        referer: req.get('referer') || req.get('referrer') || null,
        path: req.path,
    });
}

// Fire-and-forget insert: swallow every error (a logging failure must not
// surface to the visitor or reject the request).
export async function logVisit(row) {
    try {
        await db('visits').insert(row);
    } catch (e) {
        console.debug('[visits] insert failed:', e?.message ?? e);
    }
}

// Today's (or a given EAT day's) unique visitors + total page views. Backs the
// public status-bar badge, so it stays cheap (one grouped count).
export async function dailyUniqueVisitors(date = null) {
    const q = db('visits');
    if (date) q.whereRaw('DATE(visited_at) = ?', [date]);
    else q.whereRaw('DATE(visited_at) = CURDATE()');
    const [r] = await q.count({ total: '*' }).countDistinct({ unique: 'ip' });
    return { date: date ?? null, unique: Number(r.unique) || 0, total: Number(r.total) || 0 };
}

async function windowStats(whereRaw, binds = []) {
    const q = db('visits');
    if (whereRaw) q.whereRaw(whereRaw, binds);
    const [r] = await q.count({ visits: '*' }).countDistinct({ unique: 'ip' });
    return { visits: Number(r.visits) || 0, unique: Number(r.unique) || 0 };
}

async function breakdown(col, limit = 20) {
    const rows = await db('visits')
        .select({ name: col })
        .count({ count: '*' })
        .whereNotNull(col)
        .andWhereRaw('?? <> ""', [col])
        .groupBy(col)
        .orderBy('count', 'desc')
        .limit(limit);
    return rows.map(r => ({ name: r.name, count: Number(r.count) }));
}

// Everything the admin dashboard renders: window totals, a 30-day daily series,
// device/browser/os/country breakdowns, top referrers and the most recent hits.
export async function visitsSummary() {
    const [today, last7, last30, all] = await Promise.all([
        windowStats('DATE(visited_at) = CURDATE()'),
        windowStats('visited_at >= CURDATE() - INTERVAL 6 DAY'),
        windowStats('visited_at >= CURDATE() - INTERVAL 29 DAY'),
        windowStats(null),
    ]);

    const seriesRows = await db('visits')
        .select(db.raw("DATE_FORMAT(visited_at, '%Y-%m-%d') as day"))
        .count({ visits: '*' })
        .countDistinct({ unique: 'ip' })
        .whereRaw('visited_at >= CURDATE() - INTERVAL 29 DAY')
        .groupByRaw('DATE(visited_at)')
        .orderByRaw('DATE(visited_at)');
    const series = seriesRows.map(r => ({ day: r.day, visits: Number(r.visits) || 0, unique: Number(r.unique) || 0 }));

    const [byDevice, byBrowser, byOs, byCountry, topReferers] = await Promise.all([
        breakdown('device_type'),
        breakdown('browser'),
        breakdown('os'),
        breakdown('country'),
        breakdown('referer', 10),
    ]);

    const recentRows = await db('visits')
        .select(
            db.raw("DATE_FORMAT(visited_at, '%Y-%m-%d %H:%i') as visited_at"),
            'ip', 'device_type', 'browser', 'os', 'country', 'region', 'path', 'referer',
        )
        .orderBy('id', 'desc')
        .limit(50);

    return {
        generated_at: new Date().toISOString(),
        windows: { today, last7, last30, all },
        series,
        breakdowns: { device: byDevice, browser: byBrowser, os: byOs, country: byCountry },
        top_referers: topReferers,
        recent: recentRows,
    };
}
