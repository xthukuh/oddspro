import { useEffect, useRef, useState } from 'react';

// Reusable tooltip that works on TOUCH (tap to toggle) as well as desktop
// (hover). Native `title=` tooltips never appear on touch devices, yet the
// table leans on them for hidden content (H2H meeting lists, "sorts as"
// values, score breakdowns). A tap-opened tooltip renders an invisible
// full-screen overlay that captures the dismiss tap AND stops it propagating,
// so closing a tooltip can't accidentally trigger the control behind it (e.g.
// a column-header sort). Content may be a string (newlines preserved) or
// nodes. Renders children bare when content is empty.
export default function Tooltip({ content, children, className = '' }) {
    const [open, setOpen] = useState(false);
    const [tap, setTap] = useState(false); // opened by tap (needs overlay) vs hover
    const [pos, setPos] = useState({ top: 0, left: 0 });
    const ref = useRef(null);
    const hoverTimer = useRef(null);

    useEffect(() => {
        if (!open) return;
        const onKey = e => e.key === 'Escape' && close();
        window.addEventListener('keydown', onKey);
        window.addEventListener('resize', close);
        return () => {
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('resize', close);
        };
    }, [open]);

    // Clear any pending hover-open timer on unmount
    useEffect(() => () => clearTimeout(hoverTimer.current), []);

    if (content == null || content === '') return children;

    // Anchor below the trigger, left-aligned, clamped inside the viewport.
    const place = () => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        const vw = window.innerWidth;
        const panelW = Math.min(280, vw - 16);
        setPos({ top: r.bottom + 4, left: Math.min(Math.max(8, r.left), vw - panelW - 8) });
    };
    const close = () => { clearTimeout(hoverTimer.current); setOpen(false); setTap(false); };
    // Desktop hover opens after a short delay (matches native title feel, and
    // stops the tooltip flashing on every cell the pointer crosses).
    const openHover = () => {
        if (tap) return;
        clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => { place(); setOpen(true); }, 350);
    };
    const closeHover = () => {
        if (tap) return;
        clearTimeout(hoverTimer.current);
        setOpen(false);
    };
    // A tap always lands on tap-mode (keeps it open under the overlay); a
    // second tap on the same trigger closes it.
    const onTap = e => {
        e.stopPropagation();
        if (open && tap) { close(); return; }
        place();
        setTap(true);
        setOpen(true);
    };

    return (
        <span
            ref={ref}
            className={`cursor-help ${className}`}
            onMouseEnter={openHover}
            onMouseLeave={closeHover}
            onClick={onTap}
        >
            {children}
            {open && (
                <>
                    {tap && <div className="fixed inset-0 z-40" onClick={e => { e.stopPropagation(); close(); }} />}
                    <div
                        role="tooltip"
                        style={{ top: pos.top, left: pos.left }}
                        className="fixed z-50 w-max max-w-[280px] max-h-[60vh] overflow-y-auto whitespace-pre-line pointer-events-none bg-slate-800 text-slate-100 text-xs leading-snug rounded-md shadow-xl px-2.5 py-1.5"
                    >
                        {content}
                    </div>
                </>
            )}
        </span>
    );
}
