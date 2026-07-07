import { useEffect, useRef, useState } from 'react';

// Header "✨ Magic" dropdown: pick one of the backtest-ranked tip-sorting
// strategies (GET /api/magic-sort) to reorder the table most-likely-to-win
// first, or Reset back to the normal order. Popover idiom mirrors
// MultiSelect (outside-press close); stats shown are BACKTESTS over settled
// tips, not forecasts - labeled as such.

const _pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`);
const _roi = v => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);

export default function MagicMenu({ data, error, activeIds, onToggle, onClearMagic }) {
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

    const strategies = data?.strategies ?? [];
    const sample = data?.sample;
    const active = new Set(activeIds ?? []);

    return (
        <div className="relative inline-block" ref={ref}>
            <button
                onClick={() => setOpen(v => !v)}
                title="Sort tips most-likely-to-win first (backtested ranking strategies) - toggle one or more"
                className={`cursor-pointer px-3 py-1 rounded border text-sm ${active.size
                    ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
            >
                ✨ Magic{active.size > 1 ? ` (${active.size})` : ''}
            </button>
            {open && (
                <div className="absolute right-0 z-40 mt-1 w-80 bg-white text-slate-800 border border-slate-200 rounded-lg shadow-xl p-2">
                    <div className="px-1 pb-2 mb-1 border-b border-slate-100 text-xs text-slate-500">
                        Tip rankings replayed against every settled day: build the
                        top-4 slip each strategy would have picked, settle it at
                        real prices. Backtests, not forecasts.
                    </div>
                    {error && <div className="px-1 py-1 text-sm text-red-600">{error}</div>}
                    {!error && !data && <div className="px-1 py-1 text-sm text-slate-400">Loading…</div>}
                    {strategies.map(s => (
                        <button
                            key={s.id}
                            onClick={() => onToggle(s.id)}
                            className={`cursor-pointer block w-full text-left px-2 py-1.5 rounded hover:bg-slate-50 ${
                                active.has(s.id) ? 'bg-sky-50' : ''}`}
                        >
                            <span className="flex items-center text-sm">
                                <span className="font-medium">{s.label}</span>
                                {s.low_sample && (
                                    <span
                                        className="ml-2 text-xs text-amber-600"
                                        title={`Fewer than ${sample?.min_days ?? 5} replayable days - treat with caution`}
                                    >
                                        ⚠ small sample
                                    </span>
                                )}
                                {active.has(s.id) && <span className="ml-auto text-sky-600">✓</span>}
                            </span>
                            <span className="block text-xs text-slate-500 tabular-nums">
                                slips {s.stats.survived}/{s.stats.days} ({_pct(s.stats.survival)})
                                {' · '}top picks {s.stats.quartile.hits}/{s.stats.quartile.n} ({_pct(s.stats.quartile.rate)})
                                {' · '}ROI {_roi(s.stats.roi)}
                            </span>
                        </button>
                    ))}
                    {data && !strategies.length && (
                        <div className="px-1 py-1 text-sm text-slate-400">No settled tips to rank yet.</div>
                    )}
                    <button
                        onClick={() => { onClearMagic(); setOpen(false); }}
                        disabled={!active.size}
                        className="cursor-pointer block w-full text-left px-2 py-1.5 mt-1 border-t border-slate-100 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-default"
                    >
                        Clear magic sorts
                    </button>
                    {sample && (
                        <div className="px-1 pt-1 text-xs text-slate-400">
                            {sample.settled} settled tips · {sample.days} day{sample.days === 1 ? '' : 's'}
                            {!sample.sufficient && (
                                <span className="block text-amber-600">
                                    ⚠ Under {sample.min_days} replayable days - rankings firm up as results accrue.
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
