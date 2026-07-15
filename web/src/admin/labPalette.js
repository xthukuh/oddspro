// Pure chart-color helpers for the admin data-viz lab (no imports - offline
// testable). Palette per the dataviz method: categorical slots are the
// validated reference set (run against THIS app's surfaces: light #FFFFFF
// worst adjacent CVD dE 24.2, three slots sub-3:1 = relief via the lab's
// table view; dark #262428 all >= 3:1, CVD floor-band 10.3 = secondary
// encoding via bar gaps + legend). Fixed order, assigned in sequence, never
// cycled - the lab caps color series at the slot count via top_categories.
export const CATEGORICAL_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
export const CATEGORICAL_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926'];
export const MAX_SERIES = CATEGORICAL_LIGHT.length;

export function seriesColor(i, dark = false) {
    const slots = dark ? CATEGORICAL_DARK : CATEGORICAL_LIGHT;
    // Never cycle: callers cap series count at MAX_SERIES; clamp is a guard.
    return slots[Math.max(0, Math.min(slots.length - 1, i))];
}

// Sequential ramp for magnitude (cell/bubble color = outcome rate): one hue -
// the app accent - from the chart surface toward full accent, monotone
// lightness by construction (per-channel lerp between two fixed endpoints;
// the anchor flips in dark where the accent is the LIGHT end). The floor
// keeps a rate-0 mark from vanishing into the surface.
const RAMP = {
    light: { from: [255, 255, 255], to: [88, 86, 220] }, // --surface -> --accent
    dark: { from: [38, 36, 40], to: [139, 137, 240] },
};
const _hex2 = n => n.toString(16).padStart(2, '0');

export function rampColor(rate, dark = false) {
    const { from, to } = dark ? RAMP.dark : RAMP.light;
    const t = 0.12 + 0.88 * Math.max(0, Math.min(1, Number(rate) || 0));
    const c = from.map((f, i) => Math.round(f + (to[i] - f) * t));
    return `#${c.map(_hex2).join('')}`;
}

// Trim float noise off a bin start (0.30000000000000004 -> 0.3).
export function fmtBin(v) {
    return String(Number(Number(v).toFixed(6)));
}

// Human label for one cell value on a lab axis: numeric bins render as their
// range, categories as themselves.
export function binLabel(v, bin) {
    if (!bin || typeof v !== 'number') return String(v);
    return `${fmtBin(v)}–${fmtBin(v + bin.width)}`;
}

// Percentage text for a rate cell ('62%'; guarded cells show a dash).
export function pct(rate) {
    return rate == null ? '–' : `${Math.round(rate * 100)}%`;
}
