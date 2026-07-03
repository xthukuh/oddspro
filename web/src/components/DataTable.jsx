// Paginated multi-sort datatable: fixed base columns + selected market and
// STATS columns. Click a header to sort (shift-click chains multi-sort).

const PROVIDER_STYLE = {
    betpawa: 'bg-emerald-100 text-emerald-800',
    betika: 'bg-sky-100 text-sky-800',
};

// Base columns are always shown (README temp-csv order); match_url folds
// into the fixture cell as an outbound link. Exported for the settings
// modal's column-order control.
export const BASE_COLUMNS = [
    { key: 'api_id', label: 'API ID' },
    { key: 'start_time', label: 'Start' },
    { key: 'fixture', label: 'Fixture' },
    { key: 'provider', label: 'Provider' },
    { key: 'score', label: 'Score' },
    { key: 'goals', label: 'Goals' },
    { key: 'tip', label: 'Tip' },
    { key: 'status', label: 'Status' },
];

// Soft row tints cycled by canonical fixture (api_id) in first-appearance
// order: the same fixture shown once per provider shares a tint, adjacent
// fixtures always differ. Full literal class names (Tailwind purge).
const ROW_TINTS = [
    'bg-rose-50', 'bg-orange-50', 'bg-amber-50', 'bg-lime-50', 'bg-emerald-50',
    'bg-cyan-50', 'bg-sky-50', 'bg-violet-50', 'bg-fuchsia-50',
];

// Rearrange columns by the persisted key order (settings drag control):
// ordered keys first, anything new/unknown keeps its natural position after.
export function applyOrder(columns, order) {
    if (!Array.isArray(order) || !order.length) return columns;
    const byKey = new Map(columns.map(c => [c.key, c]));
    const ordered = order.map(k => byKey.get(k)).filter(Boolean);
    const placed = new Set(ordered.map(c => c.key));
    return [...ordered, ...columns.filter(c => !placed.has(c.key))];
}

function _time(value) {
    const d = new Date(value);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Over 2.5 hot-pick badge: 🔥 while pending, 🔥✓/🔥✗ once settled. The
// tooltip carries the AI reason (when adjudicated) or the signal audit.
function _hotBadge(row) {
    // Non-hot rows are also settled in the ledger (calibration); only actual
    // picks earn the badge - a frozen pick keeps hot=1 forever.
    if (!row.hot) return null;
    const detail = row.hot_reason
        ?? (Array.isArray(row.hot_signals)
            ? row.hot_signals.map(s => `${s.key}: ${s.value ?? '-'}`).join(' · ')
            : '');
    const title = `Over 2.5 hot pick${row.hot_score != null ? ` (score ${row.hot_score})` : ''}${detail ? ` - ${detail}` : ''}`;
    return (
        <span className="mr-1 cursor-help" title={title}>
            🔥
            {row.hot_outcome === 'hit' && <span className="text-emerald-600 font-bold">✓</span>}
            {row.hot_outcome === 'miss' && <span className="text-rose-600 font-bold">✗</span>}
        </span>
    );
}

function _cell(row, key, linkProviders) {
    if (key === 'start_time') return _time(row.start_time);
    if (key === 'tip') {
        // Safest bettable outcome + blended confidence; 🔥 marks the fixture
        // as an over-2.5 hot pick; ✓/✗ appear once the tip settles.
        if (!row.tip_market) return <span className="text-slate-300">-</span>;
        const pct = row.tip_confidence != null ? `${Math.round(row.tip_confidence * 100)}%` : null;
        const title = `Safest pick: ${row.tip_market}${row.tip_price != null ? ` @ ${row.tip_price.toFixed(2)}` : ''}`
            + ` - market+stats confidence${pct ? ` ${pct}` : ''}`
            + (row.hot ? ' - 🔥 over-2.5 hot pick fixture' : '');
        // A missed tip turns red wholesale; a hit stays calm with its ✓
        const missed = row.tip_outcome === 'miss';
        return (
            <span className={`whitespace-nowrap cursor-help ${missed ? 'text-rose-600' : ''}`} title={title}>
                {row.hot ? '🔥 ' : ''}
                <span className="font-medium">{row.tip_market}</span>
                {pct && <span className={missed ? '' : 'text-slate-500'}> · {pct}</span>}
                {row.tip_outcome === 'hit' && <span className="text-emerald-600 font-bold"> ✓</span>}
                {missed && <span className="font-bold"> ✗</span>}
            </span>
        );
    }
    if (key === 'provider') {
        return (
            <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${PROVIDER_STYLE[row.provider] ?? ''}`}>
                {row.provider}
            </span>
        );
    }
    if (key === 'fixture') {
        // Unavailable matches (concluded or no live markets) lose their link
        // unless the provider is opted in via Settings (betpawa keeps
        // concluded match pages up for ~6h).
        const dead = row.available === false;
        const badge = _hotBadge(row);
        if (row.match_url && (!dead || linkProviders.has(row.provider))) {
            return (
                <>
                    {badge}
                    <a href={row.match_url} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">
                        {row.fixture}
                    </a>
                </>
            );
        }
        return (
            <>
                {badge}
                {dead ? <span title="Betting unavailable">{row.fixture}</span> : row.fixture}
            </>
        );
    }
    const value = key.startsWith('fs:') ? row.stats[key] : row[key];
    return value ?? <span className="text-slate-300">-</span>;
}

// Odds cell: fresh price, or the greyed last-seen price of a market that
// vanished from the latest bookmaker update, or an empty dash. A frozen
// match (concluded / no longer refreshed - `available` is false) greys ALL
// its prices the same way: these odds can no longer be taken.
function _marketCell(row, key) {
    const frozen = row.available === false;
    const fresh = row.markets[key];
    if (fresh != null) {
        return frozen
            ? <span className="text-slate-400" title="Frozen - betting unavailable">{fresh.toFixed(2)}</span>
            : fresh.toFixed(2);
    }
    const stale = row.markets_stale?.[key];
    if (stale != null) return <span className="text-slate-400" title="No longer offered">{stale.toFixed(2)}</span>;
    return <span className="text-slate-300">-</span>;
}

export default function DataTable({ catalog, rows, marketKeys, statKeys, columnOrder, sort, onSort, loading, linkProviders }) {
    const links = new Set(linkProviders ?? []);
    const sortable = new Set([
        ...(catalog?.base.filter(c => c.sortable).map(c => c.key) ?? []),
        ...(catalog?.markets.filter(c => c.sortable).map(c => c.key) ?? []),
    ]);
    const statLabel = new Map(catalog?.stats.map(c => [c.key, c.label]) ?? []);
    const columns = applyOrder([
        ...BASE_COLUMNS.map(c => ({ ...c, group: 'base' })),
        ...marketKeys.map(key => ({ key, label: key, group: 'market' })),
        ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key, group: 'stat' })),
    ], columnOrder);
    const order = new Map(sort.map((s, i) => [s.key, { ...s, i }]));
    const tint = new Map();
    for (const row of rows) {
        if (!tint.has(row.api_id)) tint.set(row.api_id, ROW_TINTS[tint.size % ROW_TINTS.length]);
    }

    return (
        <div className={`overflow-x-auto bg-white rounded-lg border border-slate-200 shadow-sm ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full text-xs whitespace-nowrap">
                <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
                        {columns.map(col => {
                            const s = order.get(col.key);
                            const canSort = sortable.has(col.key);
                            return (
                                <th
                                    key={col.key}
                                    onClick={canSort ? e => onSort(col.key, e.shiftKey) : undefined}
                                    className={`px-2 py-1.5 font-medium ${col.group === 'market' ? 'text-center' : ''} ${canSort ? 'cursor-pointer hover:bg-slate-100' : ''}`}
                                    title={canSort ? 'Click to sort - shift-click for multi-sort' : undefined}
                                >
                                    {col.label}
                                    {s && (
                                        <span className="ml-1 text-sky-600">
                                            {s.dir === 'asc' ? '▲' : '▼'}
                                            {sort.length > 1 && <sup>{s.i + 1}</sup>}
                                        </span>
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr
                            key={row.match_id}
                            className={`border-b border-slate-100 ${tint.get(row.api_id) ?? ''} hover:bg-slate-200/70`}
                            title={row.updated_at ? `Updated ${new Date(row.updated_at).toLocaleString()}` : undefined}
                        >
                            {columns.map(col => (
                                <td key={col.key} className={`px-2 py-1 ${col.group === 'market' ? 'text-center tabular-nums' : ''}`}>
                                    {col.group === 'market' ? _marketCell(row, col.key) : _cell(row, col.key, links)}
                                </td>
                            ))}
                        </tr>
                    ))}
                    {!rows.length && (
                        <tr>
                            <td colSpan={columns.length} className="px-2 py-8 text-center text-slate-400">
                                {loading ? 'Loading...' : 'No correlated records for this selection.'}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
