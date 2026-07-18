// Visitor-tracking v2 rules (src/db/track-rules.js). Pure, offline - anon-id
// gate, event sanitization (closed name grammar, no free text), session resume
// window, duration math + histogram buckets, beacon request envelopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidAnonId, EVENT_NAME_RE, sanitizeEvents, sessionResumeAllowed,
    computeDuration, durationBucket, DURATION_BUCKETS, durationHistogram,
    checkinSchema, eventsSchema, checkoutSchema,
} from '../src/db/track-rules.js';

test('isValidAnonId accepts UUIDs and rejects junk', () => {
    assert.equal(isValidAnonId('550e8400-e29b-41d4-a716-446655440000'), true);
    assert.equal(isValidAnonId('550E8400-E29B-41D4-A716-446655440000'), true); // case-insensitive
    assert.equal(isValidAnonId('not-a-uuid'), false);
    assert.equal(isValidAnonId(''), false);
    assert.equal(isValidAnonId(null), false);
    assert.equal(isValidAnonId('550e8400e29b41d4a716446655440000'), false);    // no dashes
});

test('sanitizeEvents enforces the closed name grammar and scalar values', () => {
    const out = sanitizeEvents([
        { name: 'magic_sort_toggle', value: 'sure' },
        { name: 'filters_apply', value: 3 },
        { name: 'safe_only', value: true },
        { name: 'BadName', value: 'x' },              // uppercase rejected
        { name: 'has space', value: 'x' },            // space rejected
        { name: '9starts_with_digit' },               // must start with a letter
        { name: 'free_text', value: { evil: 'obj' } }, // non-scalar value -> null
        'not-an-object',
        { value: 'nameless' },
    ]);
    assert.deepEqual(out, [
        { name: 'magic_sort_toggle', value: 'sure' },
        { name: 'filters_apply', value: '3' },
        { name: 'safe_only', value: 'true' },
        { name: 'free_text', value: null },
    ]);
});

test('sanitizeEvents caps batch size and value length', () => {
    const big = Array.from({ length: 40 }, (_, i) => ({ name: 'evt', value: `v${i}` }));
    assert.equal(sanitizeEvents(big).length, 25);
    const long = sanitizeEvents([{ name: 'evt', value: 'x'.repeat(100) }]);
    assert.equal(long[0].value.length, 32);
    assert.deepEqual(sanitizeEvents('junk'), []);
    // Empty-string value folds to null (never stores '').
    assert.deepEqual(sanitizeEvents([{ name: 'evt', value: '' }]), [{ name: 'evt', value: null }]);
});

test('sessionResumeAllowed - open session inside the idle window only', () => {
    const now = Date.parse('2026-07-19T12:00:00Z');
    const open = { ended_at: null, started_at: '2026-07-19T11:00:00Z', last_active_at: '2026-07-19T11:45:00Z' };
    assert.equal(sessionResumeAllowed(open, now), true);                       // 15 min idle
    const stale = { ...open, last_active_at: '2026-07-19T11:00:00Z' };
    assert.equal(sessionResumeAllowed(stale, now), false);                     // 60 min idle
    assert.equal(sessionResumeAllowed(stale, now, { windowMinutes: 90 }), true);
    assert.equal(sessionResumeAllowed({ ...open, ended_at: '2026-07-19T11:50:00Z' }, now), false);
    assert.equal(sessionResumeAllowed(null, now), false);
    // Boundary: exactly the window edge still resumes.
    const edge = { ...open, last_active_at: '2026-07-19T11:30:00Z' };
    assert.equal(sessionResumeAllowed(edge, now, { windowMinutes: 30 }), true);
});

test('computeDuration prefers checkout time, floors to seconds, never negative', () => {
    assert.equal(computeDuration('2026-07-19T11:00:00Z', '2026-07-19T11:05:30Z'), 330);
    assert.equal(computeDuration('2026-07-19T11:00:00Z', '2026-07-19T11:05:30Z', '2026-07-19T11:10:00Z'), 600);
    assert.equal(computeDuration('2026-07-19T11:00:00Z', '2026-07-19T10:00:00Z'), 0); // clock skew clamps
    assert.equal(computeDuration('garbage', 'also-garbage'), null);
});

test('durationBucket bins into the dashboard histogram', () => {
    assert.equal(durationBucket(5), '<30s');
    assert.equal(durationBucket(30), '30s-2m');
    assert.equal(durationBucket(119), '30s-2m');
    assert.equal(durationBucket(120), '2-10m');
    assert.equal(durationBucket(599), '2-10m');
    assert.equal(durationBucket(600), '10-30m');
    assert.equal(durationBucket(1800), '>30m');
    assert.equal(durationBucket(-1), null);
    assert.equal(durationBucket('junk'), null);
    assert.equal(durationBucket(null), null); // Number(null)=0 must not bin as '<30s'
    assert.equal(DURATION_BUCKETS.length, 5);
    for (const s of [0, 45, 300, 900, 4000]) assert.ok(DURATION_BUCKETS.includes(durationBucket(s)));
});

test('durationHistogram pre-bins in fixed bucket order, dropping junk', () => {
    const h = durationHistogram([5, 45, 45, 300, 4000, -1, null, 'junk']);
    assert.deepEqual(h.buckets.map(b => b.bucket), DURATION_BUCKETS); // every bucket, fixed order
    assert.deepEqual(h.buckets.map(b => b.count), [1, 2, 1, 0, 1]);  // zero-filled 10-30m
    assert.equal(h.total, 5);                                        // junk dropped, not counted
    const empty = durationHistogram(null);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.buckets.map(b => b.count), [0, 0, 0, 0, 0]);
});

test('beacon envelopes validate and bound their inputs', () => {
    const ok = checkinSchema.parse({ anon_id: '550e8400-e29b-41d4-a716-446655440000', path: '/', referer: null });
    assert.equal(ok.path, '/');
    assert.throws(() => checkinSchema.parse({ anon_id: 'nope' }));
    const ev = eventsSchema.parse({ sid: '12', key: 'a'.repeat(32), events: [{ name: 'x' }] });
    assert.equal(ev.sid, 12);
    assert.equal(ev.events.length, 1);
    assert.throws(() => eventsSchema.parse({ sid: 12, key: 'short' }));
    assert.throws(() => eventsSchema.parse({ sid: 0, key: 'a'.repeat(32) }));
    const co = checkoutSchema.parse({ sid: 5, key: 'F'.repeat(32) });
    assert.equal(co.sid, 5);
});
