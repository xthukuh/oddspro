// Pure data-notice rules (src/db/notice-rules.js): run history to notice
// proposals, plus display and payload shaping. Offline, no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    severityRank, eatDay, datesBetween, runGapSpans, partialSpans,
    detectNotices, noticesForDate, coverageStatus, noticeLabel, coveragePayload,
} from '../src/db/notice-rules.js';

// A run row as `collection_runs` stores it.
const run = (finished, verdict = 'ok', dates = [], stepFailures = []) => ({
    finished_at: finished, verdict, dates, step_failures: stepFailures, mode: 'light',
});

test('severityRank orders outage above degraded above nothing', () => {
    assert.equal(severityRank('outage'), 2);
    assert.equal(severityRank('degraded'), 1);
    assert.equal(severityRank('nonsense'), 0);
    assert.equal(severityRank(null), 0);
});

test('eatDay reads a UTC instant as its EAT calendar day', () => {
    // 2026-08-16T22:30Z is already 2026-08-17 in EAT (+03:00).
    assert.equal(eatDay('2026-08-16T22:30:00Z'), '2026-08-17');
    assert.equal(eatDay('2026-08-16T01:20:00+03:00'), '2026-08-16');
    assert.equal(eatDay(null), null);
    assert.equal(eatDay('not a date'), null);
});

test('datesBetween is inclusive on both ends', () => {
    assert.deepEqual(datesBetween('2026-08-16', '2026-08-18'),
        ['2026-08-16', '2026-08-17', '2026-08-18']);
    assert.deepEqual(datesBetween('2026-08-16', '2026-08-16'), ['2026-08-16']);
    assert.deepEqual(datesBetween('2026-08-18', '2026-08-16'), []);
});

test('runGapSpans finds nothing in a healthy 10-minute cadence', () => {
    const runs = [
        run('2026-08-20T06:00:00+03:00'),
        run('2026-08-20T06:10:00+03:00'),
        run('2026-08-20T06:20:00+03:00'),
    ];
    assert.deepEqual(runGapSpans(runs, { maxGapMinutes: 90 }), []);
});

test('runGapSpans finds the three-day outage', () => {
    const runs = [
        run('2026-08-16T01:20:00+03:00'),
        run('2026-08-19T00:30:00+03:00'),
    ];
    const spans = runGapSpans(runs, { maxGapMinutes: 90 });
    assert.equal(spans.length, 1);
    assert.equal(spans[0].date_from, '2026-08-16');
    assert.equal(spans[0].date_to, '2026-08-19');
    assert.equal(spans[0].gap_minutes, 4270);
});

test('runGapSpans ignores unordered input by sorting first', () => {
    const runs = [
        run('2026-08-19T00:30:00+03:00'),
        run('2026-08-16T01:20:00+03:00'),
    ];
    assert.equal(runGapSpans(runs, { maxGapMinutes: 90 }).length, 1);
});

test('runGapSpans tolerates empty and single-run history', () => {
    assert.deepEqual(runGapSpans([], { maxGapMinutes: 90 }), []);
    assert.deepEqual(runGapSpans([run('2026-08-20T06:00:00+03:00')], { maxGapMinutes: 90 }), []);
    assert.deepEqual(runGapSpans(null, { maxGapMinutes: 90 }), []);
});

test('partialSpans reports only the dates a partial run covered', () => {
    const runs = [
        run('2026-08-20T06:00:00+03:00', 'ok', ['2026-08-20']),
        run('2026-08-20T06:10:00+03:00', 'partial', ['2026-08-20', '2026-08-21'],
            [{ step: 'betika odds 2026-08-21', error: 'timeout' }]),
    ];
    const spans = partialSpans(runs);
    assert.equal(spans.length, 1);
    assert.equal(spans[0].date_from, '2026-08-20');
    assert.equal(spans[0].date_to, '2026-08-21');
    assert.deepEqual(spans[0].steps, ['betika odds 2026-08-21']);
});

test('partialSpans ignores ok, error and cancelled runs', () => {
    const runs = [
        run('2026-08-20T06:00:00+03:00', 'ok', ['2026-08-20']),
        run('2026-08-20T06:10:00+03:00', 'error', ['2026-08-20']),
        run('2026-08-20T06:20:00+03:00', 'cancelled', ['2026-08-20']),
    ];
    assert.deepEqual(partialSpans(runs), []);
});

test('detectNotices proposes an outage notice with plain copy', () => {
    const runs = [
        run('2026-08-16T01:20:00+03:00'),
        run('2026-08-19T00:30:00+03:00'),
    ];
    const [p] = detectNotices(runs, { maxGapMinutes: 90 });
    assert.equal(p.kind, 'odds_outage');
    assert.equal(p.severity, 'outage');
    assert.equal(p.date_from, '2026-08-16');
    assert.equal(p.date_to, '2026-08-19');
    assert.equal(p.title, 'No odds collected');
    assert.equal(p.note, 'Collection was down. Odds for these games were never captured.');
    assert.equal(p.evidence.gap_minutes, 4270);
    // Copy discipline: no numbers leak into human-facing strings.
    assert.ok(!/\d/.test(p.title));
    assert.ok(!/\d/.test(p.note));
});

test('detectNotices proposes a degraded notice for a partial run', () => {
    const runs = [
        run('2026-08-20T06:00:00+03:00', 'ok', ['2026-08-20']),
        run('2026-08-20T06:10:00+03:00', 'partial', ['2026-08-20'],
            [{ step: 'betika odds 2026-08-20', error: 'timeout' }]),
    ];
    const [p] = detectNotices(runs, { maxGapMinutes: 90 });
    assert.equal(p.kind, 'odds_degraded');
    assert.equal(p.severity, 'degraded');
    assert.equal(p.title, 'Some odds missing');
    assert.equal(p.note, 'Collection ran but did not finish. Some games have no odds.');
    assert.deepEqual(p.evidence.steps, ['betika odds 2026-08-20']);
});

// REGRESSION GUARD. These five days are healthy in the live warehouse but a
// row-count heuristic flags them (see the spec's section 2). A run history
// with no gaps and no partial runs must produce NO notice, whatever the row
// counts on those days were.
test('healthy thin slates produce no notice', () => {
    // 2026-07-20, 21, 27, 28 and 30 are the healthy days a row-count rule
    // flags. Collection ran CONTINUOUSLY across the whole stretch, so the
    // ledger shows no gap and no partial run. The fixture must therefore
    // cover every day in the range, not only the thin ones: leaving the
    // intervening days out would manufacture the very gap being asserted
    // against, which is a broken fixture rather than a real regression.
    const runs = [];
    for (const day of datesBetween('2026-07-19', '2026-07-31')) {
        for (let h = 0; h < 24; h++) {
            const hh = String(h).padStart(2, '0');
            runs.push(run(`${day}T${hh}:00:00+03:00`, 'ok', [day]));
        }
    }
    assert.deepEqual(detectNotices(runs, { maxGapMinutes: 90 }), []);
});

test('noticesForDate is inclusive on both boundary dates', () => {
    const n = [{ date_from: '2026-08-16', date_to: '2026-08-18', severity: 'outage', status: 'approved' }];
    assert.equal(noticesForDate(n, '2026-08-16').length, 1);
    assert.equal(noticesForDate(n, '2026-08-18').length, 1);
    assert.equal(noticesForDate(n, '2026-08-17').length, 1);
    assert.equal(noticesForDate(n, '2026-08-15').length, 0);
    assert.equal(noticesForDate(n, '2026-08-19').length, 0);
    assert.equal(noticesForDate(n, null).length, 0);
});

test('noticesForDate never returns a dismissed notice', () => {
    const n = [{ date_from: '2026-08-16', date_to: '2026-08-18', severity: 'outage', status: 'dismissed' }];
    assert.equal(noticesForDate(n, '2026-08-17').length, 0);
});

test('coverageStatus takes the loudest severity present', () => {
    assert.equal(coverageStatus([]), 'ok');
    assert.equal(coverageStatus([{ severity: 'degraded' }]), 'degraded');
    assert.equal(coverageStatus([{ severity: 'degraded' }, { severity: 'outage' }]), 'outage');
    assert.equal(coverageStatus(null), 'ok');
});

test('noticeLabel prefixes only unconfirmed notices', () => {
    assert.equal(noticeLabel({ title: 'No odds collected', status: 'approved' }),
        'No odds collected');
    assert.equal(noticeLabel({ title: 'No odds collected', status: 'unconfirmed' }),
        'UNCONFIRMED - No odds collected');
});

test('coveragePayload reports confirmed false when any notice is unconfirmed', () => {
    const n = [
        { date_from: '2026-08-16', date_to: '2026-08-18', severity: 'outage', status: 'approved', title: 'a' },
        { date_from: '2026-08-17', date_to: '2026-08-17', severity: 'degraded', status: 'unconfirmed', title: 'b' },
    ];
    const p = coveragePayload(n, '2026-08-17');
    assert.equal(p.status, 'outage');
    assert.equal(p.confirmed, false);
    assert.equal(p.notices.length, 2);
});

test('coveragePayload on a clean day is ok and confirmed', () => {
    const p = coveragePayload([], '2026-08-20');
    assert.deepEqual(p, { status: 'ok', confirmed: true, notices: [] });
});
