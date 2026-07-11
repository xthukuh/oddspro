import { useRef, useState } from 'react';
import useAnchoredPanel from '../useAnchoredPanel.js';
import { Z } from '../zLayers.js';

// Compact multi-select dropdown: a summary button opening a checkbox panel
// with Defaults/All/None shortcuts. The panel is rendered with position:fixed
// anchored to the trigger, so it is NEVER clipped by an ancestor's overflow
// (settings modal, filter sheet) - it flips above when there isn't room below.
// Anchoring / outside-click / Escape / reposition come from the shared
// useAnchoredPanel hook (also used by ReorderList).
//
// `availableKeys` (optional Set): restrict the visible checkbox list to option
// keys that carry data on the loaded day (date-dynamic selectors). Toggling
// still emits over the FULL option set, so a currently-selected column with no
// data today is preserved and re-appears when its data returns; only "None"
// clears everything.
export default function MultiSelect({ label, options, selected, onChange, availableKeys = null, title }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);   // wrapper (trigger + panel) for outside-click test
    const btnRef = useRef(null);
    const pos = useAnchoredPanel({ open, onClose: () => setOpen(false), wrapRef: ref, btnRef, rightGutter: 264 });

    const set = new Set(selected);
    const shown = availableKeys ? options.filter(o => availableKeys.has(o.key)) : options;
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
    // Count reflects the day when dynamic (selected-with-data / with-data).
    const shownSelected = shown.filter(o => set.has(o.key)).length;
    const count = availableKeys ? `${shownSelected}/${shown.length}` : `${selected.length}/${options.length}`;

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
                <span className="text-accent tabular-nums">{count}</span>
                <span className={`text-label-3 text-xs transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
            </button>
            {open && pos && (
                <div
                    style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
                    className={`${Z.dropdown} w-64 overflow-y-auto bg-surface text-label border border-separator-2 rounded-xl shadow-2xl p-2`}
                >
                    <div className="flex gap-4 px-1 pb-2 mb-1 border-b border-hairline sticky top-0 bg-surface">
                        {actions.map(([name, fn]) => (
                            <button key={name} type="button" onClick={fn} className="text-xs text-accent hover:opacity-70 py-1">
                                {name}
                            </button>
                        ))}
                    </div>
                    {shown.map(o => (
                        <label
                            key={o.key}
                            className="flex items-center gap-2.5 text-sm cursor-pointer px-1.5 py-2 rounded-lg hover:bg-fill"
                        >
                            <input
                                type="checkbox"
                                checked={set.has(o.key)}
                                onChange={() => toggle(o.key)}
                                className="accent-accent h-4 w-4"
                            />
                            <span>{o.label}</span>
                        </label>
                    ))}
                    {!shown.length && (
                        <span className="block text-sm text-label-3 px-1 py-1">
                            {options.length ? 'No columns with data for this day.' : 'Nothing available yet.'}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}
