import { useEffect, useMemo, useRef, useState } from 'react';
import {
    ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid,
    Tooltip, Legend, Cell, ScatterChart, Scatter, ZAxis,
} from 'recharts';
import { getLabFeatures, getLabData } from '../api.js';
import { seriesColor, rampColor, binLabel, pct, MAX_SERIES } from './labPalette.js';

// Data-viz lab: pick an X (and optional Y or color-facet) feature plus an
// outcome, and chart the outcome's empirical rate over settled fixtures from
// the server's pre-binned aggregates (never raw rows). Three forms: bar
// (rate per X bin, optional category series), heatmap (X × Y grid, rate as a
// sequential accent ramp), bubble (X × Y with size = sample, color = rate).
// Cells under the min-count guardrail arrive rate:null - they are kept out of
// the charts (footnote counts them) and render dashed in the table view,
// which doubles as the accessibility/contrast-relief channel.

// Theme flag for chart colors that must resolve to literal hex/rgba (SVG
// attributes can't hold var()): tracks the app's data-theme override AND the
// OS scheme while mounted, so an admin flipping theme mid-session never gets
// light marks on a dark chart.
function useDark() {
    const calc = () => {
        const forced = document.documentElement.dataset.theme;
        if (forced) return forced === 'dark';
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    };
    const [dark, setDark] = useState(calc);
    useEffect(() => {
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
        const update = () => setDark(calc());
        mq?.addEventListener('change', update);
        const mo = new MutationObserver(update);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => { mq?.removeEventListener('change', update); mo.disconnect(); };
    }, []);
    return dark;
}

const CHARTS = [
    { id: 'bar', label: 'Bar' },
    { id: 'heatmap', label: 'Heatmap' },
    { id: 'scatter', label: 'Bubble' },
];
const DAY_PRESETS = [['', 'All time'], ['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];

const selCls = 'bg-surface border border-separator text-label rounded-lg h-9 px-2 text-[13px] outline-none focus:border-accent max-w-[180px]';

function Field({ label, children }) {
    return (
        <label className="flex flex-col gap-1 text-[11px] text-label-2">
            <span>{label}</span>
            {children}
        </label>
    );
}

// Token-styled tooltip for both recharts forms (the default tooltip is
// hardcoded white). `counts` carries per-series sample sizes for bars.
function LabTooltip({ active, payload, label, xMeta }) {
    if (!active || !payload?.length) return null;
    const row = payload[0]?.payload ?? {};
    return (
        <div className="bg-surface border border-separator rounded-lg px-3 py-2 text-[12px] text-label shadow-lg">
            {label != null && <div className="font-semibold mb-0.5">{xMeta ? `${xMeta.label}: ` : ''}{label}</div>}
            {payload.map(p => (
                <div key={p.name} className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: p.color ?? p.fill }} />
                    <span className="text-label-2">{p.name}:</span>
                    <span>{typeof p.value === 'number' && p.value <= 1 ? pct(p.value) : p.value}</span>
                    {row.__counts?.[p.name] != null && <span className="text-label-3">n={row.__counts[p.name]}</span>}
                </div>
            ))}
        </div>
    );
}

function BubbleTooltip({ active, payload, xMeta, yMeta }) {
    const cell = payload?.[0]?.payload;
    if (!active || !cell) return null;
    return (
        <div className="bg-surface border border-separator rounded-lg px-3 py-2 text-[12px] text-label shadow-lg">
            <div>{xMeta.label}: <b>{binLabel(cell.x, xMeta.bin)}</b></div>
            <div>{yMeta.label}: <b>{binLabel(cell.y, yMeta.bin)}</b></div>
            <div>rate <b>{pct(cell.rate)}</b> · n={cell.count}</div>
        </div>
    );
}

export default function DataLab() {
    const dark = useDark();
    const [meta, setMeta] = useState(null); // { features, outcomes, defaults }
    const [chart, setChart] = useState('bar');
    const [x, setX] = useState('implied_over');
    const [y, setY] = useState('rank_diff');
    const [color, setColor] = useState('');
    const [outcome, setOutcome] = useState('over25');
    const [days, setDays] = useState('');
    const [minCount, setMinCount] = useState('');
    const [showTable, setShowTable] = useState(false);
    const [data, setData] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const timerRef = useRef(null);

    useEffect(() => {
        getLabFeatures().then(setMeta).catch(e => setError(e.message));
    }, []);

    const needsY = chart !== 'bar';
    const features = meta?.features ?? [];
    const numberFeatures = features.filter(f => f.type === 'number');
    const categoryFeatures = features.filter(f => f.type === 'category');
    // Bubble axes must be numeric (a category has no position on a value
    // axis); the heatmap grid takes anything.
    const xOptions = chart === 'scatter' ? numberFeatures : features;
    const yOptions = chart === 'scatter' ? numberFeatures : features;

    // Debounced fetch on any control change (the params are cheap to compare -
    // one effect owns the timer, unmount clears it).
    useEffect(() => {
        if (!meta) return;
        if (!x || !outcome || (needsY && !y)) return;
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(async () => {
            setBusy(true);
            setError(null);
            try {
                setData(await getLabData({
                    x,
                    y: needsY ? y : null,
                    color: !needsY && color ? color : null,
                    outcome,
                    days: days || null,
                    minCount: minCount || null,
                    // Cap color series at the fixed palette (top N + '(other)').
                    topCategories: !needsY && color ? MAX_SERIES - 1 : null,
                }));
            } catch (e) {
                setError(e.message);
            } finally {
                setBusy(false);
            }
        }, 300);
        return () => clearTimeout(timerRef.current);
    }, [meta, chart, x, y, color, outcome, days, minCount, needsY]);

    // Keep pickers valid across chart-type switches (e.g. league on X, then
    // switch to bubble which is numeric-only).
    useEffect(() => {
        if (chart === 'scatter') {
            if (x && !numberFeatures.some(f => f.key === x)) setX(numberFeatures[0]?.key ?? '');
            if (y && !numberFeatures.some(f => f.key === y)) setY(numberFeatures.find(f => f.key !== x)?.key ?? '');
        }
    }, [chart]); // eslint-disable-line react-hooks/exhaustive-deps

    const guarded = useMemo(() => (data?.cells ?? []).filter(c => c.rate == null).length, [data]);

    // --- bar chart rows: one row per X bin, series columns when color is set.
    const bar = useMemo(() => {
        if (!data || chart !== 'bar') return null;
        const cells = data.cells.filter(c => c.rate != null);
        if (!data.color) {
            return {
                series: null,
                rows: cells.map(c => ({
                    label: binLabel(c.x, data.x.bin), rate: c.rate, __counts: { rate: c.count },
                })),
            };
        }
        // Series order: total count desc ('(other)' last) = fixed slot order.
        const totals = new Map();
        for (const c of cells) totals.set(c.color, (totals.get(c.color) ?? 0) + c.count);
        const series = [...totals.entries()]
            .sort((a, b) => (a[0] === '(other)') - (b[0] === '(other)') || b[1] - a[1])
            .map(([name]) => name);
        const byLabel = new Map();
        for (const c of cells) {
            const label = binLabel(c.x, data.x.bin);
            if (!byLabel.has(label)) byLabel.set(label, { label, __counts: {} });
            const row = byLabel.get(label);
            row[c.color] = c.rate;
            row.__counts[c.color] = c.count;
        }
        return { series, rows: [...byLabel.values()] };
    }, [data, chart]);

    // --- heatmap grid: unique sorted axes + cell lookup.
    const heat = useMemo(() => {
        if (!data || chart !== 'heatmap' || !data.y) return null;
        const isNum = v => typeof v === 'number';
        const uniq = key => {
            const vals = [...new Set(data.cells.map(c => c[key]))];
            return vals.sort((a, b) => (isNum(a) && isNum(b) ? a - b : String(a).localeCompare(String(b))));
        };
        const xs = uniq('x');
        const ys = uniq('y').reverse(); // high at the top, like a y axis
        const byPos = new Map(data.cells.map(c => [`${c.x} ${c.y}`, c]));
        return { xs, ys, byPos };
    }, [data, chart]);

    const scatterCells = useMemo(() => (
        !data || chart !== 'scatter' ? null : data.cells.filter(c => c.rate != null)
    ), [data, chart]);

    // Literal (non-var) colors for SVG attributes, by mode.
    const inkFaint = dark ? 'rgba(240,236,240,0.15)' : 'rgba(60,58,67,0.22)';
    const hoverFill = dark ? 'rgba(150,146,152,0.16)' : 'rgba(118,116,128,0.1)';

    if (error && !meta) return <p className="text-miss text-[13px]" role="alert">{error}</p>;
    if (!meta) return <p className="text-label-2 text-sm py-8 text-center">Loading lab…</p>;

    const xMeta = data?.x;
    const yMeta = data?.y;

    return (
        <div className="op-lab flex flex-col gap-4">
            <div className="bg-surface rounded-2xl border border-separator-2 px-4 py-3 flex flex-wrap items-end gap-3">
                <Field label="Chart">
                    <select className={selCls} value={chart} onChange={e => setChart(e.target.value)}>
                        {CHARTS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                </Field>
                <Field label="Outcome">
                    <select className={selCls} value={outcome} onChange={e => setOutcome(e.target.value)}>
                        {(meta.outcomes ?? []).map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
                    </select>
                </Field>
                <Field label="X feature">
                    <select className={selCls} value={x} onChange={e => setX(e.target.value)}>
                        {xOptions.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                </Field>
                {needsY ? (
                    <Field label="Y feature">
                        <select className={selCls} value={y} onChange={e => setY(e.target.value)}>
                            {yOptions.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </select>
                    </Field>
                ) : (
                    <Field label="Series (optional)">
                        <select className={selCls} value={color} onChange={e => setColor(e.target.value)}>
                            <option value="">None</option>
                            {categoryFeatures.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                        </select>
                    </Field>
                )}
                <Field label="Period">
                    <select className={selCls} value={days} onChange={e => setDays(e.target.value)}>
                        {DAY_PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </Field>
                <Field label={`Min per bin (${meta.defaults?.min_count ?? 10})`}>
                    <input className={`${selCls} w-20`} inputMode="numeric" placeholder={String(meta.defaults?.min_count ?? 10)}
                        value={minCount} onChange={e => setMinCount(e.target.value.replace(/[^\d]/g, ''))} />
                </Field>
                <button onClick={() => setShowTable(v => !v)}
                    className={`cursor-pointer h-9 px-3 rounded-lg text-[12px] ${showTable ? 'bg-accent text-white' : 'bg-fill hover:bg-fill-hover text-label-2'}`}>
                    Table
                </button>
            </div>

            {error && <p className="text-miss text-[13px]" role="alert">{error}</p>}

            <div className="bg-surface rounded-2xl border border-separator-2 p-4 relative min-h-[420px]">
                {busy && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/60 rounded-2xl">
                        <span className="text-label-2 text-[13px]">Crunching…</span>
                    </div>
                )}
                {!data ? (
                    <p className="text-label-2 text-sm py-8 text-center">
                        {needsY && !y ? 'Pick a Y feature to draw the grid.' : 'Pick features to explore.'}
                    </p>
                ) : (
                    <>
                        <h3 className="text-[13px] font-semibold text-label mb-1">
                            {data.outcome.label} rate by {xMeta.label}
                            {data.y ? ` × ${data.y.label}` : ''}{data.color ? ` · by ${data.color.label}` : ''}
                        </h3>
                        <p className="text-[11px] text-label-3 mb-3">
                            {data.rows_used.toLocaleString()} settled fixtures
                            {days ? ` · last ${days} days` : ''} · bins under n={data.min_count} {guarded ? `hidden (${guarded})` : 'guarded'}
                        </p>

                        {chart === 'bar' && bar && (
                            <ResponsiveContainer width="100%" height={360}>
                                <BarChart data={bar.rows} barGap={2} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
                                    <CartesianGrid vertical={false} />
                                    <XAxis dataKey="label" tickLine={false} interval="preserveStartEnd" />
                                    <YAxis domain={[0, 1]} tickFormatter={pct} tickLine={false} />
                                    <Tooltip content={<LabTooltip xMeta={xMeta} />} cursor={{ fill: hoverFill }} />
                                    {bar.series && <Legend />}
                                    {bar.series
                                        ? bar.series.map((s, i) => (
                                            <Bar key={s} dataKey={s} fill={seriesColor(i, dark)} radius={[3, 3, 0, 0]} maxBarSize={28} />
                                        ))
                                        : <Bar dataKey="rate" name={data.outcome.label} fill={dark ? '#8B89F0' : '#5856dc'} radius={[3, 3, 0, 0]} maxBarSize={40} />}
                                </BarChart>
                            </ResponsiveContainer>
                        )}

                        {chart === 'heatmap' && heat && (
                            <div className="overflow-x-auto">
                                <div className="inline-grid gap-[2px] text-[11px]"
                                    style={{ gridTemplateColumns: `minmax(72px,auto) repeat(${heat.xs.length}, minmax(44px, 1fr))` }}>
                                    {heat.ys.map(yv => (
                                        [<div key={`h${yv}`} className="pr-2 flex items-center justify-end text-label-2 whitespace-nowrap">{binLabel(yv, yMeta.bin)}</div>,
                                            ...heat.xs.map(xv => {
                                                const c = heat.byPos.get(`${xv} ${yv}`);
                                                if (!c) return <div key={`${xv}|${yv}`} className="h-9 rounded-[3px]" />;
                                                const g = c.rate == null;
                                                const t = c.rate ?? 0;
                                                const ink = g ? undefined : (t > 0.55) === !dark ? '#FFFFFF' : '#16151A';
                                                return (
                                                    <div key={`${xv}|${yv}`}
                                                        title={`${xMeta.label} ${binLabel(xv, xMeta.bin)} · ${yMeta.label} ${binLabel(yv, yMeta.bin)}: ${pct(c.rate)} (n=${c.count})`}
                                                        className={`h-9 rounded-[3px] flex items-center justify-center ${g ? 'border border-dashed border-separator text-label-3' : ''}`}
                                                        style={g ? undefined : { background: rampColor(c.rate, dark), color: ink }}>
                                                        {g ? `n=${c.count}` : pct(c.rate)}
                                                    </div>
                                                );
                                            })]
                                    ))}
                                    <div />
                                    {heat.xs.map(xv => (
                                        <div key={`f${xv}`} className="pt-1 text-center text-label-2 whitespace-nowrap">{binLabel(xv, xMeta.bin)}</div>
                                    ))}
                                </div>
                                <div className="mt-3 flex items-center gap-2 text-[11px] text-label-2">
                                    <span>0%</span>
                                    <span className="h-2 w-32 rounded-full inline-block"
                                        style={{ background: `linear-gradient(to right, ${rampColor(0, dark)}, ${rampColor(0.5, dark)}, ${rampColor(1, dark)})` }} />
                                    <span>100%</span>
                                    <span className="ml-3 inline-block w-4 h-3 border border-dashed border-separator rounded-[2px]" /> under min count
                                </div>
                            </div>
                        )}

                        {chart === 'scatter' && scatterCells && (
                            <ResponsiveContainer width="100%" height={380}>
                                <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                                    <CartesianGrid />
                                    <XAxis dataKey="x" type="number" name={xMeta.label} domain={['auto', 'auto']} tickLine={false} />
                                    <YAxis dataKey="y" type="number" name={yMeta.label} domain={['auto', 'auto']} tickLine={false} />
                                    <ZAxis dataKey="count" range={[60, 420]} />
                                    <Tooltip content={<BubbleTooltip xMeta={xMeta} yMeta={yMeta} />} cursor={false} />
                                    <Scatter data={scatterCells}>
                                        {scatterCells.map((c, i) => (
                                            <Cell key={i} fill={rampColor(c.rate, dark)} stroke={inkFaint} />
                                        ))}
                                    </Scatter>
                                </ScatterChart>
                            </ResponsiveContainer>
                        )}

                        {showTable && (
                            <div className="mt-4 overflow-x-auto">
                                <table className="text-[12px] text-label border-collapse">
                                    <thead>
                                        <tr className="text-label-2 text-left">
                                            <th className="pr-4 pb-1 font-medium">{xMeta.label}</th>
                                            {data.y && <th className="pr-4 pb-1 font-medium">{data.y.label}</th>}
                                            {data.color && <th className="pr-4 pb-1 font-medium">{data.color.label}</th>}
                                            <th className="pr-4 pb-1 font-medium text-right">rate</th>
                                            <th className="pb-1 font-medium text-right">n</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {data.cells.map((c, i) => (
                                            <tr key={i} className={`border-t border-separator-2 ${c.rate == null ? 'text-label-3' : ''}`}>
                                                <td className="pr-4 py-0.5">{binLabel(c.x, xMeta.bin)}</td>
                                                {data.y && <td className="pr-4 py-0.5">{binLabel(c.y, data.y.bin)}</td>}
                                                {data.color && <td className="pr-4 py-0.5">{c.color}</td>}
                                                <td className="pr-4 py-0.5 text-right tabular-nums">{pct(c.rate)}</td>
                                                <td className="py-0.5 text-right tabular-nums">{c.count}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
