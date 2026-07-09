import { useEffect, useRef, useState } from 'react';

// Compact multi-select dropdown: a summary button opening a checkbox panel
// with Defaults/All/None shortcuts. Replaces the settings modal's sprawling
// checkbox grids while keeping the plain-checkbox interaction inside.

export default function MultiSelect({ label, options, selected, onChange }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);

    // Close on any press outside the control
    useEffect(() => {
        if (!open) return;
        const close = e => {
            if (!ref.current?.contains(e.target)) setOpen(false);
        };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [open]);

    const set = new Set(selected);
    const toggle = key => {
        const next = new Set(set);
        next.has(key) ? next.delete(key) : next.add(key);
        // preserve catalog order in the persisted selection
        onChange(options.filter(o => next.has(o.key)).map(o => o.key));
    };
    const actions = [
        ...(options.some(o => o.default)
            ? [['Defaults', () => onChange(options.filter(o => o.default).map(o => o.key))]]
            : []),
        ['All', () => onChange(options.map(o => o.key))],
        ['None', () => onChange([])],
    ];

    return (
        <div className="relative inline-block" ref={ref}>
            <button
                type="button"
                onClick={() => setOpen(v => !v)}
                className="cursor-pointer flex items-center gap-2 px-3 py-1.5 rounded-[10px] border border-separator bg-surface text-label text-sm hover:bg-fill"
            >
                <span>{label}</span>
                <span className="text-accent tabular-nums">{selected.length}/{options.length}</span>
                <span className={`text-label-3 text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {open && (
                <div className="absolute z-30 mt-1 w-64 max-h-72 overflow-y-auto bg-surface text-label border border-separator-2 rounded-xl shadow-2xl p-2">
                    <div className="flex gap-3 px-1 pb-2 mb-1 border-b border-hairline">
                        {actions.map(([name, fn]) => (
                            <button key={name} type="button" onClick={fn} className="text-xs text-accent hover:underline">
                                {name}
                            </button>
                        ))}
                    </div>
                    {options.map(o => (
                        <label
                            key={o.key}
                            className="flex items-center gap-2 text-sm cursor-pointer px-1 py-0.5 rounded hover:bg-fill"
                        >
                            <input
                                type="checkbox"
                                checked={set.has(o.key)}
                                onChange={() => toggle(o.key)}
                                className="accent-accent"
                            />
                            <span>{o.label}</span>
                        </label>
                    ))}
                    {!options.length && <span className="block text-sm text-label-3 px-1 py-1">Nothing available yet.</span>}
                </div>
            )}
        </div>
    );
}
