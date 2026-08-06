import { useEffect, useState } from 'react';
import Sheet, { SheetClose } from './Sheet.jsx';
import { fetchDailySlipTimeline } from '../api.js';

// Daily MultiBet timeline (engine-v2 Phase 3): today's cherry-picked
// survival card on top, past days below in reverse chronology with won/lost
// badges and streak counters. The card is built server-side by the baked
// banker-style algorithm (src/db/daily-slip-rules.js) and settles from
// canonical scores; `backfilled` rows come from the hindsight-free replay
// generator and are labeled so the timeline never passes them off as live
// calls. Guests get teaser rows (no legs) and a sign-in nudge.

const MOOD = {
    green: { dot: 'bg-green', label: 'Green day' },
    amber: { dot: 'bg-hot', label: 'Amber day' },
    red: { dot: 'bg-miss', label: 'Red day' },
};

const _kick = iso => {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
};

function OutcomeBadge({ d }) {
    if (d.status === 'no_slip') return <span className="text-[11px] text-label-3">no slip</span>;
    if (d.outcome === 'won') return <span className="text-[11px] font-bold text-green">WON</span>;
    if (d.outcome === 'lost') return <span className="text-[11px] font-bold text-miss">LOST</span>;
    if (d.outcome === 'void') return <span className="text-[11px] text-label-3">VOID</span>;
    return <span className="text-[11px] text-label-2">pending</span>;
}

function Leg({ leg, allPrices }) {
    return (
        <div className="py-1.5 border-t border-separator-2 first:border-0">
            <div className="flex items-baseline gap-2 text-[13px]">
                <span className={`font-semibold ${leg.outcome === 'miss' ? 'text-miss' : leg.outcome === 'hit' ? 'text-green' : 'text-label'}`}>
                    {leg.home} - {leg.away}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-label">
                    {allPrices && leg.prices && Object.keys(leg.prices).length
                        ? Object.entries(leg.prices).map(([p, v], i) => {
                            // Live bookmaker link while the leg is unsettled and the
                            // match page was still active at build time.
                            const url = leg.outcome == null ? leg.links?.[p] : null;
                            const label = `${p} ${Number(v).toFixed(2)}`;
                            return (
                                <span key={p}>
                                    {i > 0 && ' · '}
                                    {url
                                        ? <a href={url} target="_blank" rel="noopener noreferrer"
                                            className="text-accent hover:underline"
                                            title={`Open this match on ${p}`}>{label}</a>
                                        : label}
                                </span>
                            );
                        })
                        : Number(leg.price).toFixed(2)}
                </span>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-label-2">
                <span>{leg.label ?? leg.market}</span>
                <span className="text-label-3">{_kick(leg.kickoff)}</span>
                {leg.cal_prob != null && <span className="ml-auto tabular-nums">{Math.round(leg.cal_prob * 100)}%</span>}
            </div>
            {leg.reasoning && (
                <details className="mt-0.5">
                    <summary className="cursor-pointer text-[11.5px] text-label-3 hover:text-label-2 select-none">Why this pick</summary>
                    <p className="text-[12px] text-label-2 leading-relaxed pt-0.5">{leg.reasoning}</p>
                </details>
            )}
        </div>
    );
}

function DayCard({ d, today, allPrices }) {
    const mood = MOOD[d.mood] ?? MOOD.red;
    const teaser = d.teaser && !Array.isArray(d.legs);
    return (
        <div className={`rounded-xl border ${today ? 'border-accent/50 bg-accent-soft' : 'border-separator'} px-3.5 py-2.5`}>
            <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full shrink-0 ${mood.dot}`} title={mood.label} />
                <span className="text-[13px] font-semibold text-label">{today ? 'Today' : d.date}</span>
                {d.backfilled && (
                    <span className="text-[10px] uppercase tracking-wide text-label-3 border border-separator rounded px-1"
                        title="Reconstructed by hindsight-free replay, not a live call">backfilled</span>
                )}
                <span className="ml-auto text-[12px] tabular-nums text-label-2">
                    {d.status === 'published' ? `${d.legs_total} legs @ ${Number(d.combined_odds).toFixed(2)}x` : '—'}
                </span>
                <OutcomeBadge d={d} />
            </div>
            {d.status === 'published' && d.outcome != null && (
                <div className="mt-0.5 text-[11.5px] text-label-3">
                    {d.legs_hit ?? 0}/{d.legs_total} legs landed
                    {d.cards_total > 1 && d.cards_won != null && (
                        <span className={`ml-2 font-semibold ${d.cards_won > 0 ? 'text-green' : 'text-miss'}`}>
                            {d.cards_won}/{d.cards_total} cards won
                        </span>
                    )}
                </div>
            )}
            {!teaser && Array.isArray(d.legs) && d.legs.length > 0 && (
                d.cards_total > 1
                    ? [...new Set(d.legs.map(l => l.card ?? 0))].sort((a, b) => a - b).map(ci => {
                        const legs = d.legs.filter(l => (l.card ?? 0) === ci);
                        const isValue = legs.some(l => l.kind === 'value');
                        const odds = legs.reduce((p, l) => p * Number(l.price), 1);
                        return (
                            <div key={ci} className="mt-1.5">
                                <div className={`text-[11px] uppercase tracking-wide ${isValue ? 'text-hot' : 'text-label-3'}`}
                                    title={isValue ? 'Value arm: 1.5x-target card at real odds. Replay record 61% cards, break-even - a risk product, not a profit promise.' : 'Safety arm: the survival card.'}>
                                    {isValue ? `Value card · ${odds.toFixed(2)}x` : `Card ${ci + 1}`}
                                </div>
                                {legs.map((l, i) => <Leg key={i} leg={l} allPrices={allPrices} />)}
                            </div>
                        );
                    })
                    : <div className="mt-1.5">{d.legs.map((l, i) => <Leg key={i} leg={l} allPrices={allPrices} />)}</div>
            )}
        </div>
    );
}

export default function DailyMultibet({ onClose, signedIn, onSignIn }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [allPrices, setAllPrices] = useState(false);

    useEffect(() => {
        let live = true;
        fetchDailySlipTimeline(60)
            .then(d => { if (live) setData(d); })
            .catch(e => { if (live) setError(e?.message ?? String(e)); });
        return () => { live = false; };
    }, []);

    const days = data?.days ?? [];
    const s = data?.streaks;
    const todayKey = new Date(new Date().setHours(13)).toISOString().slice(0, 10);
    const teaserMode = days.some(d => d.auth_required);

    return (
        <Sheet onClose={onClose} className="max-w-md">
            <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-2">
                    <h2 className="text-[22px] font-extrabold tracking-tight">Daily MultiBet</h2>
                    <div className="ml-auto"><SheetClose onClose={onClose} /></div>
                </div>
                <p className="px-6 pb-2 text-[13px] text-label-2 leading-relaxed">
                    One cherry-picked survival card per day: the safest qualifying legs by calibrated
                    win chance. Green days carry more legs; a day without enough safe picks honestly
                    publishes no slip. Survival ranking, never a profit promise.
                </p>
                {s && (
                    <div className="px-6 pb-2 flex flex-wrap gap-2 text-[12px]">
                        <span className="rounded-lg bg-fill px-2 py-1 text-label">streak <b className="tabular-nums">{s.current}</b></span>
                        <span className="rounded-lg bg-fill px-2 py-1 text-label">best <b className="tabular-nums">{s.best}</b></span>
                        <span className="rounded-lg bg-fill px-2 py-1 text-label">green days <b className="tabular-nums">{Math.round((s.greenRate ?? 0) * 100)}%</b></span>
                        <span className="rounded-lg bg-fill px-2 py-1 text-label-2">played <b className="tabular-nums">{s.played}</b></span>
                        {!teaserMode && (
                            <label className="ml-auto flex items-center gap-1.5 text-label-2 cursor-pointer select-none">
                                <input type="checkbox" checked={allPrices} onChange={e => setAllPrices(e.target.checked)} />
                                all bookmakers
                            </label>
                        )}
                    </div>
                )}
                {teaserMode && (
                    <div className="mx-6 mb-2 rounded-xl bg-accent-soft px-3 py-2 text-[13px] text-label">
                        Sign in to see the legs and reasoning behind each day's card.{' '}
                        {!signedIn && onSignIn && (
                            <button onClick={onSignIn} className="cursor-pointer font-semibold text-accent hover:underline">Sign in</button>
                        )}
                    </div>
                )}
                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
                    {error && <div className="px-2 py-1 text-sm text-miss">{error}</div>}
                    {!error && !data && <div className="px-2 py-1 text-sm text-label-3">Loading…</div>}
                    {days.map(d => <DayCard key={d.date} d={d} today={d.date === todayKey} allPrices={allPrices} />)}
                    {data && !days.length && <div className="px-2 py-1 text-sm text-label-3">No cards yet.</div>}
                </div>
            </div>
        </Sheet>
    );
}
