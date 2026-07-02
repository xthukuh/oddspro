// Paginated multi-sort datatable: fixed base columns + selected market and
// STATS columns. Click a header to sort (shift-click chains multi-sort).

const PROVIDER_STYLE = {
    betpawa: 'bg-emerald-100 text-emerald-800',
    betika: 'bg-sky-100 text-sky-800',
};

// Base columns are always shown (README temp-csv order); match_url folds
// into the fixture cell as an outbound link.
const BASE_COLUMNS = [
    { key: 'api_id', label: 'API ID' },
    { key: 'start_time', label: 'Start' },
    { key: 'fixture', label: 'Fixture' },
    { key: 'provider', label: 'Provider' },
    { key: 'score', label: 'Score' },
    { key: 'goals', label: 'Goals' },
];

function _time(value) {
    const d = new Date(value);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function _cell(row, key) {
    if (key === 'start_time') return _time(row.start_time);
    if (key === 'provider') {
        return (
            <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${PROVIDER_STYLE[row.provider] ?? ''}`}>
                {row.provider}
            </span>
        );
    }
    if (key === 'fixture') {
        return row.match_url ? (
            <a href={row.match_url} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">
                {row.fixture}
            </a>
        ) : row.fixture;
    }
    const value = key.startsWith('fs:') ? row.stats[key] : row[key];
    return value ?? <span className="text-slate-300">-</span>;
}

export default function DataTable({ catalog, rows, marketKeys, statKeys, sort, onSort, loading }) {
    const sortable = new Set([
        ...(catalog?.base.filter(c => c.sortable).map(c => c.key) ?? []),
        ...(catalog?.markets.filter(c => c.sortable).map(c => c.key) ?? []),
    ]);
    const statLabel = new Map(catalog?.stats.map(c => [c.key, c.label]) ?? []);
    const columns = [
        ...BASE_COLUMNS.map(c => ({ ...c, group: 'base' })),
        ...marketKeys.map(key => ({ key, label: key, group: 'market' })),
        ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key, group: 'stat' })),
    ];
    const order = new Map(sort.map((s, i) => [s.key, { ...s, i }]));

    return (
        <div className={`overflow-x-auto bg-white rounded-lg border border-slate-200 shadow-sm ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full text-sm whitespace-nowrap">
                <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
                        {columns.map(col => {
                            const s = order.get(col.key);
                            const canSort = sortable.has(col.key);
                            return (
                                <th
                                    key={col.key}
                                    onClick={canSort ? e => onSort(col.key, e.shiftKey) : undefined}
                                    className={`px-3 py-2 font-medium ${col.group === 'market' ? 'text-center' : ''} ${canSort ? 'cursor-pointer hover:bg-slate-100' : ''}`}
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
                        <tr key={row.match_id} className="border-b border-slate-100 odd:bg-white even:bg-slate-50/50 hover:bg-sky-50">
                            {columns.map(col => (
                                <td key={col.key} className={`px-3 py-1.5 ${col.group === 'market' ? 'text-center tabular-nums' : ''}`}>
                                    {col.group === 'market'
                                        ? row.markets[col.key]?.toFixed(2) ?? <span className="text-slate-300">-</span>
                                        : _cell(row, col.key)}
                                </td>
                            ))}
                        </tr>
                    ))}
                    {!rows.length && (
                        <tr>
                            <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-400">
                                {loading ? 'Loading...' : 'No correlated records for this selection.'}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
    );
}
