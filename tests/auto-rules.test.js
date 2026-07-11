// Auto-refresh scheduling rules (src/db/auto-rules.js). The scheduler tick
// feeds these predicates epoch ms; "daily" is an EAT calendar day (+03:00,
// no DST), independent of the server's timezone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseDailyTime, eatDateKey, eatMinutesOfDay, isFullDue, isLightDue, trimLogTail, refreshOutcome,
} from '../src/db/auto-rules.js';

// refreshOutcome (F3): classify a finished refresh job.
test('refreshOutcome reports ok for a clean run', () => {
    assert.equal(refreshOutcome({ error: null, cancelRequested: false }), 'ok');
    assert.equal(refreshOutcome({}), 'ok');
});

test('refreshOutcome reports error when a run threw without a cancel', () => {
    assert.equal(refreshOutcome({ error: 'boom', cancelRequested: false }), 'error');
});

test('refreshOutcome treats a cancel as cancelled even if the abort threw', () => {
    assert.equal(refreshOutcome({ error: 'cancelled', cancelRequested: true }), 'cancelled');
    assert.equal(refreshOutcome({ error: null, cancelRequested: true }), 'cancelled');
});

const utc = iso => new Date(iso).getTime();

test('parseDailyTime parses HH:MM and rejects everything else', () => {
    assert.equal(parseDailyTime('06:00'), 360);
    assert.equal(parseDailyTime('00:00'), 0);
    assert.equal(parseDailyTime('23:59'), 23 * 60 + 59);
    assert.equal(parseDailyTime(' 06:00 '), 360); // trimmed
    assert.equal(parseDailyTime(''), null);       // disabled
    assert.equal(parseDailyTime('off'), null);
    assert.equal(parseDailyTime('OFF'), null);
    assert.equal(parseDailyTime('6:00'), null);   // strict two-digit hours
    assert.equal(parseDailyTime('24:00'), null);
    assert.equal(parseDailyTime('06:60'), null);
    assert.equal(parseDailyTime('garbage'), null);
    assert.equal(parseDailyTime(null), null);
    assert.equal(parseDailyTime(undefined), null);
});

test('eatDateKey/eatMinutesOfDay shift UTC into the EAT day', () => {
    // 2026-07-09 22:30 UTC = 2026-07-10 01:30 EAT - next EAT day
    assert.equal(eatDateKey(utc('2026-07-09T22:30:00Z')), '2026-07-10');
    assert.equal(eatMinutesOfDay(utc('2026-07-09T22:30:00Z')), 90);
    // 2026-07-09 12:00 UTC = 15:00 EAT, same day
    assert.equal(eatDateKey(utc('2026-07-09T12:00:00Z')), '2026-07-09');
    assert.equal(eatMinutesOfDay(utc('2026-07-09T12:00:00Z')), 15 * 60);
});

test('isFullDue fires once past the EAT time, once per EAT day', () => {
    const at = parseDailyTime('06:00'); // 06:00 EAT = 03:00 UTC
    // Before the mark: not due
    assert.equal(isFullDue(utc('2026-07-09T02:55:00Z'), at, null), false);
    // Past the mark, never ran: due
    assert.equal(isFullDue(utc('2026-07-09T03:05:00Z'), at, null), true);
    // Past the mark but already started this EAT day: blocked
    assert.equal(isFullDue(utc('2026-07-09T03:05:00Z'), at, '2026-07-09'), false);
    assert.equal(isFullDue(utc('2026-07-09T20:00:00Z'), at, '2026-07-09'), false);
    // Next EAT day re-arms (21:05 UTC on the 9th is 00:05 EAT on the 10th -
    // before 06:00 EAT, so still not due; 03:05 UTC on the 10th is)
    assert.equal(isFullDue(utc('2026-07-09T21:05:00Z'), at, '2026-07-09'), false);
    assert.equal(isFullDue(utc('2026-07-10T03:05:00Z'), at, '2026-07-09'), true);
    // Disabled mode never fires
    assert.equal(isFullDue(utc('2026-07-09T03:05:00Z'), null, null), false);
});

test('isLightDue is an elapsed-interval check; 0 disables', () => {
    const t0 = utc('2026-07-09T10:00:00Z');
    assert.equal(isLightDue(t0 + 9 * 60_000, t0, 10), false);
    assert.equal(isLightDue(t0 + 10 * 60_000, t0, 10), true); // exact boundary
    assert.equal(isLightDue(t0 + 60 * 60_000, t0, 10), true);
    assert.equal(isLightDue(t0 + 60 * 60_000, t0, 0), false); // disabled
});

test('trimLogTail keeps content under the cap unchanged', () => {
    const content = 'a\nb\nc\n';
    assert.equal(trimLogTail(content, 100), content);
    assert.equal(trimLogTail(content, content.length), content);
});

test('trimLogTail over the cap keeps <= half, at a line boundary, marked', () => {
    const lines = [...Array(100)].map((_, i) => `line-${String(i).padStart(3, '0')}`);
    const content = lines.join('\n') + '\n';
    const out = trimLogTail(content, 200, '2026-07-09T12:00:00.000Z');
    assert.ok(out.startsWith('[log truncated 2026-07-09T12:00:00.000Z]\n'));
    const body = out.slice(out.indexOf('\n') + 1);
    assert.ok(body.length <= 100);              // half the cap
    assert.ok(body.startsWith('line-'));        // starts at a whole line
    assert.ok(body.endsWith('line-099\n'));     // newest lines survive
});
