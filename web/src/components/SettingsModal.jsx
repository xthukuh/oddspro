import { useState } from 'react';
import MultiSelect from './MultiSelect.jsx';
import { BASE_COLUMNS, applyOrder } from './DataTable.jsx';

// Settings dialog, organized into three compact sections:
//   Table columns - market/stats multi-select dropdowns + drag-to-reorder;
//   Providers     - visible bookmakers + unavailable-link exceptions;
//   Behavior      - completed-games visibility.

// Drag-to-reorder pills for the currently visible columns. Plain HTML5 drag
// and drop - dropping a pill inserts it before the pill it lands on.
function ColumnOrder({ columns, onOrder }) {
    const [drag, setDrag] = useState(null);
    const dropAt = key => {
        if (!drag || drag === key) return;
        const keys = columns.map(c => c.key).filter(k => k !== drag);
        keys.splice(keys.indexOf(key), 0, drag);
        onOrder(keys);
    };
    return (
        <div className="flex flex-wrap gap-1.5">
            {columns.map(c => (
                <span
                    key={c.key}
                    draggable
                    onDragStart={() => setDrag(c.key)}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); dropAt(c.key); }}
                    className={`cursor-grab select-none px-2 py-0.5 rounded border text-xs bg-white
                        ${drag === c.key ? 'opacity-40 border-sky-400' : 'border-slate-300 hover:border-slate-400'}`}
                    title="Drag to reposition this column"
                >
                    <span className="text-slate-400 mr-1">⠿</span>
                    {c.label}
                </span>
            ))}
        </div>
    );
}

// Vertical drag-to-reorder list of the active sort chain (column sorts + magic
// strategies) in priority order - same HTML5 DnD idiom as ColumnOrder, keyed
// on a stable per-entry id. x removes an entry.
function SortOrder({ chain, entryLabel, onReorder, onRemove }) {
    const [drag, setDrag] = useState(null); // dragged entry key
    const keyOf = e => (e.type === 'magic' ? `magic:${e.id}` : `col:${e.key}`);
    const dropAt = k => {
        if (!drag || drag === k) return;
        const rest = chain.filter(e => keyOf(e) !== drag);
        const dragged = chain.find(e => keyOf(e) === drag);
        rest.splice(rest.findIndex(e => keyOf(e) === k), 0, dragged);
        onReorder(rest);
    };
    return (
        <div className="flex flex-col gap-1">
            {chain.map((e, i) => (
                <div
                    key={keyOf(e)}
                    draggable
                    onDragStart={() => setDrag(keyOf(e))}
                    onDragEnd={() => setDrag(null)}
                    onDragOver={ev => ev.preventDefault()}
                    onDrop={ev => { ev.preventDefault(); dropAt(keyOf(e)); }}
                    className={`flex items-center gap-2 px-2 py-1 rounded border text-xs bg-white
                        ${drag === keyOf(e) ? 'opacity-40 border-sky-400' : 'border-slate-300'}`}
                    title="Drag to change sort priority"
                >
                    <span className="text-slate-400 cursor-grab">⠿</span>
                    <span className="text-slate-400 tabular-nums">{i + 1}</span>
                    <span className="grow">{entryLabel(e)}</span>
                    {e.type === 'column' && <span className="text-sky-600">{e.dir === 'asc' ? '▲' : '▼'}</span>}
                    <button
                        onClick={() => onRemove(e)}
                        className="cursor-pointer text-slate-400 hover:text-red-600 leading-none"
                        title="Remove this sort"
                    >
                        &times;
                    </button>
                </div>
            ))}
        </div>
    );
}

export default function SettingsModal({
    catalog, marketKeys, statKeys, columnOrder, providers, visibleProviders, linkProviders, showCompleted,
    sortChain, entryLabel, onReorderSort, onRemoveSort,
    onMarkets, onStats, onOrder, onVisibleProviders, onLinkProviders, onShowCompleted, onClose,
}) {
    const statLabel = new Map(catalog.stats.map(c => [c.key, c.label]));
    const orderedColumns = applyOrder([
        ...BASE_COLUMNS,
        ...marketKeys.map(key => ({ key, label: key })),
        ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key })),
    ], columnOrder);
    const providerOptions = providers.map(p => ({ key: p, label: p, default: true }));

    return (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-2 md:p-4" onClick={onClose}>
            <div
                className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] md:max-h-[85vh] overflow-y-auto p-4 md:p-5"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center mb-4">
                    <h2 className="text-lg font-semibold">Display settings</h2>
                    <div className="grow" />
                    <button onClick={onClose} className="text-slate-500 hover:text-slate-800 text-xl leading-none">&times;</button>
                </div>

                <section className="mb-5">
                    <h3 className="font-medium text-slate-700 mb-2">Table columns</h3>
                    <div className="flex flex-wrap gap-2 mb-3">
                        <MultiSelect
                            label="Odds markets"
                            options={catalog.markets}
                            selected={marketKeys}
                            onChange={onMarkets}
                        />
                        <MultiSelect
                            label="Stats"
                            options={catalog.stats}
                            selected={statKeys}
                            onChange={onStats}
                        />
                    </div>
                    <div className="flex items-center gap-3 mb-2">
                        <h4 className="text-sm text-slate-600">Column order</h4>
                        <div className="grow" />
                        <button onClick={() => onOrder(null)} className="text-xs text-sky-700 hover:underline">
                            Reset order
                        </button>
                    </div>
                    <ColumnOrder columns={orderedColumns} onOrder={onOrder} />
                </section>

                <section className="mb-5">
                    <h3 className="font-medium text-slate-700 mb-2">Providers</h3>
                    <div className="flex flex-wrap gap-2 mb-2">
                        <MultiSelect
                            label="Visible providers"
                            options={providerOptions}
                            selected={visibleProviders}
                            onChange={onVisibleProviders}
                        />
                        <MultiSelect
                            label="Unavailable match links"
                            options={providers.map(p => ({ key: p, label: p }))}
                            selected={linkProviders}
                            onChange={onLinkProviders}
                        />
                    </div>
                    <p className="text-xs text-slate-500">
                        Visible providers filter the table rows. Unavailable matches (concluded, or no
                        markets left) are unlinked by default - enable a provider to keep its links
                        anyway (betpawa serves concluded match pages for ~6h).
                    </p>
                </section>

                <section className="mb-5">
                    <h3 className="font-medium text-slate-700 mb-2">Behavior</h3>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                            type="checkbox"
                            checked={showCompleted}
                            onChange={e => onShowCompleted(e.target.checked)}
                            className="accent-sky-600"
                        />
                        <span>Show completed games</span>
                    </label>
                    <p className="text-xs text-slate-500 mt-1">Untick to see upcoming matches only.</p>
                </section>

                {sortChain?.length > 0 && (
                    <section className="mb-5">
                        <div className="flex items-center gap-3 mb-2">
                            <h3 className="font-medium text-slate-700">Sort priority</h3>
                            <div className="grow" />
                            <span className="text-xs text-slate-400">drag to reorder · top wins</span>
                        </div>
                        <SortOrder
                            chain={sortChain}
                            entryLabel={entryLabel}
                            onReorder={onReorderSort}
                            onRemove={onRemoveSort}
                        />
                    </section>
                )}

                <div className="text-right">
                    <button onClick={onClose} className="px-4 py-1.5 rounded bg-slate-800 text-white text-sm hover:bg-slate-700">
                        Done
                    </button>
                </div>
            </div>
        </div>
    );
}
