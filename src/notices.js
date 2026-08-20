// Thin knex orchestration behind the data-notice surfaces. All decisions live
// in the pure src/db/notice-rules.js; this file only loads, writes and
// projects. Same split as src/magic.js over src/db/magic-rules.js.
//
// Serving is memo-based, never a query: the writer projects the active list
// into the shared `meta` table and every instance reads it from the in-process
// memo refreshed alongside the other meta keys. Same pattern as column_catalog.
import { z } from 'zod';
import { db } from './db/connection.js';
import { getMeta, setMeta, bumpWarehouseVersion, refreshMetaMemo } from './meta.js';
import { isWriter } from './db/lease.js';
import { effective } from './settings.js';
import { detectNotices, coveragePayload, eatDay } from './db/notice-rules.js';

const META_KEY = 'data_notices';

// Request schemas live here, not in the route file: server.js does not import
// zod, and notice-rules.js must stay dependency-free because the web bundle
// imports it verbatim. Same split as userPatchSchema in src/db/admin-rules.js.
export const noticeStatusSchema = z.object({
    status: z.enum(['approved', 'dismissed', 'unconfirmed']),
});

export const noticeCreateSchema = z.object({
    kind: z.string().min(1).max(32),
    severity: z.enum(['degraded', 'outage']),
    date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    title: z.string().min(1).max(80),
    note: z.string().min(1).max(240),
}).refine(v => v.date_from <= v.date_to, { message: 'date_to must not precede date_from' });

const COLS = [
    'id', 'kind', 'severity', 'status', 'source',
    'date_from', 'date_to', 'title', 'note', 'evidence',
    'created_by', 'created_at', 'updated_at',
];

// mysql2 hands a DATE column back as a JS Date built in the connection's
// timezone, which is pinned to +03:00. `toISOString()` on that Date reports
// the PREVIOUS calendar day (2026-08-16 stored reads back as 2026-08-15),
// so every notice span would silently shift by one day. Verified live during
// Task 2. `eatDay` adds the offset back before slicing, which is exactly the
// conversion needed here.
const _day = v => (v instanceof Date ? eatDay(v) : String(v ?? '').slice(0, 10));
const _json = v => {
    if (v == null) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return null; }
};

// The wire shape. Dates are normalized to 'YYYY-MM-DD' strings here so the
// pure rules never have to care that mysql2 hands back Date objects.
const _out = r => ({
    id: r.id,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    source: r.source,
    date_from: _day(r.date_from),
    date_to: _day(r.date_to),
    title: r.title,
    note: r.note,
    evidence: _json(r.evidence),
});

let _memo = [];

export function activeNotices() {
    return _memo;
}

export async function refreshNoticeMemo() {
    const stored = await getMeta(META_KEY);
    if (Array.isArray(stored)) _memo = stored;
}

// Deliberately NOT writer-gated, unlike _storeColumnCatalog. This is a cheap
// indexed read of a tiny table rewritten into one meta key, and it is
// idempotent: whichever instance runs it derives the same list from the same
// shared table. Gating it on isWriter() would mean an admin approving a notice
// on a FOLLOWER instance updates data_notices and admin_audit correctly and
// then silently fails to update what visitors see, indefinitely, because
// nothing else re-projects after a manual admin action. Every instance
// projecting at boot is three identical upserts of one row, which is free.
export async function projectNotices() {
    const rows = await db('data_notices')
        .whereNot('status', 'dismissed')
        .orderBy('date_from', 'desc')
        .select(COLS);
    const list = rows.map(_out);
    await setMeta(META_KEY, list);
    _memo = list;
}

export function coverageFor(day) {
    return coveragePayload(_memo, day);
}

// What an ADMIN MUTATION must call, as opposed to the boot projection.
// `/api/records` embeds the coverage block in a body memoized on
// warehouse_version plus a 10-minute TTL, and a notice status change touches
// neither, so without this bump an admin who dismisses a false-positive
// outage banner would keep seeing it on /api/records for up to ten minutes.
// Bumping is deliberately NOT inside projectNotices: that also runs at boot on
// every instance, and bumping there would inflate the version on every restart
// and make every connected client silently reload for nothing.
async function _publish() {
    await projectNotices();
    await bumpWarehouseVersion();
    await refreshMetaMemo();
}

export async function recordRun({ started_at, finished_at, mode, dates = [], verdict, step_failures = [] }) {
    await db('collection_runs').insert({
        started_at: new Date(started_at),
        finished_at: new Date(finished_at),
        mode: String(mode).slice(0, 16),
        dates: JSON.stringify(dates ?? []),
        verdict,
        step_failures: JSON.stringify(step_failures ?? []),
    });
}

export async function pruneRuns() {
    const days = effective('COLLECTION_RUNS_RETENTION_DAYS');
    if (!days) return 0;
    return db('collection_runs')
        .whereRaw('finished_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [days])
        .del();
}

// Reads the ledger, asks the pure rules what it implies, and inserts anything
// new as `unconfirmed`. `ignore()` makes it idempotent against the span unique
// index, which is also what makes a DISMISSAL stick: a dismissed row still
// occupies the span, so the same proposal can never come back.
export async function runDetector() {
    if (!isWriter()) return { proposed: 0, inserted: 0 };
    const days = effective('COLLECTION_RUNS_RETENTION_DAYS') || 90;
    const runs = (await db('collection_runs')
        .whereRaw('finished_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', [days])
        .orderBy('finished_at', 'asc')
        .select('started_at', 'finished_at', 'mode', 'dates', 'verdict', 'step_failures'))
        .map(r => ({
            ...r,
            finished_at: new Date(r.finished_at).toISOString(),
            dates: _json(r.dates) ?? [],
            step_failures: _json(r.step_failures) ?? [],
        }));

    const proposals = detectNotices(runs, { maxGapMinutes: effective('COLLECTION_GAP_MINUTES') });
    let inserted = 0;
    for (const p of proposals) {
        const n = await db('data_notices').insert({
            kind: p.kind,
            severity: p.severity,
            status: 'unconfirmed',
            source: 'auto',
            date_from: p.date_from,
            date_to: p.date_to,
            title: p.title,
            note: p.note,
            evidence: JSON.stringify(p.evidence ?? null),
            created_by: null,
        }).onConflict(['source', 'kind', 'date_from', 'date_to']).ignore();
        if (Array.isArray(n) ? n[0] : n) inserted++;
    }
    // Publish, not just project: the sweep's own version bump happens BEFORE
    // onFinish runs the detector, so a notice inserted here would otherwise sit
    // behind an already-warm /api/records cache entry.
    if (inserted) await _publish();
    return { proposed: proposals.length, inserted };
}

export async function listNotices({ limit = 100 } = {}) {
    const rows = await db('data_notices')
        .orderBy('date_from', 'desc').orderBy('id', 'desc')
        .limit(Math.max(1, Math.min(500, Number(limit) || 100)))
        .select(COLS);
    return rows.map(_out);
}

export async function setNoticeStatus(id, status, actorId = null) {
    const nid = Number(id);
    const before = await db('data_notices').where('id', nid).first();
    if (!before) { const e = new Error('Notice not found'); e.status = 404; throw e; }
    await db.transaction(async trx => {
        await trx('data_notices').where('id', nid).update({ status });
        await trx('admin_audit').insert({
            actor_id: actorId,
            action: 'notice.status',
            target: `notice:${nid}`,
            old_value: before.status,
            new_value: status,
        });
    });
    await _publish();
    return _out(await db('data_notices').where('id', nid).first(COLS));
}

// Manual notices are born approved: an admin writing one by hand has already
// reviewed it, so the UNCONFIRMED hedge would be a lie.
export async function createNotice(input, actorId = null) {
    const row = {
        kind: input.kind,
        severity: input.severity,
        status: 'approved',
        source: 'manual',
        date_from: input.date_from,
        date_to: input.date_to,
        title: input.title,
        note: input.note,
        evidence: JSON.stringify(input.evidence ?? null),
        created_by: actorId,
    };
    // The notice INSERT and its audit row ride ONE transaction, matching
    // setNoticeStatus. Split across two statements, a failing audit insert
    // would throw to the caller while leaving a live, approved, publicly
    // projected notice behind with no audit trail, which is the exact gap
    // admin_audit exists to close.
    let id;
    await db.transaction(async trx => {
        [id] = await trx('data_notices').insert(row);
        await trx('admin_audit').insert({
            actor_id: actorId,
            action: 'notice.create',
            target: `notice:${id}`,
            old_value: null,
            new_value: `${row.kind} ${row.date_from}..${row.date_to}`,
        });
    });
    await _publish();
    return _out(await db('data_notices').where('id', id).first(COLS));
}
