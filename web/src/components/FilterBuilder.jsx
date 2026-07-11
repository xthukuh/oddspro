import { useEffect, useMemo, useState } from 'react';
import { SheetClose } from './Sheet.jsx';
import MultiSelect from './MultiSelect.jsx';
import NumberInput from './NumberInput.jsx';
import { labelFor } from '../columns.js';
import { applyClientFilters, distinctValues, toFilterCsv } from '../filterValues.js';
import { parseFilterList } from '../../../src/db/filter-csv.js';
import { parseExpr } from '../filterExpr.js';

// Advanced query builder with progressive disclosure:
//   BASIC (default) — a flat list of AND-combined conditions over any catalog
//     column that carries data on the loaded day. Value controls adapt to the
//     field type (number → NumberInput, date → date picker, low-cardinality →
//     value picker, text → text box); labels match the table column titles.
//   ADVANCED (toggle) — nested AND/OR groups, regex match/not-match ops, and
//     free-form `$row[...]` expression conditions (evaluated client-side over
//     the loaded day; see filterExpr.js). A live count previews the match set.
// Simple flat-AND conditions still pass to SQL (server narrowing); anything
// advanced falls back to whole-day client evaluation — the split is decided in
// filterValues.splitFilters, so the builder just emits the right wire shape.

// op code -> label. Regex ops are advanced-only.
const OP_LABEL = {
    eq: '=', ne: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
    like: 'contains', 'not-contains': 'not contains',
    in: 'in', 'not-in': 'not in', match: 'matches', 'not-match': 'not matches',
};
const CMP_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
const RANGE_OPS = ['gt', 'gte', 'lt', 'lte'];
const TEXT_OPS = new Set(['like', 'not-contains']);
const SET_OPS = new Set(['in', 'not-in']);
const REGEX_OPS = new Set(['match', 'not-match']);
// Value-only ops have no column-to-column form.
const VALUE_ONLY = new Set([...TEXT_OPS, ...SET_OPS, ...REGEX_OPS]);
// Ops that get a value PICKER on low-cardinality fields.
const PICK_OPS = new Set(['eq', 'ne', 'in', 'not-in']);
const PICKABLE = new Set(['league', 'status', 'provider', 'season', 'round']);

// Full op list for a field type (basic set; regex ops appended in advanced).
function opsForType(type) {
    if (type === 'bool') return ['eq', 'ne'];
    if (type === 'date') return [...RANGE_OPS];
    if (type === 'enum') return ['eq', 'ne', 'in', 'not-in', 'like', 'not-contains'];
    if (type === 'number') return [...CMP_OPS, 'in', 'not-in'];
    return ['like', 'not-contains', 'eq', 'ne', 'in', 'not-in']; // text
}

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
const MATCH_KEYS = ['fixture', 'home_team', 'away_team', 'league', 'season', 'round', 'status', 'start_time', 'provider', 'api_id'];
const BETTING_KEYS = ['tip', 'hot', 'hot_score', 'goals', 'score', 'updated_at', 'locked_at'];
const TEAM_STAT_KEYS = ['home_rank', 'home_form', 'away_rank', 'away_form', 'h2h', 'h2h_count',
    'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth'];

const DATE_KEYS = new Set(['start_time', 'updated_at', 'locked_at']);
// Fields whose sort value is numeric (so comparisons use a numeric input) even
// when the displayed text is a string (form points, tip confidence, …).
const NUMBER_KEYS = new Set(['goals', 'score', 'h2h_count', 'hot', 'hot_score', 'api_id', 'tip',
    'season', 'home_rank', 'away_rank', 'home_form', 'away_form', 'h2h',
    'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth']);
// Sort-hint shown under derived-numeric fields (their sort value ≠ their text).
const SORT_HINT = {
    home_form: 'sorts by points (W=3, D=1)', away_form: 'sorts by points (W=3, D=1)',
    h2h: 'sorts by home points', score: 'sorts by total goals',
    tip: 'compares confidence 0–1; “contains” matches the market text',
    home_goals_h2h: 'sorts by avg total', away_goals_h2h: 'sorts by avg total',
    home_goals_oth: 'sorts by avg total', away_goals_oth: 'sorts by avg total',
};

const EXPR_EXAMPLES = [
    "$row['goals'] > 2 && $row['h2h_count'] >= 3",
    "contains($row['fixture'], 'united') or $row['tip'] >= 0.7",
    "in(raw('tip'), 'O 2.5, O 1.5')",
    "$row['1'] < $row['2']",
];

const selCls = 'border border-separator bg-surface text-label rounded-[10px] h-10 px-2 text-sm outline-none';
const inputCls = 'bg-surface border border-separator text-label rounded-[10px] h-10 px-3 text-sm w-full sm:w-44 outline-none';

const NEW_COND = (key) => ({ key, op: 'gte', value: '', mode: 'value' });
const NEW_EXPR = () => ({ type: 'expr', expr: '' });
const NEW_GROUP = (key) => ({ type: 'group', join: 'and', items: [NEW_COND(key)] });

// --- model helpers ------------------------------------------------------

// Incoming wire (flat array or group) -> an editable working group. Flat array
// = implicit top-level AND. Conditions gain a `mode` (value/col) inferred from
// the presence of `col`.
function toWorkGroup(filters) {
    const toItem = f => (f && f.type === 'group'
        ? { type: 'group', join: f.join === 'or' ? 'or' : 'and', items: f.items.map(toItem) }
        : f && f.type === 'expr'
            ? { type: 'expr', expr: f.expr ?? '' }
            : ('col' in (f ?? {})
                ? { key: f.key, op: f.op, col: f.col, value: '', mode: 'col' }
                : { key: f.key, op: f.op, value: f.value ?? '', mode: 'value' }));
    if (filters && filters.type === 'group') return toItem(filters);
    const items = (Array.isArray(filters) ? filters : []).map(toItem);
    return { type: 'group', join: 'and', items };
}

const isValidExpr = (expr) => {
    try { parseExpr(expr); return true; } catch { return false; }
};
const condComplete = c => (c.mode === 'col' ? !!c.col : c.value !== '' && c.value != null);
const condWire = c => (c.mode === 'col'
    ? { key: c.key, op: c.op, col: c.col }
    : { key: c.key, op: c.op, value: c.value });

// Working group -> clean wire model: drop incomplete conditions, invalid/blank
// expressions and empty sub-groups (recursively).
function cleanGroup(group) {
    const items = [];
    for (const it of group.items) {
        if (it.type === 'group') {
            const g = cleanGroup(it);
            if (g.items.length) items.push(g);
        } else if (it.type === 'expr') {
            const e = (it.expr ?? '').trim();
            if (e && isValidExpr(e)) items.push({ type: 'expr', expr: e });
        } else if (condComplete(it)) {
            items.push(condWire(it));
        }
    }
    return { type: 'group', join: group.join === 'or' ? 'or' : 'and', items };
}

// Emit the narrowest wire shape: a flat array when the model is a single AND of
// leaves (server can still narrow it), else the full group object.
function toWire(group) {
    const clean = cleanGroup(group);
    const flat = clean.join === 'and' && clean.items.every(it => it.type !== 'group');
    return flat ? clean.items : clean;
}

// Does the incoming filter need advanced UI (OR join / sub-group / expression)?
function isAdvanced(group) {
    if (group.join === 'or') return true;
    return group.items.some(it => it.type === 'group' || it.type === 'expr');
}

// --- value controls -----------------------------------------------------

function ValueControl({ cond, ctx, onChange, apply }) {
    const { op, key } = cond;
    const type = ctx.typeOf(key);
    if (type === 'bool') {
        const checked = cond.value === '1' || cond.value === 'true';
        return (
            <label className="flex items-center gap-2 h-10 text-sm cursor-pointer">
                <input type="checkbox" checked={checked} onChange={e => onChange({ value: e.target.checked ? '1' : '0' })} className="accent-accent h-4 w-4" />
                <span className="text-label-2">{checked ? 'selected' : 'not selected'}</span>
            </label>
        );
    }
    if (REGEX_OPS.has(op)) {
        const ok = !cond.value || isValidRegex(cond.value);
        return (
            <input
                value={cond.value}
                onChange={e => onChange({ value: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && apply()}
                placeholder="regular expression"
                className={`${inputCls} font-mono ${ok ? '' : 'border-miss text-miss'}`}
                title="JavaScript regex, case-insensitive (e.g. ^O )"
            />
        );
    }
    if (TEXT_OPS.has(op)) {
        return (
            <input
                value={cond.value}
                onChange={e => onChange({ value: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && apply()}
                placeholder="text"
                className={inputCls}
            />
        );
    }
    const values = PICK_OPS.has(op) ? ctx.pickerValues(key) : [];
    if (SET_OPS.has(op)) {
        return values.length ? (
            <MultiSelect
                label={cond.value ? `${parseFilterList(cond.value).length} picked` : 'Pick values'}
                options={values.map(v => ({ key: String(v), label: valueLabel(key, v) }))}
                selected={parseFilterList(cond.value)}
                onChange={arr => onChange({ value: toFilterCsv(arr) })}
            />
        ) : (
            <input
                value={cond.value}
                onChange={e => onChange({ value: e.target.value })}
                onKeyDown={e => e.key === 'Enter' && apply()}
                placeholder='"a","b",c'
                title="Comma-separated list; wrap an item in quotes to include commas/spaces"
                className={inputCls}
            />
        );
    }
    // comparison ops
    if (type === 'date') {
        return (
            <input
                type="date"
                value={cond.value}
                onChange={e => onChange({ value: e.target.value })}
                className={`${selCls} w-full sm:w-44`}
            />
        );
    }
    if (values.length) {
        return (
            <select
                value={cond.value}
                onChange={e => onChange({ value: e.target.value })}
                className={`${selCls} w-full sm:w-52`}
            >
                <option value="" disabled>choose…</option>
                {values.map(v => <option key={String(v)} value={String(v)}>{valueLabel(key, v)}</option>)}
            </select>
        );
    }
    if (type === 'number') {
        return (
            <NumberInput
                value={cond.value}
                onCommit={n => onChange({ value: String(n) })}
                className={inputCls}
            />
        );
    }
    return (
        <input
            value={cond.value}
            onChange={e => onChange({ value: e.target.value })}
            onKeyDown={e => e.key === 'Enter' && apply()}
            placeholder="value"
            className={inputCls}
        />
    );
}

function isValidRegex(v) {
    if (String(v).length > 200) return false;
    try { new RegExp(String(v)); return true; } catch { return false; }
}

// --- condition / expression / group rows --------------------------------

function FieldSelect({ value, onChange, ctx, exclude }) {
    return (
        <select value={value} onChange={e => onChange(e.target.value)} className={selCls}>
            {ctx.groups.map(([label, opts]) => (
                <optgroup key={label} label={label}>
                    {opts.filter(o => o.key !== exclude).map(o => (
                        <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                </optgroup>
            ))}
        </select>
    );
}

function ConditionRow({ cond, ctx, advanced, onChange, onRemove, apply }) {
    const type = ctx.typeOf(cond.key);
    let ops = cond.mode === 'col' ? CMP_OPS : opsForType(type);
    if (advanced && cond.mode !== 'col' && type !== 'date') ops = [...ops, 'match', 'not-match'];
    // Keep the op valid when the field type changes under it; write the
    // reconciled op back so Apply uses exactly what the row displays.
    const op = ops.includes(cond.op) ? cond.op : ops[0];
    useEffect(() => { if (op !== cond.op) onChange({ op }); }, [op, cond.op]);
    const hint = cond.mode !== 'col' && CMP_OPS.includes(op) ? SORT_HINT[cond.key] : null;

    const setField = key => {
        const t = ctx.typeOf(key);
        const next = opsForType(t);
        const patch = { key, op: next.includes(op) ? op : next[0] };
        if (t === 'bool' && !cond.value) patch.value = '1'; // default: selected
        onChange(patch);
    };
    const toggleMode = () => onChange(cond.mode === 'col'
        ? { mode: 'value' }
        : { mode: 'col', ...(VALUE_ONLY.has(op) ? { op: 'gte' } : {}) });

    return (
        <div className="flex flex-wrap items-center gap-2">
            <FieldSelect value={cond.key} onChange={setField} ctx={ctx} />
            <select value={op} onChange={e => onChange({ op: e.target.value })} className={selCls}>
                {ops.map(o => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
            </select>
            <button
                onClick={toggleMode}
                className={`cursor-pointer h-10 px-3 rounded-[10px] border text-xs ${cond.mode === 'col'
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-separator text-label-2 hover:bg-fill'}`}
                title={cond.mode === 'col'
                    ? 'Comparing to another column — switch to a value'
                    : 'Compare to another column instead of a value'}
            >
                {cond.mode === 'col' ? 'col' : 'val'}
            </button>
            {cond.mode === 'col' ? (
                <select value={cond.col ?? ''} onChange={e => onChange({ col: e.target.value })} className={`${selCls} w-full sm:w-44`}>
                    <option value="" disabled>column…</option>
                    {ctx.groups.map(([label, opts]) => (
                        <optgroup key={label} label={label}>
                            {opts.filter(o => o.key !== cond.key).map(o => (
                                <option key={o.key} value={o.key}>{o.label}</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            ) : (
                <ValueControl cond={{ ...cond, op }} ctx={ctx} onChange={onChange} apply={apply} />
            )}
            {hint && <span className="text-[11px] text-label-3 basis-full sm:basis-auto sm:ml-1">{hint}</span>}
            <RemoveButton onClick={onRemove} title="Remove condition" />
        </div>
    );
}

function ExprRow({ cond, onChange, onRemove }) {
    const [showHelp, setShowHelp] = useState(false);
    const expr = cond.expr ?? '';
    const err = useMemo(() => {
        if (!expr.trim()) return null;
        try { parseExpr(expr); return null; } catch (e) { return String(e.message ?? e); }
    }, [expr]);
    return (
        <div className="flex flex-col gap-1 border border-separator rounded-xl p-2.5 bg-fill/40">
            <div className="flex items-center gap-2">
                <span className="text-label-2 text-xs font-semibold tracking-wide uppercase">Expression</span>
                <button onClick={() => setShowHelp(v => !v)} className="cursor-pointer text-xs text-accent hover:opacity-70" title="Syntax help">
                    ⓘ syntax
                </button>
                <div className="flex-1" />
                <RemoveButton onClick={onRemove} title="Remove expression" />
            </div>
            <textarea
                value={expr}
                onChange={e => onChange({ expr: e.target.value })}
                rows={2}
                spellCheck={false}
                placeholder="$row['goals'] > 2 && $row['h2h_count'] >= 3"
                className={`w-full bg-surface border rounded-[10px] px-3 py-2 text-sm font-mono outline-none resize-y ${err ? 'border-miss' : 'border-separator'}`}
            />
            {err
                ? <span className="text-[11px] text-miss">⚠ {err}</span>
                : expr.trim() && <span className="text-[11px] text-hit">✓ valid</span>}
            {showHelp && (
                <div className="text-[11px] text-label-2 leading-relaxed border-t border-hairline pt-2 mt-1">
                    <p><code className="text-accent">$row['key']</code> reads a column’s sort value · <code className="text-accent">raw('key')</code> its display text.</p>
                    <p>Operators: <code>+ - * / %</code> · <code>{'>'} {'>='} {'<'} {'<='} == != and or not</code> · <code>( )</code></p>
                    <p>Helpers: <code>contains(a,b)</code>, <code>in(x,'a,b')</code>, <code>lower</code>, <code>upper</code>, <code>abs</code>, <code>num</code></p>
                    <p className="mt-1 text-label-3">Examples:</p>
                    {EXPR_EXAMPLES.map(ex => (
                        <button
                            key={ex}
                            onClick={() => onChange({ expr: ex })}
                            className="block text-left font-mono text-accent hover:opacity-70 cursor-pointer"
                        >{ex}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

function RemoveButton({ onClick, title }) {
    return (
        <button
            onClick={onClick}
            className="cursor-pointer w-9 h-9 inline-flex items-center justify-center rounded-full text-label-3 hover:bg-fill hover:text-miss"
            title={title}
        >
            &times;
        </button>
    );
}

function JoinToggle({ join, onChange }) {
    return (
        <span className="inline-flex rounded-[10px] border border-separator overflow-hidden text-xs">
            {[['and', 'All'], ['or', 'Any']].map(([v, l]) => (
                <button
                    key={v}
                    onClick={() => onChange(v)}
                    className={`cursor-pointer px-2.5 py-1 ${join === v ? 'bg-accent text-white' : 'text-label-2 hover:bg-fill'}`}
                >{l}</button>
            ))}
        </span>
    );
}

function GroupEditor({ group, ctx, advanced, depth, onChange, onRemove }) {
    const setItems = items => onChange({ ...group, items });
    const updateItem = (i, patch) => setItems(group.items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
    const replaceItem = (i, next) => setItems(group.items.map((it, j) => (j === i ? next : it)));
    const removeItem = i => setItems(group.items.filter((_, j) => j !== i));
    const add = maker => setItems([...group.items, maker(ctx.defaultKey)]);

    const box = depth > 0
        ? 'border-l-2 border-accent/40 pl-3 ml-1 py-1'
        : '';

    return (
        <div className={`flex flex-col gap-2.5 ${box}`}>
            {(advanced && (depth > 0 || group.items.length > 1)) && (
                <div className="flex items-center gap-2 text-xs text-label-2">
                    <span>Match</span>
                    <JoinToggle join={group.join} onChange={j => onChange({ ...group, join: j })} />
                    <span>of:</span>
                    {depth > 0 && (
                        <>
                            <div className="flex-1" />
                            <RemoveButton onClick={onRemove} title="Remove group" />
                        </>
                    )}
                </div>
            )}
            {group.items.map((it, i) => (
                <div key={i} className="flex items-start gap-2">
                    <span className="text-label-3 w-9 text-right text-xs pt-2.5 shrink-0">
                        {i === 0 ? (depth === 0 ? 'where' : '') : (group.join === 'or' ? 'or' : 'and')}
                    </span>
                    <div className="flex-1 min-w-0">
                        {it.type === 'group' ? (
                            <GroupEditor
                                group={it} ctx={ctx} advanced={advanced} depth={depth + 1}
                                onChange={next => replaceItem(i, next)}
                                onRemove={() => removeItem(i)}
                            />
                        ) : it.type === 'expr' ? (
                            <ExprRow cond={it} onChange={patch => updateItem(i, patch)} onRemove={() => removeItem(i)} />
                        ) : (
                            <ConditionRow
                                cond={it} ctx={ctx} advanced={advanced}
                                onChange={patch => updateItem(i, patch)}
                                onRemove={() => removeItem(i)} apply={ctx.apply}
                            />
                        )}
                    </div>
                </div>
            ))}
            <div className="flex flex-wrap items-center gap-3 pl-9">
                <button onClick={() => add(NEW_COND)} className="cursor-pointer text-accent hover:opacity-70 py-1 text-sm">
                    + Condition
                </button>
                {advanced && (
                    <>
                        <button onClick={() => add(NEW_GROUP)} className="cursor-pointer text-accent hover:opacity-70 py-1 text-sm">
                            + Group
                        </button>
                        <button onClick={() => add(NEW_EXPR)} className="cursor-pointer text-accent hover:opacity-70 py-1 text-sm">
                            + Expression
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

export default function FilterBuilder({ catalog, available, rows = [], filterColumns = [], filters, onApply, onClose }) {
    const [model, setModel] = useState(() => toWorkGroup(filters));
    const [advanced, setAdvanced] = useState(() => isAdvanced(toWorkGroup(filters)));

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
            ['Match info', [field('select'), ...MATCH_KEYS.filter(baseOrStat).map(field)]],
            ['Betting', BETTING_KEYS.filter(k => baseFilterable.has(k) || k === 'score').map(field)],
            ['Odds markets', catalog.markets.filter(c => marketOk(c.key)).map(c => field(c.key))],
            ['Team & H2H stats', TEAM_STAT_KEYS.filter(k => statKeys.has(k) && statOk(k)).map(field)],
            ['Post-match stats', catalog.stats.filter(c => c.key.startsWith('fs:') && statOk(c.key)).map(c => field(c.key))],
        ].filter(([, opts]) => opts.length);
    }, [catalog, available]);

    const defaultKey = groups[0]?.[1]?.[0]?.key ?? '1';
    const marketKeys = useMemo(() => new Set(catalog.markets.map(c => c.key)), [catalog]);
    const typeOf = (key) => (key === 'select' ? 'bool'
        : DATE_KEYS.has(key) ? 'date'
            : (NUMBER_KEYS.has(key) || marketKeys.has(key) || key.startsWith('fs:')) ? 'number'
                : PICKABLE.has(key) ? 'enum' : 'text');
    const pickerValues = (key) => (PICKABLE.has(key) ? distinctValues(rows, { key, group: 'base' }) : []);

    // Seed one starter condition when opened with no filters (empty group),
    // once the field options (defaultKey) are known.
    useEffect(() => {
        setModel(m => (m.items.length ? m : { ...m, items: [NEW_COND(defaultKey)] }));
    }, [defaultKey]);

    const apply = () => { onApply(toWire(model)); onClose(); };
    const clear = () => { setModel({ type: 'group', join: 'and', items: [NEW_COND(defaultKey)] }); onApply([]); };

    const ctx = { groups, defaultKey, typeOf, pickerValues, apply };

    // Live preview: how many loaded rows match the (clean) draft model.
    const matched = useMemo(() => {
        const wire = toWire(model);
        const count = Array.isArray(wire) ? wire.length : (wire.items?.length ?? 0);
        if (!count) return null;
        return applyClientFilters(rows, wire, filterColumns).length;
    }, [model, rows, filterColumns]);

    return (
        <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
            <div className="flex items-center gap-3 px-6 pt-5 pb-2">
                <h2 className="text-[22px] font-extrabold tracking-tight">Filters</h2>
                <span className="text-[13px] text-label-2 hidden sm:inline">narrow the table by any column</span>
                <div className="flex-1" />
                <label className="flex items-center gap-1.5 text-xs text-label-2 cursor-pointer select-none" title="Nested AND/OR groups, regex, and expressions">
                    <input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.target.checked)} className="accent-accent h-4 w-4" />
                    Advanced
                </label>
                <SheetClose onClose={onClose} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-6 py-2 text-sm">
                <GroupEditor group={model} ctx={ctx} advanced={advanced} depth={0} onChange={setModel} />
            </div>
            <div className="flex items-center justify-between gap-3 px-6 py-3 border-t border-separator-2">
                <button onClick={clear} className="cursor-pointer text-label-2 hover:text-label text-sm">
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
