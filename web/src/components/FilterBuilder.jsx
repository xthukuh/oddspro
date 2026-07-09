import { useState } from 'react';
import { SheetClose } from './Sheet.jsx';

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
    ['not-contains', 'not contains'],
    ['in', 'in'],
    ['not-in', 'not in'],
];

// Value-only ops (text substring / CSV set membership) have no column-to-column
// form - the server rejects it. `in`/`not-in` take a CSV list, quotes optional.
const VALUE_ONLY = new Set(['like', 'not-contains', 'in', 'not-in']);
const COL_OPS = OPS.filter(([op]) => !VALUE_ONLY.has(op));

const NEW_ROW = { key: '1', op: 'gte', value: '', mode: 'value' };

const selCls = 'border border-separator bg-fill text-label rounded-[10px] h-9 px-2 text-sm outline-none';

export default function FilterBuilder({ catalog, filters, onApply, onClose }) {
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
        <div className="flex flex-col max-h-[92vh]">
            <div className="flex items-center gap-3 px-6 pt-5 pb-2">
                <h2 className="text-[22px] font-extrabold tracking-tight">Filters</h2>
                <span className="text-[13px] text-label-2 hidden sm:inline">narrow the table by any column</span>
                <div className="flex-1" />
                <SheetClose onClose={onClose} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 text-sm">
                {rows.map((row, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2 mb-2.5">
                        <span className="text-label-2 w-10 text-right">{i ? 'and' : 'where'}</span>
                        <select value={row.key} onChange={e => update(i, { key: e.target.value })} className={selCls}>
                            {groups.map(([label, opts]) => (
                                <optgroup key={label} label={label}>
                                    {opts.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                                </optgroup>
                            ))}
                        </select>
                        <select value={row.op} onChange={e => update(i, { op: e.target.value })} className={selCls}>
                            {(row.mode === 'col' ? COL_OPS : OPS).map(([op, label]) => (
                                <option key={op} value={op}>{label}</option>
                            ))}
                        </select>
                        <button
                            onClick={() => update(i, row.mode === 'col'
                                ? { mode: 'value' }
                                : { mode: 'col', ...(VALUE_ONLY.has(row.op) ? { op: 'gte' } : {}) })}
                            className={`cursor-pointer h-9 px-2.5 rounded-[10px] border text-xs ${row.mode === 'col'
                                ? 'border-accent bg-accent-soft text-accent'
                                : 'border-separator text-label-2 hover:bg-fill'}`}
                            title={row.mode === 'col'
                                ? 'Comparing to another column - switch to a value'
                                : 'Compare to another column instead of a value'}
                        >
                            {row.mode === 'col' ? 'col' : 'val'}
                        </button>
                        {row.mode === 'col' ? (
                            <select value={row.col ?? ''} onChange={e => update(i, { col: e.target.value })} className={`${selCls} w-full sm:w-44`}>
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
                                placeholder={row.op === 'in' || row.op === 'not-in' ? '"a","b",c' : 'value'}
                                title={row.op === 'in' || row.op === 'not-in'
                                    ? 'Comma-separated list; wrap an item in quotes to include commas/spaces'
                                    : undefined}
                                className="bg-fill text-label rounded-[10px] h-9 px-3 text-sm w-full sm:w-44 outline-none"
                            />
                        )}
                        <button
                            onClick={() => setRows(rs => rs.filter((_, j) => j !== i))}
                            className="cursor-pointer w-8 h-8 inline-flex items-center justify-center rounded-full text-label-3 hover:bg-fill hover:text-miss"
                            title="Remove condition"
                        >
                            &times;
                        </button>
                    </div>
                ))}
                <button
                    onClick={() => setRows(rs => [...rs, { ...NEW_ROW }])}
                    className="cursor-pointer text-accent hover:underline py-1"
                >
                    + Add condition
                </button>
            </div>
            <div className="flex items-center justify-between px-6 py-3 border-t border-separator-2">
                <button
                    onClick={() => { setRows([{ ...NEW_ROW }]); onApply([]); }}
                    className="cursor-pointer text-label-2 hover:text-label text-sm"
                >
                    Clear
                </button>
                <button
                    onClick={apply}
                    className="cursor-pointer h-10 px-6 rounded-full bg-accent text-white text-sm font-semibold hover:opacity-90"
                >
                    Apply
                </button>
            </div>
        </div>
    );
}
