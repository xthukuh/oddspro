import { useEffect, useRef, useState } from 'react';
import { NUMBER_RE, clampNumber, stepNumber } from '../numberInput.js';

// Text-based numeric input: type freely (blank, '.', '20.', '.05' are all
// valid mid-edit), invalid keystrokes are silently ignored, and the parent
// only ever sees a clean clamped number - never a half-typed string. Blank
// commits as 0 (clamped up to `min` when one is set). A local `raw` string
// owns what's displayed while editing; the incoming `value` only syncs in
// when the field is NOT focused, so a live-committed clamped value can never
// clobber the user's keystrokes (the old type="number" clamp-on-keystroke race).
// ArrowUp/ArrowDown step the value by `step` (default 1 for int, 0.1 otherwise)
// since type="text" gets no native stepping.
export default function NumberInput({ value, onCommit, min, max, int, step, className, ...rest }) {
    const [raw, setRaw] = useState(() => String(value ?? ''));
    const focused = useRef(false);
    const bounds = { min, max, int };

    // Reflect external changes only while the user isn't typing
    useEffect(() => {
        if (!focused.current) setRaw(String(value ?? ''));
    }, [value]);

    const onChange = e => {
        const next = e.target.value;
        if (!NUMBER_RE.test(next)) return; // ignore bad input, field stays put
        setRaw(next);
        onCommit(clampNumber(next, bounds)); // parent sees the number live
    };
    const onBlur = () => {
        focused.current = false;
        const n = clampNumber(raw, bounds);
        setRaw(String(n)); // normalize the display ('' -> '0'/min, '20.' -> '20')
        onCommit(n);
    };
    const onKeyDown = e => {
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault(); // suppress caret-to-end jump / page scroll
        const n = stepNumber(raw, e.key === 'ArrowUp' ? 1 : -1, { min, max, int, step });
        setRaw(String(n));
        onCommit(n);
    };

    return (
        <input
            type="text"
            inputMode="decimal"
            value={raw}
            onFocus={() => { focused.current = true; }}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            className={className}
            {...rest}
        />
    );
}
