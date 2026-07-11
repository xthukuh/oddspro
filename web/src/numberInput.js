// Pure helpers behind the text-based NumberInput control (kept separate from
// the component so they test offline). The control lets the user type freely -
// blank, a lone '.', '20.', '.05' are all valid MID-EDIT states - and only
// commits a clean clamped number to its parent. Blank parses as 0.

// Accepts every partial numeric entry a user can pass through while typing a
// real number: '', '.', '-', '20', '20.', '.5', '20.34', '-3.1'. Rejects
// letters, exponents, thousands separators, multiple dots. Used to SILENTLY
// ignore bad keystrokes (the field just doesn't change).
export const NUMBER_RE = /^-?\d*\.?\d*$/;

// Parse a raw entry to a finite number: blank / '.' / '-' and any non-finite
// value all become 0. Shared by clampNumber and stepNumber.
export function parseRaw(str) {
    const n = Number(str);
    return str === '' || str === '.' || str === '-' || !Number.isFinite(n) ? 0 : n;
}

// Parse a raw entry to a committed number: blank / '.' / '-' -> 0, anything
// non-finite -> 0, rounded when `int`, then clamped to [min, max] when given.
export function clampNumber(str, { min, max, int } = {}) {
    let n = parseRaw(str);
    if (int) n = Math.round(n);
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
}

// Decimal places implied by a step (1 -> 0, 0.1 -> 1, 0.05 -> 2). Used to snap
// stepped decimals to the step's precision so repeated presses don't drift.
function stepDecimals(step) {
    const dot = String(step).indexOf('.');
    return dot === -1 ? 0 : String(step).length - dot - 1;
}

// Nudge a raw entry up (dir=+1) or down (dir=-1) by a reasonable step, then
// clamp/round exactly like clampNumber. Default step is 1 for int fields, 0.1
// otherwise. Non-int results are rounded to the step's decimal precision so
// pressing the arrow keys can't accumulate float drift (2.5000000004).
export function stepNumber(str, dir, { min, max, int, step } = {}) {
    const s = Number.isFinite(step) && step > 0 ? step : int ? 1 : 0.1;
    let n = parseRaw(str) + dir * s;
    if (!int) n = Number(n.toFixed(Math.min(stepDecimals(s), 6)));
    return clampNumber(String(n), { min, max, int });
}
