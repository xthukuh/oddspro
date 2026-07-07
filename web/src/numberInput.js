// Pure helpers behind the text-based NumberInput control (kept separate from
// the component so they test offline). The control lets the user type freely -
// blank, a lone '.', '20.', '.05' are all valid MID-EDIT states - and only
// commits a clean clamped number to its parent. Blank parses as 0.

// Accepts every partial numeric entry a user can pass through while typing a
// real number: '', '.', '-', '20', '20.', '.5', '20.34', '-3.1'. Rejects
// letters, exponents, thousands separators, multiple dots. Used to SILENTLY
// ignore bad keystrokes (the field just doesn't change).
export const NUMBER_RE = /^-?\d*\.?\d*$/;

// Parse a raw entry to a committed number: blank / '.' / '-' -> 0, anything
// non-finite -> 0, rounded when `int`, then clamped to [min, max] when given.
export function clampNumber(str, { min, max, int } = {}) {
    let n = Number(str);
    if (str === '' || str === '.' || str === '-' || !Number.isFinite(n)) n = 0;
    if (int) n = Math.round(n);
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    return n;
}
