import { useRef, useState } from 'react';
import useAnchoredPanel from '../useAnchoredPanel.js';
import { Z } from '../zLayers.js';

// Bulk-actions dropdown living in the Select-column header (R29). Replaces the
// old select-all checkbox: the trigger still INDICATES selection state (a
// tri-state glyph + a sel/total badge) and opens a menu of with-selected
// actions (moved here from Settings). Anchoring / outside-click / Escape /
// reposition come from the shared useAnchoredPanel hook (position:fixed, so the
// panel is never clipped by the sticky header and tracks table scroll) - same
// idiom as MultiSelect. Auto-dismiss on select (Phase J).
//
// Select All / Invert act on the VISIBLE rows (the caller passes visible-row
// handlers); Select Similar / Keep One Provider reach the whole loaded day.
function MenuItem({ label, onClick, disabled = false, active = false }) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            role="menuitem"
            className="w-full flex items-center gap-2 text-left text-sm px-2 py-2 rounded-lg hover:bg-fill disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent cursor-pointer"
        >
            <span aria-hidden="true" className={`w-3.5 text-center text-accent ${active ? '' : 'opacity-0'}`}>✓</span>
            <span>{label}</span>
        </button>
    );
}

export default function BulkActionsMenu({
    allSelected = false, someSelected = false, selCount = 0, shownCount = 0,
    selectionCount = 0, hideSelected = false, hideUnselected = false, prioritizeSelected = false,
    onSelectAll, onDeselectAll, onInvert, onSelectSimilar, onKeepOneProvider,
    onToggleHideSelected, onToggleHideUnselected, onTogglePrioritize, onExportCsv,
}) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);   // wrapper (trigger + panel) for outside-click test
    const btnRef = useRef(null);
    const pos = useAnchoredPanel({ open, onClose: () => setOpen(false), wrapRef: ref, btnRef, rightGutter: 240 });

    // Run an action, then close the menu (auto-dismiss on select).
    const run = fn => () => { fn?.(); setOpen(false); };
    const hasSel = selectionCount > 0;

    // Tri-state indicator glyph: filled ✓ (all shown selected), filled – (some),
    // empty box (none) - mirrors the checkbox the menu replaced.
    const glyph = allSelected
        ? <span className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-accent text-white text-[10px] leading-none">✓</span>
        : someSelected
            ? <span className="flex h-4 w-4 items-center justify-center rounded-[3px] bg-accent text-white text-[11px] leading-none">–</span>
            : <span className="block h-4 w-4 rounded-[3px] border border-label-3" />;

    return (
        <div className="relative inline-block" ref={ref}>
            <button
                ref={btnRef}
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Bulk selection actions"
                title="Bulk selection actions"
                onClick={() => setOpen(v => !v)}
                className="cursor-pointer flex flex-col items-center gap-0.5 mx-auto hover:opacity-80"
            >
                <span className="flex items-center gap-0.5">
                    {glyph}
                    <span className={`text-label-3 text-[9px] leading-none transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
                </span>
                {selCount > 0 && (
                    <span className="text-accent text-[9px] font-semibold tabular-nums leading-none">
                        {selCount === shownCount ? shownCount : `${selCount}/${shownCount}`}
                    </span>
                )}
            </button>
            {open && pos && (
                <div
                    role="menu"
                    style={{ position: 'fixed', left: pos.left, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxH }}
                    className={`${Z.dropdown} w-56 overflow-y-auto bg-surface text-label border border-separator-2 rounded-xl shadow-2xl p-1 text-left font-normal`}
                >
                    <MenuItem label="Select All" onClick={run(onSelectAll)} />
                    <MenuItem label="Deselect All" onClick={run(onDeselectAll)} disabled={!hasSel} />
                    <MenuItem label="Invert Selection" onClick={run(onInvert)} />
                    <MenuItem label={hideSelected ? 'Show Selected' : 'Hide Selected'} onClick={run(onToggleHideSelected)} active={hideSelected} />
                    <MenuItem label={hideUnselected ? 'Show Unselected' : 'Hide Unselected'} onClick={run(onToggleHideUnselected)} active={hideUnselected} />
                    <MenuItem label="Select Similar" onClick={run(onSelectSimilar)} disabled={!hasSel} />
                    <MenuItem label={prioritizeSelected ? 'Deprioritize Selected' : 'Prioritize Selected'} onClick={run(onTogglePrioritize)} active={prioritizeSelected} />
                    <MenuItem label="Keep One Provider" onClick={run(onKeepOneProvider)} disabled={!hasSel} />
                    {hasSel && (
                        <>
                            <div className="my-1 border-t border-hairline" />
                            <MenuItem label={`Export CSV (${selectionCount})`} onClick={run(onExportCsv)} />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
