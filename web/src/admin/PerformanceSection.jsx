import { useCallback, useEffect, useState } from 'react';
import {
    ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
    ScatterChart, Scatter, ZAxis, ReferenceLine, Cell,
} from 'recharts';
import { getPerfScorecard, fetchPerformance, fetchMagicSort } from '../api.js';
import { seriesColor, pct } from './labPalette.js';
import useDark from './useDark.js';
import { MIN_TEST } from '../../../src/db/mine-rules.js';

// Admin Performance section (M11 Task 7): seven widgets over the AI scorecard
// (GET /api/admin/perf/scorecard -> src/scorecard.js's S1-S5, cached 60s
// server-side) plus the existing public /api/performance and /api/magic-sort
// reports.
//
// HONESTY RULES (binding, project-wide discipline - docs/research/
// sure-win-analysis.md): every widget shows its n; any group under MIN_TEST
// (40 - the same UNDERPOWERED floor `node scripts/ai-scorecard.js` labels,
// mine-rules.js) carries a visible badge; ROI/P&L figures are measured
// settled-history facts, presented as such - NEVER a forecast or a claimed
// winning edge. This project's own research found no positive-EV market on
// these books (flat-stake EV ~ -3%, the vig) - nothing here may imply
// otherwise. Slip survival/streak numbers are backtests, not forecasts
// (same framing as MagicMenu.jsx).

const TONES = {
    hit: 'text-hit bg-hit/10',
    miss: 'text-miss bg-miss/10',
    hot: 'text-hot bg-hot/10',
    accent: 'text-accent bg-accent/10',
    muted: 'text-label-2 bg-fill',
};
function Chip({ tone = 'muted', title, children }) {
    return (
        <span title={title}
            className={`inline-block text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 whitespace-nowrap ${TONES[tone]}`}>
            {children}
        </span>
    );
}

// The ONE underpowered marker, shared by every widget below - never a
// bespoke per-widget threshold. MIN_TEST is the scorecard's own floor.
function Under({ n }) {
    if (n == null || n >= MIN_TEST) return null;
    return (
        <span className="ml-1.5 inline-flex" title={`Fewer than ${MIN_TEST} settled samples - too small to draw a conclusion from`}>
            <Chip tone="hot">⚠ underpowered</Chip>
        </span>
    );
}

function Nn({ n, label = 'n' }) {
    return <span className="text-label-3 tabular-nums">{label}={n ?? 0}</span>;
}

function Card({ title, hint, children, right }) {
    return (
        <section className="bg-surface rounded-2xl border border-separator-2 p-4">
            <div className="flex items-start gap-2 mb-3">
                <div>
                    <h3 className="text-label text-sm font-semibold">{title}</h3>
                    {hint && <p className="text-label-3 text-[12px] mt-0.5 leading-relaxed">{hint}</p>}
                </div>
                {right && <div className="ml-auto shrink-0">{right}</div>}
            </div>
            {children}
        </section>
    );
}

const errText = e => e?.body?.error || e?.message || String(e);
const fmtRoi = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const roiCls = v => (v == null ? 'text-label-2' : v >= 0 ? 'text-hit' : 'text-miss');
const fmtUnits = v => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}u`);
const fmtPrice = v => (v == null ? '–' : Number(v).toFixed(2));

// Literal hex twins of --hit/--miss (SVG fill/stroke attrs can't hold a CSS
// var) - same values index.css binds --color-hit/--color-miss to, same idiom
// DashboardSection's ACCENT / DataLab's inkFaint already establish.
const HIT = { light: '#34C759', dark: '#30D158' };
const MISS = { light: '#FF3B30', dark: '#FF453A' };
const signColor = (v, dark) => (v == null ? (dark ? '#6b6870' : '#9b98a3') : v >= 0 ? HIT[dark ? 'dark' : 'light'] : MISS[dark ? 'dark' : 'light']);

const MARKET_GROUP_LABEL = {
    '1X2': '1X2 (home / draw / away)',
    double_chance: 'Double chance',
    over_under: 'Over/Under goals',
    btts: 'Both teams to score',
    dnb: 'Draw no bet',
    team_total: 'Team total goals',
    odd_even: 'Odd/Even goals',
    other: 'Other',
    unknown: 'Unknown',
};
const EDGE_LABEL = { positive: 'Positive edge', negative: 'Negative edge', unknown: 'Unknown' };

// ============================================================================
// 1. Calibration curve - S3 blind-reasoner reliability bins per model tag:
// predicted probability (x) vs realized hit rate (y). The dashed diagonal is
// perfect calibration; points above it mean the model under-called, below
// means it over-called.
// ============================================================================
function CalibrationCurve({ s3, dark }) {
    const groups = s3?.groups ?? [];
    if (!s3?.hasTerms || !groups.length) {
        return <p className="text-label-3 text-[12px]">No settled blind insights yet (accumulates while AI_ENRICH_ENABLED runs).</p>;
    }
    const line = dark ? 'rgba(240,236,240,0.3)' : 'rgba(60,58,67,0.35)';
    return (
        <>
            <ResponsiveContainer width="100%" height={300}>
                <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                    <CartesianGrid />
                    <XAxis dataKey="x" type="number" name="predicted" domain={[0, 1]} tickFormatter={pct} tickLine={false} />
                    <YAxis dataKey="y" type="number" name="realized" domain={[0, 1]} tickFormatter={pct} tickLine={false} />
                    <ZAxis dataKey="n" range={[50, 320]} />
                    <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={line} strokeDasharray="4 4" ifOverflow="extendDomain" />
                    <Tooltip cursor={false} content={({ active, payload }) => {
                        if (!active || !payload?.length) return null;
                        const p = payload[0].payload;
                        return (
                            <div className="bg-surface border border-separator rounded-lg px-3 py-2 text-[12px] text-label shadow-lg">
                                <div className="font-semibold mb-0.5">{p.tag}</div>
                                <div>bin [{p.lo.toFixed(1)}, {p.hi.toFixed(1)}) · predicted {pct(p.x)} · realized {pct(p.y)}</div>
                                <div className="text-label-3">n={p.n}{p.n < MIN_TEST ? ' (underpowered)' : ''}</div>
                            </div>
                        );
                    }} />
                    <Legend />
                    {groups.map((g, i) => (
                        <Scatter key={g.tag} name={g.tag}
                            data={g.bins.map(b => ({ x: b.meanP, y: b.realized, n: b.n, lo: b.lo, hi: b.hi, tag: g.tag }))}
                            fill={seriesColor(i, dark)} />
                    ))}
                </ScatterChart>
            </ResponsiveContainer>
            <p className="text-[11px] text-label-3 mt-1">Dashed diagonal = perfect calibration (predicted rate = realized rate). Point size ~ bin n.</p>
            {/* n is a hover-only detail on the chart itself (bin size + tooltip) -
                this line makes each tag's total n visible without hovering. */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-label-3">
                {groups.map(g => (
                    <span key={g.tag}>{g.tag}: <Nn n={g.n} label="terms" /><Under n={g.n} /></span>
                ))}
            </div>
        </>
    );
}

// ============================================================================
// 2. Market hit/ROI grid - flat-stake per-market-group stats from
// /api/performance's tips.buckets.market (all-settled-history, not windowed),
// plus the single-market hot-pick line for context.
// ============================================================================
function MarketGrid({ perf }) {
    if (!perf) return <p className="text-label-3 text-[12px]">Loading…</p>;
    const rows = Object.entries(perf.tips?.buckets?.market ?? {})
        .map(([key, s]) => ({ key, label: MARKET_GROUP_LABEL[key] ?? key, s }))
        .sort((a, b) => (b.s.hits + b.s.misses) - (a.s.hits + a.s.misses));
    const hot = perf.hotpicks?.windows?.all;
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[560px]">
                <thead>
                    <tr className="text-left text-[11px] text-label-3">
                        <th className="pr-3 py-1.5 font-medium">Market</th>
                        <th className="pr-3 py-1.5 font-medium text-right">n settled</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Hit rate</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Avg price</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Break-even</th>
                        <th className="py-1.5 font-medium text-right">Flat-stake ROI</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-separator-2">
                    {rows.map(({ key, label, s }) => {
                        const n = s.hits + s.misses;
                        return (
                            <tr key={key}>
                                <td className="pr-3 py-1.5 text-label">{label}<Under n={n} /></td>
                                <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{n}</td>
                                <td className="pr-3 py-1.5 text-right tabular-nums text-label">{pct(s.rate)}</td>
                                <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{fmtPrice(s.avg_price)}</td>
                                <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{pct(s.break_even)}</td>
                                <td className={`py-1.5 text-right tabular-nums font-medium ${roiCls(s.roi)}`}>{fmtRoi(s.roi)}</td>
                            </tr>
                        );
                    })}
                    {!rows.length && <tr><td colSpan={6} className="py-3 text-center text-label-3">No settled tips yet.</td></tr>}
                    {hot && (
                        <tr className="border-t-2 border-separator">
                            <td className="pr-3 py-1.5 text-label">Hot picks (Over 2.5 goals)<Under n={hot.hits + hot.misses} /></td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{hot.hits + hot.misses}</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label">{pct(hot.rate)}</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{fmtPrice(hot.avg_price)}</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{pct(hot.break_even)}</td>
                            <td className={`py-1.5 text-right tabular-nums font-medium ${roiCls(hot.roi)}`}>{fmtRoi(hot.roi)}</td>
                        </tr>
                    )}
                </tbody>
            </table>
            <p className="text-[11px] text-label-3 mt-2">
                All-time settled history. ROI is flat-stake (1 unit/pick) - a measured fact about the past, not a
                projection. No market on these books has shown a sustained positive edge at real prices.
            </p>
        </div>
    );
}

// ============================================================================
// 3. Brier reliability bins (S3) - the numeric table backing the calibration
// curve above: per-tag Brier score + the exact bin counts.
// ============================================================================
function BrierBins({ s3 }) {
    const groups = s3?.groups ?? [];
    if (!s3?.hasTerms || !groups.length) {
        return <p className="text-label-3 text-[12px]">No settled blind insights yet.</p>;
    }
    return (
        <div className="flex flex-col gap-4">
            {groups.map(g => (
                <div key={g.tag}>
                    <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-semibold text-label">{g.tag}</span>
                        <Nn n={g.n} label="terms" /><Under n={g.n} />
                        <span className="text-label-2">Brier {g.brier.toFixed(4)} <span className="text-label-3">(0.25 = coin-flip on a balanced menu; lower is better)</span></span>
                    </div>
                    <table className="w-full text-[12px] mt-1.5 max-w-md">
                        <thead>
                            <tr className="text-left text-[11px] text-label-3">
                                <th className="pr-3 py-1 font-medium">Bin</th>
                                <th className="pr-3 py-1 font-medium text-right">n</th>
                                <th className="pr-3 py-1 font-medium text-right">mean(p)</th>
                                <th className="py-1 font-medium text-right">realized</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-separator-2">
                            {g.bins.map(b => (
                                <tr key={`${b.lo}-${b.hi}`}>
                                    <td className="pr-3 py-1 text-label-2 tabular-nums">[{b.lo.toFixed(1)}, {b.hi.toFixed(1)})</td>
                                    <td className="pr-3 py-1 text-right tabular-nums text-label-2">{b.n}{b.n < MIN_TEST ? ' ⚠' : ''}</td>
                                    <td className="pr-3 py-1 text-right tabular-nums text-label">{pct(b.meanP)}</td>
                                    <td className="py-1 text-right tabular-nums text-label">{pct(b.realized)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ))}
        </div>
    );
}

// ============================================================================
// 4. Edge-bucket P/L - flat-stake units by edge sign (blend confidence x
// price - 1), tips vs hot picks, from /api/performance's edge buckets.
// ============================================================================
function EdgeBuckets({ perf, dark }) {
    if (!perf) return <p className="text-label-3 text-[12px]">Loading…</p>;
    const keys = ['positive', 'negative', 'unknown'];
    const rows = keys
        .filter(k => perf.tips?.buckets?.edge?.[k] || perf.hotpicks?.buckets?.edge?.[k])
        .map(k => ({
            bucket: EDGE_LABEL[k],
            tipsProfit: perf.tips?.buckets?.edge?.[k]?.profit ?? 0,
            tipsN: (perf.tips?.buckets?.edge?.[k]?.hits ?? 0) + (perf.tips?.buckets?.edge?.[k]?.misses ?? 0),
            hotProfit: perf.hotpicks?.buckets?.edge?.[k]?.profit ?? 0,
            hotN: (perf.hotpicks?.buckets?.edge?.[k]?.hits ?? 0) + (perf.hotpicks?.buckets?.edge?.[k]?.misses ?? 0),
        }));
    if (!rows.length) return <p className="text-label-3 text-[12px]">No settled picks yet.</p>;
    return (
        <>
            <ResponsiveContainer width="100%" height={260}>
                <BarChart data={rows} barGap={4} margin={{ top: 4, right: 8, bottom: 4, left: -8 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="bucket" tickLine={false} />
                    <YAxis tickLine={false} tickFormatter={fmtUnits} />
                    <Tooltip content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        return (
                            <div className="bg-surface border border-separator rounded-lg px-3 py-2 text-[12px] text-label shadow-lg">
                                <div className="font-semibold mb-0.5">{label}</div>
                                {payload.map(p => (
                                    <div key={p.name}>{p.name}: {fmtUnits(p.value)} (n={p.payload[`${p.dataKey === 'tipsProfit' ? 'tips' : 'hot'}N`]})</div>
                                ))}
                            </div>
                        );
                    }} cursor={{ fill: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }} />
                    <Legend />
                    <Bar dataKey="tipsProfit" name="Tips (settled units)" radius={[3, 3, 0, 0]} maxBarSize={40}>
                        {rows.map((r, i) => <Cell key={i} fill={signColor(r.tipsProfit, dark)} />)}
                    </Bar>
                    <Bar dataKey="hotProfit" name="Hot picks (settled units)" radius={[3, 3, 0, 0]} maxBarSize={40}>
                        {rows.map((r, i) => <Cell key={i} fill={signColor(r.hotProfit, dark)} fillOpacity={0.55} />)}
                    </Bar>
                </BarChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1 text-[11px] text-label-3">
                {rows.map(r => (
                    <span key={r.bucket}>{r.bucket}: tips <Nn n={r.tipsN} /><Under n={r.tipsN} /> · hot <Nn n={r.hotN} /><Under n={r.hotN} /></span>
                ))}
            </div>
            <p className="text-[11px] text-label-3 mt-2">
                Flat-stake units (1/pick) actually won or lost on the settled ledger to date - a historical
                measurement, not a forecast. This is not evidence of a winning edge in any bucket.
            </p>
        </>
    );
}

// ============================================================================
// 5. AI veto value - S1 (hot adjudicator) + S2 (tip reviewer) per model tag:
// confirm/veto hit-rates and what following the veto was worth historically.
// ============================================================================
function VetoValue({ s1, s2 }) {
    const rows = [
        ...(s1?.groups ?? []).map(g => ({ layer: 'Hot pick', ...g })),
        ...(s2?.groups ?? []).map(g => ({ layer: 'Tip', ...g })),
    ];
    if (!rows.length) return <p className="text-label-3 text-[12px]">No settled AI verdicts yet.</p>;
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[640px]">
                <thead>
                    <tr className="text-left text-[11px] text-label-3">
                        <th className="pr-3 py-1.5 font-medium">Layer</th>
                        <th className="pr-3 py-1.5 font-medium">Model tag</th>
                        <th className="pr-3 py-1.5 font-medium text-right">n settled</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Confirm</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Veto</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Following the veto</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Errors</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-separator-2">
                    {rows.map((g, i) => (
                        <tr key={`${g.layer}-${g.tag}-${i}`}>
                            <td className="pr-3 py-1.5 text-label-2">{g.layer}</td>
                            <td className="pr-3 py-1.5 text-label">{g.tag}<Under n={g.n} /></td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{g.n}</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{g.confirm.n} hit {pct(g.confirm.rate)}</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{g.veto.n} hit {pct(g.veto.rate)}</td>
                            <td className={`pr-3 py-1.5 text-right tabular-nums font-medium ${roiCls(g.saved)}`}>{fmtUnits(g.saved)}</td>
                            <td className="py-1.5 text-right tabular-nums text-label-2">{g.errors}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="text-[11px] text-label-3 mt-2">
                "Following the veto" is the flat-stake units the vetoed picks would have won or lost had they been
                staked anyway, sign-flipped: positive means the vetoed picks would have LOST money (the veto held
                up); negative means they would have WON (the veto cost potential winnings). A historical measurement,
                not a guarantee the pattern repeats.
                {s1 && ` Hot picks: ${s1.noVerdict} of ${s1.settledTotal} settled rows never reached a verdict (see verdict coverage below).`}
            </p>
        </div>
    );
}

// ============================================================================
// 6. Slip survival / streaks - the backtest-ranked strategies from
// /api/magic-sort (public endpoint, already used by DashboardSection).
// Omitted gracefully (not fabricated) if that report failed to load.
// ============================================================================
function SlipSurvival({ magic }) {
    if (magic === undefined) return <p className="text-label-3 text-[12px]">Loading…</p>;
    if (!magic || !magic.strategies?.length) {
        return <p className="text-label-3 text-[12px]">Not available - /api/magic-sort has no replayable strategies yet.</p>;
    }
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[600px]">
                <thead>
                    <tr className="text-left text-[11px] text-label-3">
                        <th className="pr-3 py-1.5 font-medium">Strategy</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Slip days</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Survival</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Top-quarter hit rate</th>
                        <th className="pr-3 py-1.5 font-medium text-right">Streak avg/best</th>
                        <th className="py-1.5 font-medium text-right">Flat-stake ROI</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-separator-2">
                    {magic.strategies.map(s => (
                        <tr key={s.id}>
                            <td className="pr-3 py-1.5 text-label">
                                {s.label}
                                {s.low_sample && (
                                    <span className="ml-1.5 inline-flex" title={`Fewer than ${magic.sample?.min_days ?? 5} replayable days - treat with caution`}>
                                        <Chip tone="hot">⚠ small sample</Chip>
                                    </span>
                                )}
                            </td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{s.stats.days}</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label">{s.stats.survived}/{s.stats.days} ({pct(s.stats.survival)})</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{s.stats.quartile.hits}/{s.stats.quartile.n} ({pct(s.stats.quartile.rate)})</td>
                            <td className="pr-3 py-1.5 text-right tabular-nums text-label-2">{s.stats.streak?.avg ?? '–'}/{s.stats.streak?.best ?? '–'}</td>
                            <td className={`py-1.5 text-right tabular-nums font-medium ${roiCls(s.stats.roi)}`}>{fmtRoi(s.stats.roi)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="text-[11px] text-label-3 mt-2">
                Top-4 slip, backtested day-by-day at real settled prices with leave-one-day-out calibration - a
                replay of the past, not a forecast. "Survival" = the share of days the top-4 slip would have won
                every leg. {magic.sample && <>Backtest sample: {magic.sample.settled} settled tips across {magic.sample.days} days.</>}
            </p>
        </div>
    );
}

// ============================================================================
// 7. Verdict coverage per day (S5) - share of settled hot/tip rows that
// reached kickoff WITHOUT an AI verdict (the worker's best-effort pre-kickoff
// reach; a freeze means a missed row stays uncovered forever by design).
// ============================================================================
function VerdictCoverage({ s5, dark }) {
    const days = s5?.days ?? [];
    if (!days.length) return <p className="text-label-3 text-[12px]">Nothing settled yet.</p>;
    const shown = days.slice(-30);
    const rows = shown.map(d => ({
        day: d.day.slice(5),
        hotRate: d.hot ? d.hot.covered / d.hot.total : null,
        hotN: d.hot?.total ?? 0,
        tipRate: d.tip ? d.tip.covered / d.tip.total : null,
        tipN: d.tip?.total ?? 0,
    }));
    // Per-day n only lives in the chart's hover tooltip - this aggregate makes
    // the total sample size visible without hovering (over the SHOWN window).
    const hotTotal = shown.reduce((a, d) => a + (d.hot?.total ?? 0), 0);
    const hotCovered = shown.reduce((a, d) => a + (d.hot?.covered ?? 0), 0);
    const tipTotal = shown.reduce((a, d) => a + (d.tip?.total ?? 0), 0);
    const tipCovered = shown.reduce((a, d) => a + (d.tip?.covered ?? 0), 0);
    return (
        <>
            <ResponsiveContainer width="100%" height={260}>
                <BarChart data={rows} barGap={2} margin={{ top: 4, right: 8, bottom: 4, left: -16 }}>
                    <CartesianGrid vertical={false} />
                    <XAxis dataKey="day" tickLine={false} interval="preserveStartEnd" />
                    <YAxis domain={[0, 1]} tickFormatter={pct} tickLine={false} />
                    <Tooltip content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        return (
                            <div className="bg-surface border border-separator rounded-lg px-3 py-2 text-[12px] text-label shadow-lg">
                                <div className="font-semibold mb-0.5">{label}</div>
                                {payload.map(p => (
                                    <div key={p.name}>{p.name}: {pct(p.value)} (n={p.payload[`${p.dataKey === 'hotRate' ? 'hot' : 'tip'}N`]})</div>
                                ))}
                            </div>
                        );
                    }} cursor={{ fill: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }} />
                    <Legend />
                    <Bar dataKey="hotRate" name="Hot picks" fill={seriesColor(0, dark)} radius={[3, 3, 0, 0]} maxBarSize={18} />
                    <Bar dataKey="tipRate" name="Tips" fill={seriesColor(1, dark)} radius={[3, 3, 0, 0]} maxBarSize={18} />
                </BarChart>
            </ResponsiveContainer>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[11px] text-label-3">
                <span>Hot picks: {hotCovered}/{hotTotal} covered <Nn n={hotTotal} /><Under n={hotTotal} /></span>
                <span>Tips: {tipCovered}/{tipTotal} covered <Nn n={tipTotal} /><Under n={tipTotal} /></span>
            </div>
            <p className="text-[11px] text-label-3 mt-2">
                Last {shown.length} of {days.length} day{days.length === 1 ? '' : 's'} shown. Tips scoped to
                confidence ≥ {s5.tipAiMinConfidence} (TIP_AI_MIN_CONFIDENCE). Coverage below 100% = rows that kicked
                off before the worker reached them - the freeze forbids adjudicating after the fact, so a gap here is
                a scheduling limit, not a bug.
            </p>
        </>
    );
}

// ============================================================================

export default function PerformanceSection() {
    const dark = useDark();
    const [scorecard, setScorecard] = useState(null);
    const [scorecardError, setScorecardError] = useState(null);
    const [perf, setPerf] = useState(null);
    const [perfError, setPerfError] = useState(null);
    const [magic, setMagic] = useState(undefined); // undefined = still loading; null = failed/omit

    const loadScorecard = useCallback(async () => {
        setScorecardError(null);
        try {
            setScorecard(await getPerfScorecard());
        } catch (e) {
            setScorecardError(errText(e));
        }
    }, []);
    const loadPerf = useCallback(async () => {
        setPerfError(null);
        try {
            setPerf(await fetchPerformance());
        } catch (e) {
            setPerfError(errText(e));
        }
    }, []);

    useEffect(() => {
        loadScorecard();
        loadPerf();
        fetchMagicSort().then(setMagic).catch(() => setMagic(null)); // widget 6 omits gracefully, never fabricates
    }, [loadScorecard, loadPerf]);

    if (!scorecard && !scorecardError) return <p className="text-label-2 text-sm py-8 text-center">Loading performance data…</p>;

    return (
        <div className="flex flex-col gap-4">
            <p className="text-[11px] text-label-3 leading-relaxed max-w-3xl">
                Every widget here shows its sample size (n); groups under {MIN_TEST} settled samples carry a
                <Chip tone="hot">⚠ underpowered</Chip> badge and should not be trusted. ROI/P&amp;L figures are
                measured flat-stake facts about settled history - they are never a forecast, and this project's own
                research found no positive-EV market on these books.
            </p>

            {scorecardError && (
                <p className="text-miss text-[13px]" role="alert">
                    Scorecard failed to load: {scorecardError} <button className="underline cursor-pointer" onClick={loadScorecard}>Retry</button>
                </p>
            )}
            {perfError && (
                <p className="text-miss text-[13px]" role="alert">
                    /api/performance failed to load: {perfError} <button className="underline cursor-pointer" onClick={loadPerf}>Retry</button>
                </p>
            )}

            <Card title="Calibration curve" hint="Blind reasoner (S3): predicted probability vs realized outcome rate, per model tag.">
                <CalibrationCurve s3={scorecard?.s3} dark={dark} />
            </Card>

            <Card title="Market hit / ROI grid" hint="Flat-stake settled performance per tip market group, all-time.">
                <MarketGrid perf={perf} />
            </Card>

            <Card title="Brier reliability bins" hint="Blind reasoner (S3): Brier score + the exact reliability-bin counts behind the curve above.">
                <BrierBins s3={scorecard?.s3} />
            </Card>

            <Card title="Edge-bucket P/L" hint="Flat-stake units by edge sign (blend confidence × price − 1), tips vs hot picks.">
                <EdgeBuckets perf={perf} dark={dark} />
            </Card>

            <Card title="AI veto value" hint="Hot-pick adjudicator (S1) + tip reviewer (S2): confirm/veto hit-rates and what following each veto was worth.">
                <VetoValue s1={scorecard?.s1} s2={scorecard?.s2} />
            </Card>

            <Card title="Slip survival / streaks" hint="Backtest-ranked strategies from /api/magic-sort (top-4 slip, day-by-day replay at real prices).">
                <SlipSurvival magic={magic} />
            </Card>

            <Card title="Verdict coverage per day" hint="Share of settled hot picks / tips that reached kickoff with an AI verdict (S5).">
                <VerdictCoverage s5={scorecard?.s5} dark={dark} />
            </Card>
        </div>
    );
}
