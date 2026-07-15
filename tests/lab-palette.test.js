// Admin lab chart-color helpers (web/src/admin/labPalette.js). Pure, offline -
// fixed categorical slots, the monotone sequential ramp, bin labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CATEGORICAL_LIGHT, CATEGORICAL_DARK, MAX_SERIES, seriesColor, rampColor, binLabel, pct,
} from '../web/src/admin/labPalette.js';

test('categorical slots: fixed order, both modes same length, valid hex', () => {
    assert.equal(CATEGORICAL_LIGHT.length, CATEGORICAL_DARK.length);
    assert.equal(MAX_SERIES, CATEGORICAL_LIGHT.length);
    for (const c of [...CATEGORICAL_LIGHT, ...CATEGORICAL_DARK]) assert.match(c, /^#[0-9a-f]{6}$/);
    assert.equal(seriesColor(0), CATEGORICAL_LIGHT[0]);
    assert.equal(seriesColor(1, true), CATEGORICAL_DARK[1]);
    // Never cycles - out-of-range clamps to the last slot instead of repeating.
    assert.equal(seriesColor(99), CATEGORICAL_LIGHT[MAX_SERIES - 1]);
});

test('rampColor: valid hex, monotone lightness, floor keeps rate-0 visible', () => {
    const chan = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    const lum = h => chan(h).reduce((a, b) => a + b, 0);
    // Light mode: higher rate = darker (toward the accent).
    let prev = Infinity;
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const l = lum(rampColor(r, false));
        assert.ok(l < prev, `light ramp monotone at ${r}`);
        prev = l;
    }
    // Dark mode flips: higher rate = lighter.
    prev = -Infinity;
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
        const l = lum(rampColor(r, true));
        assert.ok(l > prev, `dark ramp monotone at ${r}`);
        prev = l;
    }
    assert.notEqual(rampColor(0, false), '#ffffff'); // floor: never invisible
    assert.equal(rampColor(1, false), '#5856dc'); // full rate = the accent
    assert.match(rampColor('junk', true), /^#[0-9a-f]{6}$/); // tolerant
});

test('binLabel/pct: numeric ranges without float noise, categories verbatim', () => {
    assert.equal(binLabel(0.3, { width: 0.1 }), '0.3–0.4'); // no 0.30000000000000004
    assert.equal(binLabel(1.5, { width: 0.25 }), '1.5–1.75');
    assert.equal(binLabel(-10, { width: 5 }), '-10–-5');
    assert.equal(binLabel('Premier League', undefined), 'Premier League');
    assert.equal(pct(0.625), '63%');
    assert.equal(pct(null), '–');
});
