// M4.2 emergence-pattern mining rules (src/db/mine-rules.js). Pure module -
// these tests run with no .env, no DB and no network. The bootstrap test is
// the load-bearing one: it asserts we resample DAYS, not rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    temporalSplit, benjaminiHochberg, dayClusteredBootstrap,
} from '../src/db/mine-rules.js';

test('temporalSplit cuts on day boundaries, oldest 70% train', () => {
    const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05',
        '2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09', '2026-07-10'];
    const { train, test: te } = temporalSplit(days, 0.7);
    assert.equal(train.length, 7);
    assert.equal(te.length, 3);
    assert.equal(train.at(-1), '2026-07-07');
    assert.equal(te[0], '2026-07-08');
});

test('temporalSplit sorts unsorted input before cutting', () => {
    const { train, test: te } = temporalSplit(['2026-07-03', '2026-07-01', '2026-07-02'], 0.7);
    assert.deepEqual(train, ['2026-07-01', '2026-07-02']);
    assert.deepEqual(te, ['2026-07-03']);
});

test('temporalSplit degenerates safely on tiny/empty input', () => {
    assert.deepEqual(temporalSplit([], 0.7), { train: [], test: [] });
    assert.deepEqual(temporalSplit(['2026-07-01'], 0.7), { train: ['2026-07-01'], test: [] });
});

// Benjamini & Hochberg (1995) worked example, q=0.05 -> reject the two smallest.
test('benjaminiHochberg matches the canonical worked example', () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    assert.deepEqual(benjaminiHochberg(p, 0.05),
        [true, true, false, false, false, false, false, false, false, false]);
});

test('benjaminiHochberg returns rejections in INPUT order, not sorted order', () => {
    // same p-values shuffled: the two smallest (0.001, 0.008) sit at index 3 and 0
    const p = [0.008, 0.216, 0.039, 0.001, 0.212];
    assert.deepEqual(benjaminiHochberg(p, 0.05), [true, false, false, true, false]);
});

// BH is a step-UP procedure: an interior rank may fail its OWN threshold and
// still be rejected, because a LATER rank passed. Here rank 2 (p=0.04) fails
// its 0.0333 threshold, but rank 3 (p=0.05) passes its 0.05 -> all three
// reject. A naive "stop at the first failure" loop would return [true,f,f].
test('benjaminiHochberg is a step-UP procedure, not first-failure-wins', () => {
    const p = [0.001, 0.04, 0.05];
    assert.deepEqual(benjaminiHochberg(p, 0.05), [true, true, true]);
});

test('benjaminiHochberg rejects nothing at q=0 or when all p are 1', () => {
    assert.deepEqual(benjaminiHochberg([0.001, 0.002], 0), [false, false]);
    assert.deepEqual(benjaminiHochberg([1, 1, 1], 0.1), [false, false, false]);
    assert.deepEqual(benjaminiHochberg([], 0.1), []);
});

// THE load-bearing test. Two days, perfectly split outcomes. Resampling DAYS
// can draw {A,A}=1.0, {A,B}=0.5, {B,B}=0.0 -> the CI must span nearly [0,1].
// A row-level resampler would report ~0.5 +/- 0.07 and fake precision we do
// not have. This test is the difference between honest and confident-wrong.
test('dayClusteredBootstrap resamples days, not rows', () => {
    const rows = [
        ...Array.from({ length: 50 }, () => ({ day: 'A', hit: 1 })),
        ...Array.from({ length: 50 }, () => ({ day: 'B', hit: 0 })),
    ];
    const rate = rs => (rs.length ? rs.reduce((s, r) => s + r.hit, 0) / rs.length : null);
    const { point, lo, hi } = dayClusteredBootstrap(rows, rate, { draws: 500, seed: 7 });
    assert.equal(point, 0.5);
    assert.ok(lo <= 0.01, `day-clustered lo should reach ~0, got ${lo}`);
    assert.ok(hi >= 0.99, `day-clustered hi should reach ~1, got ${hi}`);
});

test('dayClusteredBootstrap is deterministic for a given seed', () => {
    const rows = [
        ...Array.from({ length: 20 }, (_, i) => ({ day: 'A', hit: i % 2 })),
        ...Array.from({ length: 20 }, (_, i) => ({ day: 'B', hit: i % 3 ? 1 : 0 })),
        ...Array.from({ length: 20 }, (_, i) => ({ day: 'C', hit: i % 4 ? 0 : 1 })),
    ];
    const rate = rs => (rs.length ? rs.reduce((s, r) => s + r.hit, 0) / rs.length : null);
    const a = dayClusteredBootstrap(rows, rate, { draws: 200, seed: 42 });
    const b = dayClusteredBootstrap(rows, rate, { draws: 200, seed: 42 });
    assert.deepEqual(a, b);
});

test('dayClusteredBootstrap returns nulls on empty input', () => {
    assert.deepEqual(dayClusteredBootstrap([], () => null, { draws: 10, seed: 1 }),
        { point: null, lo: null, hi: null });
});
