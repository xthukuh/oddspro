import { useState } from 'react';

// Advanced query builder: AND-combined condition rows over EVERY catalog
// column - server-filterable fields (base + odds markets) run in SQL,
// everything else (derived STATS columns, score) filters client-side via
// filterValues.js; the builder itself doesn't care which side executes.
// Each condition compares its field to a literal value OR to another
// column (wire shape {key, op, col} - e.g. market '1' < market '2').

const OPS = [
    ['eq', '='],
    ['ne', '≠'],
    ['gt', '>'],
    ['gte', '≥'],
    ['lt', '<'],
    ['lte', '≤'],
    ['like', 'contains'],
];

// `like` has no column-to-column form (server rejects it)
const COL_OPS = OPS.filter(([op]) => op !== 'like');

const NEW_ROW = { key: '1', op: 'gte', value: '', mode: 'value' };

export default function FilterBuilder({ catalog, filters, onApply }) {
    // Applied filters round-trip into row state; mode is inferred from `col`
    const [rows, setRows] = useState(filters.length
        ? filters.map(f => ('col' in f
            ? { key: f.key, op: f.op, col: f.col, value: '', mode: 'col' }
            : { ...f, mode: 'value' }))
        : [{ ...NEW_ROW }]);
    // Grouped field options: base keys read as-is; stats show their catalog
    // label. `score` is client-filterable but lives outside the catalog
    // (base column of the table, not of the API); stats already covered by
    // a base key (league) are deduped.
    const baseKeys = new Set(catalog.base.filter(c => c.filterable).map(c => c.key));
    const groups = [
        ['Base', [...[...baseKeys].map(k => ({ key: k, label: k })), { key: 'score', label: 'score' }]],
        ['Markets', catalog.markets.filter(c => c.filterable).map(c => ({ key: c.key, label: c.key }))],
        ['Stats', catalog.stats.filter(c => !baseKeys.has(c.key)).map(c => ({ key: c.key, label: c.label ?? c.key }))],
    ];

    const update = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    const apply = () => onApply(rows
        .filter(r => (r.mode === 'col' ? r.col : r.value !== ''))
        .map(r => (r.mode === 'col'
            ? { key: r.key, op: r.op, col: r.col }
            : { key: r.key, op: r.op, value: r.value })));

    return (
        <div className="border-b border-slate-200 bg-white px-2 md:px-4 py-3 text-sm">
            {rows.map((row, i) => (
                <div key={i} className="flex flex-wrap items-center sm:justify-end gap-2 mb-2">
                    <span className="text-slate-400">{i ? 'and' : 'where'}</span>
                    <select
                        value={row.key}
                        onChange={e => update(i, { key: e.target.value })}
                        className="border border-slate-300 rounded px-2 py-1"
                    >
                        {groups.map(([label, opts]) => (
                            <optgroup key={label} label={label}>
                                {opts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                            </optgroup>
                        ))}
                    </select>
                    <select
                        value={row.op}
                        onChange={e => update(i, { op: e.target.value })}
                        className="border border-slate-300 rounded px-2 py-1"
                    >
                        {(row.mode === 'col' ? COL_OPS : OPS).map(([op, label]) => (
                            <option key={op} value={op}>{label}</option>
                        ))}
                    </select>
                    <button
                        onClick={() => update(i, row.mode === 'col'
                            ? { mode: 'value' }
                            : { mode: 'col', ...(row.op === 'like' ? { op: 'gte' } : {}) })}
                        className={`px-2 py-1 rounded border text-xs ${row.mode === 'col'
                            ? 'border-sky-500 bg-sky-50 text-sky-700'
                            : 'border-slate-300 text-slate-500 hover:bg-slate-50'}`}
                        title={row.mode === 'col'
                            ? 'Comparing to another column - switch to a value'
                            : 'Compare to another column instead of a value'}
                    >
                        {row.mode === 'col' ? 'col' : 'val'}
                    </button>
                    {row.mode === 'col' ? (
                        <select
                            value={row.col ?? ''}
                            onChange={e => update(i, { col: e.target.value })}
                            className="border border-slate-300 rounded px-2 py-1 w-full sm:w-44"
                        >
                            <option value="" disabled>column…</option>
                            {groups.map(([label, opts]) => (
                                <optgroup key={label} label={label}>
                                    {opts.filter(o => o.key !== row.key).map(o => (
                                        <option key={o.key} value={o.key}>{o.label}</option>
                                    ))}
                                </optgroup>
                            ))}
                        </select>
                    ) : (
                        <input
                            value={row.value}
                            onChange={e => update(i, { value: e.target.value })}
                            onKeyDown={e => e.key === 'Enter' && apply()}
                            placeholder="value"
                            className="border border-slate-300 rounded px-2 py-1 w-full sm:w-44"
                        />
                    )}
                    <button
                        onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
                        className="text-slate-400 hover:text-red-600"
                        title="Remove condition"
                    >
                        &times;
                    </button>
                </div>
            ))}
            <div className="flex items-center justify-end gap-3">
                <button
                    onClick={() => setRows(rs => [...rs, { ...NEW_ROW }])}
                    className="text-sky-700 hover:underline"
                >
                    + Add condition
                </button>
                <button
                    onClick={apply}
                    className="px-3 py-1 rounded bg-sky-600 text-white hover:bg-sky-500"
                >
                    Apply
                </button>
                <button
                    onClick={() => { setRows([{ ...NEW_ROW }]); onApply([]); }}
                    className="text-slate-500 hover:underline"
                >
                    Clear
                </button>
            </div>
        </div>
    );
}
