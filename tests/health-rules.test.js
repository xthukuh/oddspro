// Pure production-health rules (src/db/health-rules.js), shared by the in-app
// daily snapshot (src/health.js) and the host cron script
// (scripts/ops/prod-health.mjs), plus the signal readers in
// src/health-collect.js driven against a stub knex (no DB, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    baseSnapshot, decideHealth, summarizeLight, summarizeFull, fullMissingToday, parseMetaRows,
    summarizeCoverage, prevBlock, errorSnapshot, pickAlertPhone, alertText, parseLedgerDays,
    snapshotDecision, nextAttempts, decodeSnapshotRow, ledgerFreshness, eatStringToMs, etimeToSeconds,
    HEALTH_LEDGER_DEFAULT_DAYS, HEALTH_LEDGER_MAX_DAYS, HEALTH_SNAPSHOT_MAX_ATTEMPTS, HEALTH_SNAPSHOT_RETRY_MS,
} from '../src/db/health-rules.js';
import { collectDbSignals, collectApiStatus, collectHost } from '../src/health-collect.js';

// 2026-10-10 13:25:00 EAT = 10:25:00 UTC.
const NOW = Date.UTC(2026, 9, 10, 10, 25, 0);
const AT_1320 = 13 * 60 + 20;

function healthy() {
    const s = baseSnapshot(NOW);
    s.meta.odds_age_min = 12;
    s.fixtures_nearby = 30;
    s.full = { id: 77, verdict: 'ok', step_failures: [] };
    s.light = { by_verdict: { ok: 140 }, total_24h: 140, light_max_gap_min: 20, last_light_at: '2026-10-10 13:20:00' };
    s.api = { requests_today: 1000, limit_day: 150000, plan: 'Pro', plan_end: '2027-01-01', plan_days_left: 83 };
    s.counters.max_id.odds_markets = 2000;
    s.prev = { ts: new Date(NOW - 24 * 3_600_000).toISOString(), age_h: 24, odds_markets_max_id: 1000 };
    s.host.disk_free_gb = 120;
    return s;
}

// ---- verdict ---------------------------------------------------------------

test('decideHealth: all signals in bounds is GREEN with no reasons', () => {
    assert.deepEqual(decideHealth(healthy()), { verdict: 'GREEN', reasons: [] });
});

test('decideHealth: odds staleness counts only with fixtures nearby', () => {
    const s = healthy();
    s.meta.odds_age_min = 150;
    assert.deepEqual(decideHealth(s), { verdict: 'RED', reasons: ['odds_stale:150m'] });
    s.fixtures_nearby = 0;
    assert.equal(decideHealth(s).verdict, 'GREEN');
    s.fixtures_nearby = 3;
    s.meta.odds_age_min = 60;
    assert.deepEqual(decideHealth(s), { verdict: 'AMBER', reasons: ['odds_aging:60m'] });
    s.meta.odds_age_min = 120;
    assert.equal(decideHealth(s).verdict, 'AMBER');
    s.meta.odds_age_min = 59;
    assert.equal(decideHealth(s).verdict, 'GREEN');
});

test('decideHealth: a failed full sweep is RED under the ledger\'s real verdict "error"', () => {
    const s = healthy();
    s.full.verdict = 'error';
    assert.deepEqual(decideHealth(s).reasons, ['full_failed:77']);
    s.full.verdict = 'failed'; // legacy alias still honoured
    assert.equal(decideHealth(s).verdict, 'RED');
    s.full.verdict = 'partial';
    assert.deepEqual(decideHealth(s), { verdict: 'AMBER', reasons: ['full_partial:77'] });
    s.full.verdict = 'cancelled';
    assert.equal(decideHealth(s).verdict, 'GREEN');
});

test('decideHealth: full_missing_today is RED', () => {
    const s = healthy();
    s.full_missing_today = true;
    assert.deepEqual(decideHealth(s), { verdict: 'RED', reasons: ['full_missing_today'] });
});

test('decideHealth: light failures (error verdict) grade AMBER from 1, RED from 5; partials AMBER from 5', () => {
    const s = healthy();
    s.light.by_verdict = { ok: 100, error: 1 };
    assert.deepEqual(decideHealth(s), { verdict: 'AMBER', reasons: ['light_failed:1'] });
    s.light.by_verdict = { ok: 100, error: 3, failed: 2 };
    assert.deepEqual(decideHealth(s), { verdict: 'RED', reasons: ['light_failed:5'] });
    s.light.by_verdict = { ok: 100, partial: 4 };
    assert.equal(decideHealth(s).verdict, 'GREEN');
    s.light.by_verdict = { ok: 100, partial: 5 };
    assert.deepEqual(decideHealth(s).reasons, ['light_partial:5']);
});

test('decideHealth: light gap AMBER at 45..90 min, RED above 90', () => {
    const s = healthy();
    s.light.light_max_gap_min = 44;
    assert.equal(decideHealth(s).verdict, 'GREEN');
    s.light.light_max_gap_min = 45;
    assert.deepEqual(decideHealth(s).reasons, ['light_gap:45m']);
    s.light.light_max_gap_min = 90;
    assert.equal(decideHealth(s).verdict, 'AMBER');
    s.light.light_max_gap_min = 91;
    assert.deepEqual(decideHealth(s), { verdict: 'RED', reasons: ['light_gap:91m'] });
});

test('decideHealth: API plan expiry, plan soon, quota high', () => {
    const s = healthy();
    s.api.plan_days_left = -1;
    assert.deepEqual(decideHealth(s), { verdict: 'RED', reasons: ['api_plan_expired:2027-01-01'] });
    s.api.plan_days_left = 10;
    assert.deepEqual(decideHealth(s), { verdict: 'AMBER', reasons: ['api_plan_soon:10d'] });
    s.api.plan_days_left = 11;
    s.api.requests_today = 120_000; // exactly 80%: not above the bar
    assert.equal(decideHealth(s).verdict, 'GREEN');
    s.api.requests_today = 121_500; // 81%
    assert.deepEqual(decideHealth(s).reasons, ['api_quota_high:81%']);
});

test('decideHealth: odds flatline needs a prev at least 20h old with the same high-water mark', () => {
    const s = healthy();
    s.prev.odds_markets_max_id = 2000;
    assert.deepEqual(decideHealth(s), { verdict: 'RED', reasons: ['odds_flatlined:2000'] });
    s.prev.age_h = 19.9;
    assert.equal(decideHealth(s).verdict, 'GREEN');
    s.prev.age_h = 24;
    s.prev.odds_markets_max_id = null;
    assert.equal(decideHealth(s).verdict, 'GREEN');
});

test('decideHealth: host and notices are AMBER; null host fields never fire', () => {
    const s = healthy();
    s.host.disk_free_gb = 24.9;
    s.host.lsnode_count = 4;
    s.host.lsnode_oldest_days = 14.5;
    s.notices.new_unconfirmed_24h = [{ id: 1 }];
    assert.deepEqual(decideHealth(s), {
        verdict: 'AMBER', reasons: ['disk_low:24.9GB', 'lsnode_many:4', 'lsnode_old:14.5d', 'notices_new:1'],
    });
    const n = healthy();
    n.host = { lsnode_count: null, lsnode_oldest_days: null, disk_free_gb: null };
    assert.equal(decideHealth(n).verdict, 'GREEN');
});

test('decideHealth: carried read-pass reasons force at least AMBER and stay last', () => {
    const s = healthy();
    s.reasons = ['unread:meta', 'api_status_unavailable'];
    assert.deepEqual(decideHealth(s), { verdict: 'AMBER', reasons: ['unread:meta', 'api_status_unavailable'] });
    s.meta.odds_age_min = 200;
    assert.deepEqual(decideHealth(s), {
        verdict: 'RED', reasons: ['odds_stale:200m', 'unread:meta', 'api_status_unavailable'],
    });
});

test('decideHealth is pure: the input snapshot is not mutated', () => {
    const s = healthy();
    s.reasons = ['unread:x'];
    const before = JSON.stringify(s);
    decideHealth(s);
    assert.equal(JSON.stringify(s), before);
});

// ---- read-pass summaries ---------------------------------------------------

test('summarizeLight: counts verdicts, excuses the full-sweep window, measures the tail to now', () => {
    const rows = [
        { verdict: 'ok', s: '2026-10-10 04:50:00' },
        { verdict: 'ok', s: '2026-10-10 11:00:00' }, // 6h10m gap, a sweep 05:00-10:50 inside it
        { verdict: 'error', s: '2026-10-10 11:10:00' },
    ];
    const windows = [[eatStringToMs('2026-10-10 05:00:00'), eatStringToMs('2026-10-10 10:50:00')]];
    const out = summarizeLight(rows, windows, NOW);
    assert.deepEqual(out.by_verdict, { ok: 2, error: 1 });
    assert.equal(out.total_24h, 3);
    assert.equal(out.last_light_at, '2026-10-10 11:10:00');
    // tail 11:10 -> 13:25 = 135 min dominates the excused 20-min gap
    assert.equal(out.light_max_gap_min, 135);
    assert.equal(summarizeLight([], [], NOW).light_max_gap_min, null);
});

test('summarizeFull: newest row wins, step failures parsed, windows include a still-open one', () => {
    const rows = [
        { id: 9, verdict: 'partial', s: '2026-10-10 05:00:00', f: '2026-10-10 08:00:00', sf: '[{"step":"stats"}]' },
        { id: 8, verdict: 'ok', s: '2026-10-09 05:00:00', f: null, sf: 'not json' },
    ];
    const { full, windows } = summarizeFull(rows, NOW);
    assert.equal(full.id, 9);
    assert.equal(full.duration_s, 3 * 3600);
    assert.deepEqual(full.step_failures, [{ step: 'stats' }]);
    assert.equal(windows.length, 2);
    assert.equal(windows[1][1], NOW);
    assert.deepEqual(summarizeFull(null, NOW), { full: null, windows: [] });
});

test('fullMissingToday: after 13:00 EAT with no sweep started today, unless one is running', () => {
    const base = { rows: [{ s: '2026-10-09 05:00:00' }], today: '2026-10-10', nowEat: '2026-10-10 13:25:00' };
    assert.equal(fullMissingToday(base), true);
    assert.equal(fullMissingToday({ ...base, nowEat: '2026-10-10 12:59:59' }), false);
    assert.equal(fullMissingToday({ ...base, rows: [{ s: '2026-10-10 05:00:00' }] }), false);
    // Still running: not in the ledger yet, but the job_state beacon says so.
    assert.equal(fullMissingToday({ ...base, jobState: { mode: 'full', started_at: '2026-10-10T02:00:00.000Z' } }), false);
    // A beacon from yesterday or a light job does not count.
    assert.equal(fullMissingToday({ ...base, jobState: { mode: 'full', started_at: '2026-10-09T02:00:00.000Z' } }), true);
    assert.equal(fullMissingToday({ ...base, jobState: { mode: 'light', started_at: '2026-10-10T09:00:00.000Z' } }), true);
});

test('parseMetaRows / summarizeCoverage / etimeToSeconds', () => {
    const m = parseMetaRows([
        { k: 'last_odds_at', v: JSON.stringify(new Date(NOW - 30 * 60_000).toISOString()) },
        { k: 'warehouse_version', v: '412' },
        { k: 'job_state', v: 'null' },
    ], NOW);
    assert.equal(m.odds_age_min, 30);
    assert.equal(m.warehouse_version, 412);
    assert.equal(m.job_state, null);
    const c = summarizeCoverage([
        { d: '2026-10-10', provider: 'betika', n: '50', linked: '41' },
        { d: '2026-10-12', provider: 'betika', n: '9', linked: '0' },
    ], { yday: '2026-10-09', today: '2026-10-10', tmrw: '2026-10-11' });
    assert.deepEqual(c, { yesterday: {}, today: { betika: { n: 50, linked: 41 } }, tomorrow: {} });
    assert.equal(etimeToSeconds('2-03:04:05'), 2 * 86_400 + 3 * 3600 + 4 * 60 + 5);
    assert.equal(etimeToSeconds('04:05'), 245);
});

test('prevBlock skips a snapshot_error row that carries no high-water mark', () => {
    const good = { ts: new Date(NOW - 48 * 3_600_000).toISOString(), counters: { max_id: { odds_markets: 500 } } };
    const bad = errorSnapshot(NOW - 24 * 3_600_000, 'boom');
    assert.deepEqual(prevBlock([bad, good], NOW), { ts: good.ts, age_h: 48, odds_markets_max_id: 500 });
    assert.deepEqual(prevBlock([], NOW), { ts: null, age_h: null, odds_markets_max_id: null });
    assert.equal(prevBlock(good, NOW).odds_markets_max_id, 500);
});

test('errorSnapshot is RED snapshot_error, keeps the full shape', () => {
    const s = errorSnapshot(NOW, new Error('x'), 'timeout:120s');
    assert.equal(s.verdict, 'RED');
    assert.deepEqual(s.reasons, ['snapshot_error', 'timeout:120s']);
    assert.equal(s.error, 'x');
    assert.equal(s.day, '2026-10-10');
    assert.deepEqual(Object.keys(s), Object.keys(baseSnapshot(NOW)));
});

test('alert phone: env first, admin fallback, none -> null; text capped at 140', () => {
    assert.equal(pickAlertPhone(' +254700000001 ', '+254700000002'), '+254700000001');
    assert.equal(pickAlertPhone('', '+254700000002'), '+254700000002');
    assert.equal(pickAlertPhone(undefined, null), null);
    const s = errorSnapshot(NOW, 'e');
    s.reasons = Array.from({ length: 40 }, (_, i) => `reason_${i}`);
    assert.equal(alertText(s).length, 140);
    assert.ok(alertText(s).startsWith('oddspro RED 2026-10-10: reason_0, reason_1'));
});

// ---- endpoint params -------------------------------------------------------

test('parseLedgerDays: default, bounds, junk', () => {
    assert.deepEqual(parseLedgerDays(undefined), { ok: true, days: HEALTH_LEDGER_DEFAULT_DAYS });
    assert.deepEqual(parseLedgerDays(''), { ok: true, days: 14 });
    assert.deepEqual(parseLedgerDays('1'), { ok: true, days: 1 });
    assert.deepEqual(parseLedgerDays(' 120 '), { ok: true, days: HEALTH_LEDGER_MAX_DAYS });
    for (const bad of ['0', '121', '-3', '7.5', 'abc', '1e2', ['7', '8']]) {
        assert.equal(parseLedgerDays(bad).ok, false, `expected ${JSON.stringify(bad)} rejected`);
    }
});

// ---- one snapshot per EAT day, writer only ---------------------------------

test('snapshotDecision: writer only, off, before slot, take, done', () => {
    const base = { nowMs: NOW, atMinutes: AT_1320, writer: true };
    assert.equal(snapshotDecision({ ...base, writer: false }), 'not_writer');
    assert.equal(snapshotDecision({ ...base, atMinutes: null }), 'off');
    assert.equal(snapshotDecision(base), 'take');
    assert.equal(snapshotDecision({ ...base, doneDay: '2026-10-10' }), 'done');
    // yesterday's done-day does not block today
    assert.equal(snapshotDecision({ ...base, doneDay: '2026-10-09' }), 'take');
    // a boot at 08:00 EAT waits for the slot instead of snapshotting early
    assert.equal(snapshotDecision({ ...base, nowMs: Date.UTC(2026, 9, 10, 5, 0, 0) }), 'before_slot');
    // EAT day boundary: 23:59 EAT on the 10th is still the 10th, 00:01 the 11th
    const lateMs = Date.UTC(2026, 9, 10, 20, 59, 0);
    assert.equal(snapshotDecision({ ...base, nowMs: lateMs, doneDay: '2026-10-10' }), 'done');
    const nextDayEarly = Date.UTC(2026, 9, 10, 21, 1, 0);
    assert.equal(snapshotDecision({ ...base, nowMs: nextDayEarly, doneDay: '2026-10-10' }), 'before_slot');
});

test('snapshotDecision: failed writes back off and cap per day, reset the next day', () => {
    const base = { nowMs: NOW, atMinutes: AT_1320, writer: true };
    let a = nextAttempts(null, NOW);
    assert.deepEqual(a, { day: '2026-10-10', count: 1, lastMs: NOW });
    assert.equal(snapshotDecision({ ...base, attempts: a }), 'backoff');
    assert.equal(snapshotDecision({ ...base, nowMs: NOW + HEALTH_SNAPSHOT_RETRY_MS, attempts: a }), 'take');
    for (let i = 1; i < HEALTH_SNAPSHOT_MAX_ATTEMPTS; i++) a = nextAttempts(a, NOW);
    assert.equal(a.count, HEALTH_SNAPSHOT_MAX_ATTEMPTS);
    assert.equal(snapshotDecision({ ...base, nowMs: NOW + 3_600_000, attempts: a }), 'exhausted');
    const tomorrow = NOW + 24 * 3_600_000;
    assert.equal(snapshotDecision({ ...base, nowMs: tomorrow, attempts: a }), 'take');
    assert.equal(nextAttempts(a, tomorrow).count, 1);
});

// ---- read-back -------------------------------------------------------------

test('decodeSnapshotRow parses JSON text columns and tolerates parsed or broken ones', () => {
    const row = { id: 3, day: '2026-10-10', taken_at: '2026-10-10 13:20:30', verdict: 'AMBER', reasons: '["x"]', payload: '{"a":1}' };
    assert.deepEqual(decodeSnapshotRow(row), { ...row, reasons: ['x'], payload: { a: 1 } });
    assert.deepEqual(decodeSnapshotRow({ ...row, reasons: ['y'], payload: { b: 2 } }).payload, { b: 2 });
    assert.deepEqual(decodeSnapshotRow({ ...row, reasons: '{bad', payload: null }).reasons, []);
    assert.equal(decodeSnapshotRow(null), null);
});

test('ledgerFreshness: alive, missing today after slot + grace, stale, empty', () => {
    const today = { day: '2026-10-10', taken_at: '2026-10-10 13:20:30' };
    assert.deepEqual(ledgerFreshness(today, NOW, AT_1320), {
        today: '2026-10-10', latest_day: '2026-10-10', age_h: 0.1, missing_today: false, stale: false,
    });
    const yday = { day: '2026-10-09', taken_at: '2026-10-09 13:20:30' };
    assert.equal(ledgerFreshness(yday, NOW, AT_1320).missing_today, false); // inside the 30 min grace
    const at1400 = Date.UTC(2026, 9, 10, 11, 0, 0);
    assert.equal(ledgerFreshness(yday, at1400, AT_1320).missing_today, true);
    assert.equal(ledgerFreshness(yday, at1400, AT_1320).stale, false);
    const old = { day: '2026-10-08', taken_at: '2026-10-08 13:20:30' };
    assert.equal(ledgerFreshness(old, NOW, AT_1320).stale, true);
    assert.deepEqual(ledgerFreshness(null, NOW, null), {
        today: '2026-10-10', latest_day: null, age_h: null, missing_today: false, stale: true,
    });
});

// ---- signal readers against a stub knex ------------------------------------

function stubDb(handlers) {
    return {
        raw: async sql => {
            for (const [re, fn] of handlers) if (re.test(sql)) return [await fn(sql)];
            throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
        },
    };
}

const CLOCK = [{ now_eat: '2026-10-10 13:25:00', today: '2026-10-10', yday: '2026-10-09', tmrw: '2026-10-11', dbname: 'oddspro' }];

test('collectDbSignals: fills the snapshot, isolates a failed read, returns the phone outside it', async () => {
    const db = stubDb([
        [/AS now_eat/, () => CLOCK],
        [/mode = 'light'/, () => [{ id: 1, verdict: 'ok', s: '2026-10-10 13:10:00' }, { id: 2, verdict: 'error', s: '2026-10-10 13:20:00' }]],
        [/mode = 'full'/, () => [{ id: 5, verdict: 'ok', s: '2026-10-10 05:00:00', f: '2026-10-10 08:00:00', sf: '[]' }]],
        [/FROM meta/, () => { throw new Error('meta exploded'); }],
        [/FROM matches WHERE start_time >= NOW/, () => [{ n: 12 }]],
        [/UNION ALL/, () => [{ t: 'odds_markets', v: '999' }]],
        [/information_schema/, () => [{ t: 'odds_markets', r: '500', mb: '12.5' }]],
        [/FROM fixtures/, () => [{ n: 40 }]],
        [/GROUP BY 1, 2/, () => [{ d: '2026-10-10', provider: 'betpawa', n: 80, linked: 70 }]],
        [/GROUP BY status/, () => [{ status: 'unconfirmed', n: 2 }, { status: 'dismissed', n: 9 }]],
        [/status = 'unconfirmed' AND created_at/, () => []],
        [/MAX\(id\) AS n FROM data_notices/, () => [{ n: 31 }]],
        [/SHOW GLOBAL STATUS/, () => [{ Variable_name: 'Uptime', Value: '3600' }]],
        [/FROM users/, () => [{ phone: '+254700000009' }]],
    ]);
    const snap = baseSnapshot(NOW);
    const { adminPhone } = await collectDbSignals(db, snap);
    assert.equal(adminPhone, '+254700000009');
    assert.equal(JSON.stringify(snap).includes('254700000009'), false, 'phone must never enter the snapshot');
    assert.deepEqual(snap.unread, ['meta']);
    assert.deepEqual(snap.reasons, ['unread:meta']);
    assert.equal(snap.light.total_24h, 2);
    assert.equal(snap.full.id, 5);
    assert.equal(snap.full_missing_today, false);
    assert.equal(snap.fixtures_nearby, 12);
    assert.equal(snap.counters.max_id.odds_markets, 999);
    assert.equal(snap.counters.mb.odds_markets, 12.5);
    assert.equal(snap.counters.finals_yesterday, 40);
    assert.deepEqual(snap.coverage.today, { betpawa: { n: 80, linked: 70 } });
    assert.deepEqual(snap.notices.by_status, { unconfirmed: 2 });
    assert.equal(snap.notices.newest_id, 31);
    assert.equal(snap.host.db_uptime_s, 3600);
    // light error counted by the verdict rule
    assert.ok(decideHealth(snap).reasons.includes('light_failed:1'));
});

test('collectDbSignals: an unreachable DB throws for the caller to classify', async () => {
    const db = { raw: async () => { throw new Error('ECONNREFUSED'); } };
    await assert.rejects(collectDbSignals(db, baseSnapshot(NOW)), /ECONNREFUSED/);
});

test('collectApiStatus without a configured key marks the blind spot and never throws', async () => {
    const snap = baseSnapshot(NOW);
    await collectApiStatus(snap, { url: 'https://example.invalid', key: '' });
    assert.deepEqual(snap.reasons, ['api_status_unavailable']);
});

test('collectHost in-process never throws and adds no unread reasons', async () => {
    const snap = baseSnapshot(NOW);
    await collectHost(snap, { appRoot: process.cwd(), markUnread: false });
    assert.deepEqual(snap.reasons, []);
    assert.ok(snap.host.disk_free_gb == null || snap.host.disk_free_gb >= 0);
});
