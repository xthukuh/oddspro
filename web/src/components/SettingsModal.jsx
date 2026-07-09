import { useState } from 'react';
import MultiSelect from './MultiSelect.jsx';
import Sheet, { SheetClose } from './Sheet.jsx';
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
                    className={`cursor-grab select-none px-2 py-0.5 rounded border text-xs bg-surface
                        ${drag === c.key ? 'opacity-40 border-accent' : 'border-separator hover:border-label-3'}`}
                    title="Drag to reposition this column"
                >
                    <span className="text-label-3 mr-1">⠿</span>
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
                    className={`flex items-center gap-2 px-2 py-1 rounded border text-xs bg-surface
                        ${drag === keyOf(e) ? 'opacity-40 border-accent' : 'border-separator'}`}
                    title="Drag to change sort priority"
                >
                    <span className="text-label-3 cursor-grab">⠿</span>
                    <span className="text-label-3 tabular-nums">{i + 1}</span>
                    <span className="grow">{entryLabel(e)}</span>
                    {e.type === 'column' && <span className="text-accent">{e.dir === 'asc' ? '▲' : '▼'}</span>}
                    <button
                        onClick={() => onRemove(e)}
                        className="cursor-pointer text-label-3 hover:text-miss leading-none"
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
    hideHits, hideMiss, noMiss, safeOnly, safeMaxPerDay = 3,
    sortChain, entryLabel, onReorderSort, onRemoveSort,
    onMarkets, onStats, onOrder, onVisibleProviders, onLinkProviders, onShowCompleted,
    onHideHits, onHideMiss, onNoMiss, onSafeOnly, onClose,
}) {
    const statLabel = new Map(catalog.stats.map(c => [c.key, c.label]));
    const orderedColumns = applyOrder([
        ...BASE_COLUMNS,
        ...marketKeys.map(key => ({ key, label: key })),
        ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key })),
    ], columnOrder);
    const providerOptions = providers.map(p => ({ key: p, label: p, default: true }));

    return (
        <Sheet onClose={onClose} className="max-w-2xl">
            <div className="flex flex-col max-h-[92vh]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                    <h2 className="text-[22px] font-extrabold tracking-tight">Display settings</h2>
                    <div className="flex-1" />
                    <SheetClose onClose={onClose} />
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-3">

                <section className="mb-5">
                    <h3 className="font-medium text-label mb-2">Table columns</h3>
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
                        <h4 className="text-sm text-label-2">Column order</h4>
                        <div className="grow" />
                        <button onClick={() => onOrder(null)} className="text-xs text-accent hover:underline">
                            Reset order
                        </button>
                    </div>
                    <ColumnOrder columns={orderedColumns} onOrder={onOrder} />
                </section>

                <section className="mb-5">
                    <h3 className="font-medium text-label mb-2">Providers</h3>
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
                    <p className="text-xs text-label-2">
                        Visible providers filter the table rows. Unavailable matches (concluded, or no
                        markets left) are unlinked by default - enable a provider to keep its links
                        anyway (betpawa serves concluded match pages for ~6h).
                    </p>
                </section>

                <section className="mb-5">
                    <h3 className="font-medium text-label mb-2">Behavior</h3>
                    <label className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                            type="checkbox"
                            checked={showCompleted}
                            onChange={e => onShowCompleted(e.target.checked)}
                            className="accent-accent"
                        />
                        <span>Show completed games</span>
                    </label>
                    <p className="text-xs text-label-2 mt-1">Untick to see upcoming matches only.</p>

                    <h4 className="text-sm text-label-2 mt-3 mb-1">Settled tips</h4>
                    <div className="flex flex-col gap-1.5">
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={hideHits}
                                onChange={e => onHideHits(e.target.checked)}
                                className="accent-accent"
                            />
                            <span>Hide hits <span className="text-label-3">— show only losing &amp; upcoming tips</span></span>
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={hideMiss}
                                onChange={e => onHideMiss(e.target.checked)}
                                className="accent-accent"
                            />
                            <span>Hide miss <span className="text-label-3">— show only winning &amp; upcoming tips</span></span>
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={noMiss}
                                onChange={e => onNoMiss(e.target.checked)}
                                className="accent-accent"
                            />
                            <span>No miss <span className="text-label-3">— hide every pick from a market that lost anywhere today (keeps clean markets' wins + upcoming)</span></span>
                        </label>
                        <label className="flex items-center gap-2 text-sm cursor-pointer">
                            <input
                                type="checkbox"
                                checked={safeOnly}
                                onChange={e => onSafeOnly(e.target.checked)}
                                className="accent-accent"
                            />
                            <span>🛡 Safe only <span className="text-label-3">— only the day's safest slip legs: signals in agreement (none weak), short odds, best {safeMaxPerDay} per day. Zero games on a day means no safe bet exists — that's the protocol working</span></span>
                        </label>
                    </div>
                    <p className="text-xs text-label-2 mt-1">
                        Ticking both Hide hits and Hide miss shows upcoming/ongoing games only. These
                        read best with Show completed on.
                    </p>
                </section>

                {sortChain?.length > 0 && (
                    <section className="mb-5">
                        <div className="flex items-center gap-3 mb-2">
                            <h3 className="font-medium text-label">Sort priority</h3>
                            <div className="grow" />
                            <span className="text-xs text-label-3">drag to reorder · top wins</span>
                        </div>
                        <SortOrder
                            chain={sortChain}
                            entryLabel={entryLabel}
                            onReorder={onReorderSort}
                            onRemove={onRemoveSort}
                        />
                    </section>
                )}

                </div>
                <div className="flex justify-end px-6 py-3 border-t border-separator-2">
                    <button onClick={onClose} className="cursor-pointer h-10 px-6 rounded-full bg-accent text-white text-sm font-semibold hover:opacity-90">
                        Done
                    </button>
                </div>
            </div>
        </Sheet>
    );
}
