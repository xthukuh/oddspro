import { useState } from 'react';

// Advanced query builder: AND-combined condition rows over the filterable
// fields (base columns + odds market columns), applied server-side.

const OPS = [
    ['eq', '='],
    ['ne', '≠'],
    ['gt', '>'],
    ['gte', '≥'],
    ['lt', '<'],
    ['lte', '≤'],
    ['like', 'contains'],
];

export default function FilterBuilder({ catalog, filters, onApply }) {
    const [rows, setRows] = useState(filters.length ? filters : [{ key: '1', op: 'gte', value: '' }]);
    const fields = [
        ...catalog.base.filter(c => c.filterable).map(c => c.key),
        ...catalog.markets.filter(c => c.filterable).map(c => c.key),
    ];

    const update = (i, patch) => setRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    return (
        <div className="border-b border-slate-200 bg-white px-4 py-3 text-sm">
            {rows.map((row, i) => (
                <div key={i} className="flex items-center gap-2 mb-2">
                    <span className="w-10 text-right text-slate-400">{i ? 'and' : 'where'}</span>
                    <select
                        value={row.key}
                        onChange={e => update(i, { key: e.target.value })}
                        className="border border-slate-300 rounded px-2 py-1"
                    >
                        {fields.map(f => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <select
                        value={row.op}
                        onChange={e => update(i, { op: e.target.value })}
                        className="border border-slate-300 rounded px-2 py-1"
                    >
                        {OPS.map(([op, label]) => <option key={op} value={op}>{label}</option>)}
                    </select>
                    <input
                        value={row.value}
                        onChange={e => update(i, { value: e.target.value })}
                        placeholder="value"
                        className="border border-slate-300 rounded px-2 py-1 w-44"
                    />
                    <button
                        onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
                        className="text-slate-400 hover:text-red-600"
                        title="Remove condition"
                    >
                        &times;
                    </button>
                </div>
            ))}
            <div className="flex items-center gap-3 pl-12">
                <button
                    onClick={() => setRows(rs => [...rs, { key: '1', op: 'gte', value: '' }])}
                    className="text-sky-700 hover:underline"
                >
                    + Add condition
                </button>
                <button
                    onClick={() => onApply(rows.filter(r => r.value !== ''))}
                    className="px-3 py-1 rounded bg-sky-600 text-white hover:bg-sky-500"
                >
                    Apply
                </button>
                <button
                    onClick={() => { setRows([{ key: '1', op: 'gte', value: '' }]); onApply([]); }}
                    className="text-slate-500 hover:underline"
                >
                    Clear
                </button>
            </div>
        </div>
    );
}
