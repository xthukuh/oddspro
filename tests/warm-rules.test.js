// Pure warm-keeper rules (src/db/warm-rules.js): the date window, the
// pass-due decision, the (date, tier) records target matrix and the pass
// rollup behind src/warm.js. Offline, no DB/config.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warmDates, warmPassDue, recordsWarmTargets, summarizeWarmPass } from '../src/db/warm-rules.js';

test('warmDates spans back..ahead around today, ascending', () => {
    assert.deepEqual(warmDates('2026-08-22', 1, 2),
        ['2026-08-21', '2026-08-22', '2026-08-23', '2026-08-24']);
});

test('warmDates crosses month and year boundaries', () => {
    assert.deepEqual(warmDates('2026-09-01', 1, 0), ['2026-08-31', '2026-09-01']);
    assert.deepEqual(warmDates('2026-12-31', 0, 1), ['2026-12-31', '2027-01-01']);
});

test('warmDates with 0/0 is just today; negatives clamp to 0', () => {
    assert.deepEqual(warmDates('2026-08-22', 0, 0), ['2026-08-22']);
    assert.deepEqual(warmDates('2026-08-22', -3, -1), ['2026-08-22']);
});

test('warmDates is total on garbage input', () => {
    assert.deepEqual(warmDates('not-a-date', 1, 1), []);
    assert.deepEqual(warmDates(undefined, 1, 1), []);
});

const dueBase = { running: false, lastRunAt: 1000, version: 5, lastVersion: 5, nowMs: 2000, maxAgeMs: 300_000 };

test('warmPassDue: boot when never ran', () => {
    assert.equal(warmPassDue({ ...dueBase, lastRunAt: null }), 'boot');
});

test('warmPassDue: version change wins over age', () => {
    assert.equal(warmPassDue({ ...dueBase, version: 6 }), 'version');
    assert.equal(warmPassDue({ ...dueBase, version: 6, nowMs: 1000 + 400_000 }), 'version');
});

test('warmPassDue: age once the last pass is older than maxAgeMs', () => {
    assert.equal(warmPassDue({ ...dueBase, nowMs: 1000 + 300_000 }), 'age');
    assert.equal(warmPassDue({ ...dueBase, nowMs: 1000 + 299_999 }), null);
});

test('warmPassDue: quiet while fresh, never while running', () => {
    assert.equal(warmPassDue(dueBase), null);
    assert.equal(warmPassDue({ ...dueBase, running: true, version: 6, lastRunAt: null }), null);
});

test('recordsWarmTargets orders today first and crosses dates x tiers', () => {
    const targets = recordsWarmTargets({
        dates: ['2026-08-21', '2026-08-22', '2026-08-23'],
        todayIso: '2026-08-22',
        tiers: [{ tier: 'full', canFuture: true }, { tier: 'guest', canFuture: false }],
    });
    assert.deepEqual(targets, [
        { date: '2026-08-22', tier: 'full' },
        { date: '2026-08-22', tier: 'guest' },
        { date: '2026-08-21', tier: 'full' },
        { date: '2026-08-21', tier: 'guest' },
        // guest skipped for the future date: the route 403s it before the
        // cache, so a warmed slot there could never be served
        { date: '2026-08-23', tier: 'full' },
    ]);
});

test('recordsWarmTargets collapses duplicate tiers (premium guest = full slot)', () => {
    const targets = recordsWarmTargets({
        dates: ['2026-08-22'],
        todayIso: '2026-08-22',
        tiers: [{ tier: 'full', canFuture: true }, { tier: 'full', canFuture: true }],
    });
    assert.deepEqual(targets, [{ date: '2026-08-22', tier: 'full' }]);
});

test('recordsWarmTargets is total on empty/malformed input', () => {
    assert.deepEqual(recordsWarmTargets({}), []);
    assert.deepEqual(recordsWarmTargets({ dates: ['2026-08-22'], todayIso: '2026-08-22', tiers: [null, {}] }), []);
});

test('summarizeWarmPass counts computed vs no-op vs failed, caps errors', () => {
    const results = [
        { key: 'a', ok: true, computed: true },
        { key: 'b', ok: true, computed: false }, // fresh no-op, not "computed"
        ...Array.from({ length: 7 }, (_, i) => ({ key: `f${i}`, ok: false, error: 'boom' })),
        null, // a skipped slot must not break the rollup
    ];
    const s = summarizeWarmPass(results);
    assert.equal(s.targets, 9);
    assert.equal(s.computed, 1);
    assert.equal(s.failed, 7);
    assert.equal(s.errors.length, 5);
    assert.deepEqual(s.errors[0], { key: 'f0', error: 'boom' });
});

test('summarizeWarmPass is total on no input', () => {
    assert.deepEqual(summarizeWarmPass(), { targets: 0, computed: 0, failed: 0, errors: [] });
});
