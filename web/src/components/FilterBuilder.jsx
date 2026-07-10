import { useMemo, useState } from 'react';
import { SheetClose } from './Sheet.jsx';
import MultiSelect from './MultiSelect.jsx';
import { labelFor } from '../columns.js';
import { applyClientFilters, distinctValues, toFilterCsv } from '../filterValues.js';
import { parseFilterList } from '../../../src/db/filter-csv.js';

// Advanced query builder: AND-combined condition rows over the catalog columns
// that actually have data on the loaded day. Field labels match the table
// column titles (labelFor); low-cardinality fields (league/status/provider/
// season/round) offer a value PICKER instead of free text; a live count
// previews how many loaded rows match. Server-filterable fields run in SQL,
// everything else (derived STATS, score, league) filters client-side via
// filterValues.js — the builder itself doesn't care which side executes.
// Each condition compares its field to a literal/list value OR to another
// column (wire shape {key, op, col} — e.g. market '1' < market '2').

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
// form — the server rejects it. `in`/`not-in` take a CSV list, quotes optional.
const VALUE_ONLY = new Set(['like', 'not-contains', 'in', 'not-in']);
const COL_OPS = OPS.filter(([op]) => !VALUE_ONLY.has(op));

// Ops that get a value PICKER on low-cardinality fields (a select for the
// single-value ops, a checkbox multi-select for the set ops).
const SET_OPS = new Set(['in', 'not-in']);
const PICK_OPS = new Set(['eq', 'ne', 'in', 'not-in']);

// Fields whose distinct values are worth picking from a list rather than typing.
const PICKABLE = new Set(['league', 'status', 'provider', 'season', 'round']);

// Friendly status names for the status picker (value stays the code).
const STATUS_LABEL = {
    TBD: 'Time TBD', NS: 'Not started', '1H': 'First half', HT: 'Half time',
    '2H': 'Second half', ET: 'Extra time', BT: 'Break', P: 'Penalties', LIVE: 'In play',
    SUSP: 'Suspended', INT: 'Interrupted', FT: 'Full time', AET: 'After extra time',
    PEN: 'After penalties', PST: 'Postponed', CANC: 'Cancelled', ABD: 'Abandoned',
    AWD: 'Awarded', WO: 'Walkover',
};
const valueLabel = (key, v) => (key === 'status' ? `${v} — ${STATUS_LABEL[v] ?? v}` : String(v));

// Base keys grouped for the field dropdown (mirrors the table/settings layout).
const MATCH_KEYS = ['fixture', 'league', 'season', 'round', 'status', 'start_time', 'provider', 'api_id'];
const BETTING_KEYS = ['tip', 'hot', 'hot_score', 'goals', 'score', 'updated_at', 'locked_at'];
const TEAM_STAT_KEYS = ['home_rank', 'home_form', 'away_rank', 'away_form', 'h2h', 'h2h_count',
    'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth'];

const NEW_ROW = { key: '1', op: 'gte', value: '', mode: 'value' };

const selCls = 'border border-separator bg-surface text-label rounded-[10px] h-10 px-2 text-sm outline-none';

export default function FilterBuilder({ catalog, available, rows = [], filterColumns = [], filters, onApply, onClose }) {
    // Applied filters round-trip into row state; mode is inferred from `col`
    const [condRows, setCondRows] = useState(filters.length
        ? filters.map(f => ('col' in f
            ? { key: f.key, op: f.op, col: f.col, value: '', mode: 'col' }
            : { ...f, mode: 'value' }))
        : [{ ...NEW_ROW }]);

    // Grouped, normalized, date-dynamic field options. Base fields always
    // available; markets/stats gated by what the day actually carries.
    const groups = useMemo(() => {
        const baseFilterable = new Set(catalog.base.filter(c => c.filterable).map(c => c.key));
        const statKeys = new Set(catalog.stats.map(c => c.key));
        const marketOk = k => !available || available.markets.has(k);
        const statOk = k => !available || available.stats.has(k);
        const field = key => ({ key, label: labelFor(key, catalog) });
        const baseOrStat = k => baseFilterable.has(k) || (statKeys.has(k) && statOk(k));
        return [
            ['Match info', MATCH_KEYS.filter(baseOrStat).map(field)],
            ['Betting', BETTING_KEYS.filter(k => baseFilterable.has(k) || k === 'score').map(field)],
            ['Odds markets', catalog.markets.filter(c => marketOk(c.key)).map(c => field(c.key))],
            ['Team & H2H stats', TEAM_STAT_KEYS.filter(k => statKeys.has(k) && statOk(k)).map(field)],
            ['Post-match stats', catalog.stats.filter(c => c.key.startsWith('fs:') && statOk(c.key)).map(c => field(c.key))],
        ].filter(([, opts]) => opts.length);
    }, [catalog, available]);

    const update = (i, patch) => setCondRows(rs => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

    // Complete conditions -> wire shape (shared by apply + the live preview)
    const toWire = r => (r.mode === 'col'
        ? { key: r.key, op: r.op, col: r.col }
        : { key: r.key, op: r.op, value: r.value });
    const complete = r => (r.mode === 'col' ? !!r.col : r.value !== '');
    const apply = () => onApply(condRows.filter(complete).map(toWire));

    // Live preview: how many loaded rows match the draft conditions. Evaluated
    // entirely client-side over the loaded day (the engine handles base/market/
    // stat alike), so it's exact for the current view.
    const matched = useMemo(() => {
        const wire = condRows.filter(complete).map(toWire);
        if (!wire.length) return null;
        return applyClientFilters(rows, wire, filterColumns).length;
    }, [condRows, rows, filterColumns]);

    // Value picker options for a pickable field (empty -> fall back to text).
    const pickerValues = (key) => (PICKABLE.has(key)
        ? distinctValues(rows, { key, group: 'base' })
        : []);

    return (
        <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
            <div className="flex items-center gap-3 px-6 pt-5 pb-2">
                <h2 className="text-[22px] font-extrabold tracking-tight">Filters</h2>
                <span className="text-[13px] text-label-2 hidden sm:inline">narrow the table by any column</span>
                <div className="flex-1" />
                <SheetClose onClose={onClose} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 text-sm">
                {condRows.map((row, i) => {
                    const values = row.mode === 'value' && PICK_OPS.has(row.op) ? pickerValues(row.key) : [];
                    const usePicker = values.length > 0;
                    return (
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
                                className={`cursor-pointer h-10 px-3 rounded-[10px] border text-xs ${row.mode === 'col'
                                    ? 'border-accent bg-accent-soft text-accent'
                                    : 'border-separator text-label-2 hover:bg-fill'}`}
                                title={row.mode === 'col'
                                    ? 'Comparing to another column — switch to a value'
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
                            ) : usePicker && SET_OPS.has(row.op) ? (
                                <MultiSelect
                                    label={row.value ? `${parseFilterList(row.value).length} picked` : 'Pick values'}
                                    options={values.map(v => ({ key: String(v), label: valueLabel(row.key, v) }))}
                                    selected={parseFilterList(row.value)}
                                    onChange={arr => update(i, { value: toFilterCsv(arr) })}
                                />
                            ) : usePicker ? (
                                <select
                                    value={row.value}
                                    onChange={e => update(i, { value: e.target.value })}
                                    className={`${selCls} w-full sm:w-52`}
                                >
                                    <option value="" disabled>choose…</option>
                                    {values.map(v => <option key={String(v)} value={String(v)}>{valueLabel(row.key, v)}</option>)}
                                </select>
                            ) : (
                                <input
                                    value={row.value}
                                    onChange={e => update(i, { value: e.target.value })}
                                    onKeyDown={e => e.key === 'Enter' && apply()}
                                    placeholder={SET_OPS.has(row.op) ? '"a","b",c' : 'value'}
                                    title={SET_OPS.has(row.op)
                                        ? 'Comma-separated list; wrap an item in quotes to include commas/spaces'
                                        : undefined}
                                    className="bg-surface border border-separator text-label rounded-[10px] h-10 px-3 text-sm w-full sm:w-44 outline-none"
                                />
                            )}
                            <button
                                onClick={() => setCondRows(rs => rs.filter((_, j) => j !== i))}
                                className="cursor-pointer w-9 h-9 inline-flex items-center justify-center rounded-full text-label-3 hover:bg-fill hover:text-miss"
                                title="Remove condition"
                            >
                                &times;
                            </button>
                        </div>
                    );
                })}
                <button
                    onClick={() => setCondRows(rs => [...rs, { ...NEW_ROW }])}
                    className="cursor-pointer text-accent hover:opacity-70 py-1"
                >
                    + Add condition
                </button>
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-separator-2">
                <button
                    onClick={() => { setCondRows([{ ...NEW_ROW }]); onApply([]); }}
                    className="cursor-pointer text-label-2 hover:text-label text-sm"
                >
                    Clear
                </button>
                {matched != null && (
                    <span className="text-xs text-label-2 tabular-nums" title="How many of the loaded rows match — previewed live before you apply">
                        {matched} of {rows.length} match
                    </span>
                )}
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
