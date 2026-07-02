// Settings dialog: multi-select the odds market columns and STATS columns
// shown in the datatable (defaults pre-selected per README).

function ColumnPicker({ title, options, selected, onChange }) {
    const set = new Set(selected);
    const toggle = key => {
        const next = new Set(set);
        next.has(key) ? next.delete(key) : next.add(key);
        // preserve catalog order in the persisted selection
        onChange(options.filter(o => next.has(o.key)).map(o => o.key));
    };
    return (
        <section className="mb-5">
            <div className="flex items-center gap-3 mb-2">
                <h3 className="font-medium text-slate-700">{title}</h3>
                <div className="grow" />
                {[
                    ['Defaults', () => onChange(options.filter(o => o.default).map(o => o.key))],
                    ['All', () => onChange(options.map(o => o.key))],
                    ['None', () => onChange([])],
                ].map(([label, fn]) => (
                    <button key={label} onClick={fn} className="text-xs text-sky-700 hover:underline">
                        {label}
                    </button>
                ))}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1">
                {options.map(o => (
                    <label key={o.key} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                            type="checkbox"
                            checked={set.has(o.key)}
                            onChange={() => toggle(o.key)}
                            className="accent-sky-600"
                        />
                        <span>{o.label}</span>
                    </label>
                ))}
                {!options.length && <span className="text-sm text-slate-400 col-span-full">Nothing available yet.</span>}
            </div>
        </section>
    );
}

export default function SettingsModal({ catalog, marketKeys, statKeys, onMarkets, onStats, onClose }) {
    return (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
            <div
                className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center mb-4">
                    <h2 className="text-lg font-semibold">Display settings</h2>
                    <div className="grow" />
                    <button onClick={onClose} className="text-slate-500 hover:text-slate-800 text-xl leading-none">&times;</button>
                </div>
                <ColumnPicker
                    title="Odds market columns"
                    options={catalog.markets}
                    selected={marketKeys}
                    onChange={onMarkets}
                />
                <ColumnPicker
                    title="Stats columns"
                    options={catalog.stats}
                    selected={statKeys}
                    onChange={onStats}
                />
                <div className="text-right">
                    <button onClick={onClose} className="px-4 py-1.5 rounded bg-slate-800 text-white text-sm hover:bg-slate-700">
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}
