import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Provider priority control: a dropdown listing every bookmaker with an enable
// checkbox and up/down arrows to set its priority (row 1 = highest). The order
// feeds the "One of each" view - which provider represents a game when several
// carry it. Like MultiSelect, the panel is position:fixed anchored to the
// trigger, so no ancestor's overflow (settings sheet) can clip it.
//
// `items` is the ordered list [{ key, label, enabled }] (index 0 = top).
export default function ProviderPriority({ label, items, onToggle, onMove }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState(null);
    const ref = useRef(null);   // wrapper (trigger + panel) for outside-click test
    const btnRef = useRef(null);

    const place = () => {
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const below = window.innerHeight - r.bottom;
        const flipUp = below < 280 && r.top > below;
        setPos({
            left: Math.max(8, Math.min(r.left, window.innerWidth - 264)),
            top: flipUp ? undefined : Math.round(r.bottom + 4),
            bottom: flipUp ? Math.round(window.innerHeight - r.top + 4) : undefined,
            maxH: Math.max(160, Math.round((flipUp ? r.top : below) - 16)),
        });
    };

    useLayoutEffect(() => { if (open) place(); }, [open]);
    useEffect(() => {
        if (!open) return;
        const onDown = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
        const reposition = () => place();
        document.addEventListener('pointerdown', onDown);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [open]);

    const enabled = items.filter(i => i.enabled).length;
    const arrowCls = 'cursor-pointer shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-label-2 leading-none hover:bg-fill hover:text-label disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent';

    return (
        <div className="relative inline-block" ref={ref}>
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen(v => !v)}
                title="Enable bookmakers and set their priority — the top enabled provider represents each game under 'One of each'"
                className="cursor-pointer flex items-center gap-2 px-3 min-h-11 py-2 rounded-[10px] border border-separator bg-surface text-label text-sm hover:bg-fill"
            >
                <span>{label}</span>
                <span className="text-accent tabular-nums">{enabled}/{items.length}</span>
                <span className={`text-label-3 text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {open && pos && (
                <div
                    style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
                    className="z-[70] w-64 overflow-y-auto bg-surface text-label border border-separator-2 rounded-xl shadow-2xl p-2"
                >
                    <p className="text-xs text-label-3 px-1 pb-2 mb-1 border-b border-hairline sticky top-0 bg-surface">
                        Priority top→bottom. Untick to hide a bookmaker.
                    </p>
                    {items.map((it, i) => (
                        <div key={it.key} className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-fill">
                            <input
                                type="checkbox"
                                checked={it.enabled}
                                onChange={() => onToggle(it.key)}
                                title={it.enabled ? 'Enabled — shown in the table' : 'Disabled — hidden from the table'}
                                className="accent-accent h-4 w-4"
                            />
                            <span className="text-label-3 text-xs tabular-nums w-4 text-center" title="Priority">{i + 1}</span>
                            <span className="grow text-sm truncate" title={it.label}>{it.label}</span>
                            <button
                                type="button" disabled={i === 0} onClick={() => onMove(it.key, -1)}
                                title="Move up (higher priority)" aria-label={`Move ${it.label} up`} className={arrowCls}
                            >↑</button>
                            <button
                                type="button" disabled={i === items.length - 1} onClick={() => onMove(it.key, 1)}
                                title="Move down (lower priority)" aria-label={`Move ${it.label} down`} className={arrowCls}
                            >↓</button>
                        </div>
                    ))}
                    {!items.length && (
                        <span className="block text-sm text-label-3 px-1 py-1">No bookmakers yet.</span>
                    )}
                </div>
            )}
        </div>
    );
}
