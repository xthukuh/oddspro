// Client freshness rules (web/src/freshness.js): which finished refresh jobs
// cover the loaded table date (silent-reload gate for the slow poll).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldReloadForJob, isDateStale } from '../web/src/freshness.js';

test('all-dates view reloads on any successful job', () => {
    assert.equal(shouldReloadForJob({ mode: 'light', dates: ['2026-07-09'] }, null), true);
    assert.equal(shouldReloadForJob({ mode: 'manual', dates: ['2026-01-01'] }, ''), true);
});

test('full sweeps cover every date', () => {
    const job = { mode: 'full', dates: ['2026-07-09', '2026-07-10'] };
    assert.equal(shouldReloadForJob(job, '2026-07-09'), true);
    assert.equal(shouldReloadForJob(job, '2025-01-01'), true); // even outside dates
});

test('light/manual jobs cover only their listed dates', () => {
    const light = { mode: 'light', dates: ['2026-07-09'] };
    assert.equal(shouldReloadForJob(light, '2026-07-09'), true);
    assert.equal(shouldReloadForJob(light, '2026-07-10'), false);
    const manual = { mode: 'manual', dates: ['2026-07-11'] };
    assert.equal(shouldReloadForJob(manual, '2026-07-11'), true);
    assert.equal(shouldReloadForJob(manual, '2026-07-09'), false);
});

test('null/malformed jobs never reload a dated view', () => {
    assert.equal(shouldReloadForJob(null, '2026-07-09'), false);
    assert.equal(shouldReloadForJob(undefined, '2026-07-09'), false);
    assert.equal(shouldReloadForJob('nope', '2026-07-09'), false);
    assert.equal(shouldReloadForJob({ mode: 'light' }, '2026-07-09'), false); // no dates array
    assert.equal(shouldReloadForJob({ mode: 'light', dates: 'x' }, '2026-07-09'), false);
});

// isDateStale (F2): the stale-date nudge gate.
const NOW = new Date('2026-07-11T12:00:00Z').getTime();
const minsAgo = m => NOW - m * 60000;

test('isDateStale flags a live-day date whose data is older than the window', () => {
    assert.equal(isDateStale({ freshestAt: minsAgo(30), isPast: false, now: NOW, maxAgeMinutes: 20 }), true);
});

test('isDateStale is false while the data is within the freshness window', () => {
    assert.equal(isDateStale({ freshestAt: minsAgo(5), isPast: false, now: NOW, maxAgeMinutes: 20 }), false);
});

test('isDateStale never flags past dates (settled/frozen)', () => {
    assert.equal(isDateStale({ freshestAt: minsAgo(9999), isPast: true, now: NOW }), false);
});

test('isDateStale never flags the all-dates view', () => {
    assert.equal(isDateStale({ freshestAt: minsAgo(9999), isAllDates: true, now: NOW }), false);
});

test('isDateStale is false when nothing is loaded or timestamp is unparseable', () => {
    assert.equal(isDateStale({ freshestAt: null, isPast: false, now: NOW }), false);
    assert.equal(isDateStale({ freshestAt: 'not-a-date', isPast: false, now: NOW }), false);
    assert.equal(isDateStale({}), false);
});

test('isDateStale accepts an ISO string timestamp', () => {
    assert.equal(isDateStale({ freshestAt: new Date(minsAgo(45)).toISOString(), isPast: false, now: NOW, maxAgeMinutes: 20 }), true);
});
