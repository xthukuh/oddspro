import { useEffect, useLayoutEffect, useRef, useState } from 'react';

// Collapsible reorder dropdown — the shared control for provider priority,
// column order and sort priority (it replaced the always-visible drag lists to
// free space and keep one reordering idiom). Each row shows a priority number,
// an optional enable checkbox, the label, an optional inline tag (e.g. a sort
// direction arrow), ↑/↓ priority arrows, and an optional × remove. Like
// MultiSelect the panel is position:fixed anchored to the trigger, so no
// ancestor's overflow (the settings sheet) can clip it.
//   items   : [{ key, label, enabled? }]  (array order = priority, index 0 = top)
//   badge   : trigger count text (defaults to items.length)
//   onMove(key, dir)   required — dir is -1 (up) / +1 (down)
//   onToggle(key)      optional — renders the checkbox (item.enabled = checked)
//   onRemove(key)      optional — renders the × on each row
//   renderTag(item)    optional — inline node shown before the arrows
//   hint    : optional panel-header text
//   footer  : optional node pinned under the rows (e.g. a Reset button)
export default function ReorderList({ label, items, badge, onMove, onToggle, onRemove, renderTag, hint, footer, title }) {
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
            left: Math.max(8, Math.min(r.left, window.innerWidth - 288)),
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

    const arrowCls = 'cursor-pointer shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-lg text-label-2 leading-none hover:bg-fill hover:text-label disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent';

    return (
        <div className="relative inline-block" ref={ref}>
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen(v => !v)}
                title={title}
                className="cursor-pointer flex items-center gap-2 px-3 min-h-11 py-2 rounded-[10px] border border-separator bg-surface text-label text-sm hover:bg-fill"
            >
                <span>{label}</span>
                <span className="text-accent tabular-nums">{badge ?? items.length}</span>
                <span className={`text-label-3 text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {open && pos && (
                <div
                    style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
                    className="z-[70] w-72 overflow-y-auto bg-surface text-label border border-separator-2 rounded-xl shadow-2xl p-2"
                >
                    {hint && (
                        <p className="text-xs text-label-3 px-1 pb-2 mb-1 border-b border-hairline sticky top-0 bg-surface">{hint}</p>
                    )}
                    {items.map((it, i) => (
                        <div key={it.key} className="flex items-center gap-2 px-1.5 py-1.5 rounded-lg hover:bg-fill">
                            {onToggle && (
                                <input
                                    type="checkbox"
                                    checked={!!it.enabled}
                                    onChange={() => onToggle(it.key)}
                                    title={it.enabled ? 'Shown — untick to hide' : 'Hidden — tick to show'}
                                    className="accent-accent h-4 w-4"
                                />
                            )}
                            <span className="text-label-3 text-xs tabular-nums w-4 text-center" title="Priority">{i + 1}</span>
                            <span className="grow text-sm truncate" title={typeof it.label === 'string' ? it.label : undefined}>{it.label}</span>
                            {renderTag?.(it)}
                            <button
                                type="button" disabled={i === 0} onClick={() => onMove(it.key, -1)}
                                title="Move up" aria-label="Move up" className={arrowCls}
                            >↑</button>
                            <button
                                type="button" disabled={i === items.length - 1} onClick={() => onMove(it.key, 1)}
                                title="Move down" aria-label="Move down" className={arrowCls}
                            >↓</button>
                            {onRemove && (
                                <button
                                    type="button" onClick={() => onRemove(it.key)}
                                    title="Remove" aria-label="Remove" className={`${arrowCls} w-7 hover:text-miss`}
                                >&times;</button>
                            )}
                        </div>
                    ))}
                    {!items.length && (
                        <span className="block text-sm text-label-3 px-1 py-1">Nothing here yet.</span>
                    )}
                    {footer && <div className="pt-1 mt-1 border-t border-hairline px-1">{footer}</div>}
                </div>
            )}
        </div>
    );
}
