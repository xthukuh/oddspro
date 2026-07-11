import { useEffect, useLayoutEffect, useState } from 'react';

// Shared anchored-dropdown behaviour for the fixed-position panels (MultiSelect,
// ReorderList) - extracted so the two can't drift (they carried byte-identical
// copies of this). Positions the panel under its trigger, flipping ABOVE when
// the space below is tight; closes on outside pointerdown and Escape; and
// repositions on scroll/resize while open (so it tracks a scrolling modal body).
//
// Escape is handled on `document` (bubble phase) and calls stopPropagation while
// open, so closing a dropdown that lives INSIDE a Sheet never also closes the
// Sheet (whose Escape listener sits on `window`, one hop further out).
//
//   open       : whether the panel is shown
//   onClose    : () => void - called to dismiss (outside click / Escape)
//   wrapRef    : ref to the wrapper (trigger + panel) for the outside-click test
//   btnRef     : ref to the trigger button (anchor)
//   rightGutter: viewport - panelWidth clamp (256+8 for w-64, 288 for w-72)
// Returns `pos` ({ left, top?, bottom?, maxH }) or null before first placement.
export default function useAnchoredPanel({ open, onClose, wrapRef, btnRef, rightGutter = 264 }) {
    const [pos, setPos] = useState(null);

    const place = () => {
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom;
        const flipUp = below < 280 && r.top > below;
        setPos({
            left: Math.max(8, Math.min(r.left, window.innerWidth - rightGutter)),
            top: flipUp ? undefined : Math.round(r.bottom + 4),
            bottom: flipUp ? Math.round(window.innerHeight - r.top + 4) : undefined,
            maxH: Math.max(160, Math.round((flipUp ? r.top : below) - 16)),
        });
    };

    useLayoutEffect(() => { if (open) place(); }, [open]);
    useEffect(() => {
        if (!open) return;
        const onDown = e => { if (!wrapRef.current?.contains(e.target)) onClose(); };
        const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
        const reposition = () => place();
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', reposition, true); // capture inner scrolls too
        window.addEventListener('resize', reposition);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [open]);

    return pos;
}
