import { useEffect, useState } from 'react';
import {
    ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { getTrackSummary, fetchPerformance, fetchMagicSort } from '../api.js';
import { seriesColor, pct } from './labPalette.js';
import useDark from './useDark.js';

// Admin Dashboard (M5): today tiles + traffic charts over the pre-binned
// /api/admin/track/summary payload, plus an engine KPI strip from the public
// /api/performance + /api/magic-sort reports. Everything arrives aggregated -
// this component only lays numbers out (honesty rules: every rate shows its n,
// ROI is flat-stake, no EV claims).

const ACCENT = { light: '#5856dc', dark: '#8B89F0' };

const fmtRoi = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const roiCls = v => (v == null ? 'text-label-2' : v >= 0 ? 'text-hit' : 'text-miss');

// Zero-fill the sparse per-day rows into a contiguous window ending today so
// quiet days render as real gaps, not a compressed axis. Pure string/UTC math
// on the server's EAT 'YYYY-MM-DD' labels - no timezone decode.
function fillDays(daily, windowDays) {
    const byDay = new Map(daily.map(r => [r.day, r]));
    let today = new Date().toISOString().slice(0, 10);
    const last = daily[daily.length - 1]?.day;
    if (last && last > today) today = last; // the server's EAT day can be ahead of UTC
    let start = Date.parse(`${today}T00:00:00Z`) - (windowDays - 1) * 86_400_000;
    const first = daily[0]?.day;
    if (first) start = Math.min(start, Date.parse(`${first}T00:00:00Z`));
    const out = [];
    for (let t = start; ; t += 86_400_000) {
        const day = new Date(t).toISOString().slice(0, 10);
        out.push(byDay.get(day) ?? { day, sessions: 0, people: 0 });
        if (day >= today) break;
    }
    return out;
}

function Tile({ label, value, sub }) {
    return (
        <div className="bg-surface border border-separator-2 rounded-2xl px-4 py-3 min-w-0">
            <div className="text-[11px] text-label-2 truncate">{label}</div>
            <div className="text-label text-xl font-semibold leading-tight mt-0.5">{value}</div>
            {sub != null && <div className="text-[11px] text-label-3 truncate mt-0.5">{sub}</div>}
        </div>
    );
}

function Card({ title, note, children }) {
    return (
        <div className="bg-surface border border-separator-2 rounded-2xl p-4 min-w-0">
            <h3 className="text-[13px] font-semibold text-label">{title}</h3>
            {note != null && <p className="text-[11px] text-label-3 mt-0.5 mb-2">{note}</p>}
            {children}
        </div>
    );
}

// Token-styled tooltip (the recharts default is hardcoded white).
function ChartTip({ active, payload, label }) {
    if (!active || !payload?.length) return null;
    return (
        <div className="bg-surface border border-separator rounded-lg px-3 py-2 text-[12px] text-label shadow-lg">
            <div className="font-semibold mb-0.5">{label}</div>
            {payload.map(p => (
                <div key={p.name} className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: p.color ?? p.fill }} />
                    <span className="text-label-2">{p.name}:</span>
                    <span>{p.value}</span>
                </div>
            ))}
        </div>
    );
}

// Name + count rows with a proportional inline bar - readable at any count
// scale without another chart.
function RankList({ rows, unit }) {
    const max = Math.max(1, ...rows.map(r => r.count));
    return (
        <div className="flex flex-col gap-1.5">
            {rows.map(r => (
                <div key={r.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center text-[12px]">
                    <div className="min-w-0">
                        <div className="flex items-baseline gap-2">
                            <span className="text-label truncate">{r.name}</span>
                            {r.sub != null && <span className="text-label-3 text-[11px] shrink-0">{r.sub}</span>}
                        </div>
                        <div className="h-1.5 rounded-full bg-fill mt-0.5">
                            <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(r.count / max) * 100}%` }} />
                        </div>
                    </div>
                    <span className="text-label-2 tabular-nums">{r.count.toLocaleString()}{unit ? ` ${unit}` : ''}</span>
                </div>
            ))}
            {!rows.length && <p className="text-label-3 text-[12px]">Nothing recorded yet.</p>}
        </div>
    );
}

export default function DashboardSection() {
    const dark = useDark();
    const [days, setDays] = useState(30);
    const [sum, setSum] = useState(null);
    const [perf, setPerf] = useState(null);
    const [magic, setMagic] = useState(null);
    const [error, setError] = useState(null);

    // Traffic summary follows the window select; a failure here is the only
    // fatal one - the engine strip degrades to dashes on its own.
    useEffect(() => {
        let gone = false;
        getTrackSummary(days)
            .then(d => { if (!gone) { setSum(d); setError(null); } })
            .catch(e => { if (!gone) setError(e.message); });
        return () => { gone = true; };
    }, [days]);
    useEffect(() => {
        fetchPerformance().then(setPerf).catch(() => {});
        fetchMagicSort().then(setMagic).catch(() => {});
    }, []);

    if (error) return <p className="text-miss text-[13px]" role="alert">Traffic summary failed: {error}</p>;
    if (!sum) return <p className="text-label-2 text-sm py-8 text-center">Loading dashboard…</p>;

    const t = sum.today;
    const tips30 = perf?.tips?.windows?.['30d'];
    const tipsAll = perf?.tips?.windows?.all;
    const hot30 = perf?.hotpicks?.windows?.['30d'];
    const best = magic?.strategies?.[0];
    const dailyRows = fillDays(sum.daily, sum.window_days).map(r => ({
        ...r, label: r.day.slice(5).replace('-', '/'),
    }));
    const totalSessions = sum.daily.reduce((a, r) => a + r.sessions, 0);

    return (
        <div className="flex flex-col gap-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Tile label="Visitors today" value={t.unique} sub={`${t.total} session${t.total === 1 ? '' : 's'}`} />
                <Tile label="Active now" value={t.active_now} sub="last 5 minutes" />
                <Tile label="Events today" value={t.events} sub="feature interactions" />
                <Tile label="New visitors today" value={t.new_visitors} sub="first ever check-in" />
            </div>

            <Card title="Engine" note="Flat-stake windows from /api/performance - every rate carries its n; no EV claims.">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <Tile label="Tips · 30d" value={pct(tips30?.rate)}
                        sub={tips30 ? <>ROI <span className={roiCls(tips30.roi)}>{fmtRoi(tips30.roi)}</span> · n={tips30.hits + tips30.misses}</> : 'no data'} />
                    <Tile label="Tips · all time" value={pct(tipsAll?.rate)}
                        sub={tipsAll ? <>ROI <span className={roiCls(tipsAll.roi)}>{fmtRoi(tipsAll.roi)}</span> · n={tipsAll.hits + tipsAll.misses}</> : 'no data'} />
                    <Tile label="Hot picks · 30d" value={pct(hot30?.rate)}
                        sub={hot30 ? `n=${hot30.hits + hot30.misses}` : 'no data'} />
                    <Tile label="Top strategy" value={best?.label ?? '–'}
                        sub={best ? `slip survival ${pct(best.stats?.survival)} over ${best.stats?.days}d${best.low_sample ? ' · low sample' : ''}` : 'no replay yet'} />
                </div>
            </Card>

            <div className="flex items-center gap-2">
                <span className="text-[11px] text-label-2">Traffic window</span>
                {[7, 30, 90].map(d => (
                    <button key={d} onClick={() => setDays(d)}
                        className={`cursor-pointer h-8 px-3 rounded-full text-[12px] font-medium ${
                            days === d ? 'bg-accent text-white' : 'bg-fill text-label-2 hover:bg-fill-hover'}`}>
                        {d}d
                    </button>
                ))}
            </div>

            <div className="grid lg:grid-cols-2 gap-4">
                <Card title={`Visits per day · last ${sum.window_days} days`}
                    note={`${totalSessions.toLocaleString()} sessions · ${sum.repeat.people} visitors, ${sum.repeat.repeat_people} returned (${pct(sum.repeat.share)})`}>
                    <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={dailyRows} barGap={2} margin={{ top: 4, right: 8, bottom: 4, left: -24 }}>
                            <CartesianGrid vertical={false} />
                            <XAxis dataKey="label" tickLine={false} interval="preserveStartEnd" />
                            <YAxis allowDecimals={false} tickLine={false} />
                            <Tooltip content={<ChartTip />} cursor={{ fill: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }} />
                            <Legend />
                            <Bar dataKey="sessions" name="Sessions" fill={seriesColor(0, dark)} radius={[3, 3, 0, 0]} maxBarSize={22} />
                            <Bar dataKey="people" name="People" fill={seriesColor(1, dark)} radius={[3, 3, 0, 0]} maxBarSize={22} />
                        </BarChart>
                    </ResponsiveContainer>
                </Card>

                <Card title="Visit duration" note={`${sum.duration.total.toLocaleString()} sessions binned (activity-derived for abandoned tabs)`}>
                    <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={sum.duration.buckets} barGap={2} margin={{ top: 4, right: 8, bottom: 4, left: -24 }}>
                            <CartesianGrid vertical={false} />
                            <XAxis dataKey="bucket" tickLine={false} />
                            <YAxis allowDecimals={false} tickLine={false} />
                            <Tooltip content={<ChartTip />} cursor={{ fill: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }} />
                            <Bar dataKey="count" name="Sessions" fill={dark ? ACCENT.dark : ACCENT.light} radius={[3, 3, 0, 0]} maxBarSize={40} />
                        </BarChart>
                    </ResponsiveContainer>
                </Card>
            </div>

            <div className="grid lg:grid-cols-3 gap-4">
                <Card title="Feature usage" note={`Event counts · last ${sum.window_days} days`}>
                    <RankList rows={sum.features.map(f => ({
                        name: f.name, count: f.count, sub: `${f.sessions} session${f.sessions === 1 ? '' : 's'}`,
                    }))} />
                </Card>
                <Card title="Devices" note="Sessions per device class">
                    <RankList rows={sum.devices.map(d => ({ name: d.device, count: d.sessions }))} />
                </Card>
                <Card title="Countries" note="Sessions per resolved country">
                    <RankList rows={sum.countries.map(c => ({ name: c.country, count: c.sessions }))} />
                </Card>
            </div>

            <p className="text-[11px] text-label-3">
                Generated {new Date(sum.generated_at).toLocaleString()} · first-party beacon data only
                (see the <a className="text-accent" href="/privacy/index.html" target="_blank" rel="noopener">Privacy Policy</a>).
            </p>
        </div>
    );
}
