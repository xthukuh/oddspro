import { useEffect, useState } from 'react';
import Sheet, { SheetClose } from './Sheet.jsx';
import { fetchDailySlipTimeline } from '../api.js';
import { picksDayScore } from '../../../src/db/pick-rules.js';

// Daily MultiBet timeline. Since 2026-10-16 (algo v3) each day is the TOP 3
// PICKS: the three games whose tip (1.50+ odds) carries our highest
// calibrated win chance, each a single stake, drawn as a path in kickoff
// order so the day's winning route is visible at a glance. A day is scored
// ("2 of 3 won, +0.04u"), never stamped with a one-word verdict. Older days
// keep their tier cards (ladder / Hunter / Sharp) with leg scores. Built
// server-side (src/daily-slip.js), settled from canonical scores;
// `backfilled` rows come from the hindsight-free replay and say so. Guests
// get teaser rows (no legs) and a sign-in nudge.

const MOOD = {
    green: { dot: 'bg-hit', label: 'Full card' },
    amber: { dot: 'bg-hot', label: 'Short card' },
    red: { dot: 'bg-miss', label: 'No card' },
};

const _kick = iso => {
    try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
};

const _units = u => `${u >= 0 ? '+' : ''}${u.toFixed(2)}u`;
const _isPicksDay = d => Array.isArray(d.legs) && d.legs.some(l => l.kind === 'pick' || l.kind === 'slip');
const _ofKind = (d, kind) => (Array.isArray(d.legs) ? d.legs.filter(l => l.kind === kind) : []);

// The day's score line. Picks days: "2 of 3 won" (+ units once anything
// settled); older days: legs landed. Green when the day made money.
function OutcomeBadge({ d }) {
    if (d.status === 'no_slip') return <span className="text-[11px] text-label-3">no card</span>;
    if (_isPicksDay(d)) {
        const s = picksDayScore(_ofKind(d, 'pick'));
        const decided = s.won + s.lost;
        if (!decided) return <span className="text-[11px] text-label-2">{s.pending ? 'to play' : 'void'}</span>;
        return (
            <span className={`text-[11px] font-bold tabular-nums ${s.units > 0 ? 'text-hit' : 'text-label-2'}`}
                title={`${s.won} won, ${s.lost} missed${s.pending ? `, ${s.pending} to play` : ''} - flat 1 unit per pick`}>
                {s.won}/{s.won + s.lost + s.pending} won · {_units(s.units)}
            </span>
        );
    }
    if (d.outcome === 'won') return <span className="text-[11px] font-bold text-hit">WON</span>;
    if (d.outcome === 'lost' || d.outcome === 'void') {
        return <span className="text-[11px] tabular-nums text-label-2">{d.legs_hit ?? 0}/{d.legs_total} legs</span>;
    }
    return <span className="text-[11px] text-label-2">pending</span>;
}

function Prices({ leg, allPrices }) {
    if (!(allPrices && leg.prices && Object.keys(leg.prices).length)) return <>{Number(leg.price).toFixed(2)}</>;
    return Object.entries(leg.prices).map(([p, v], i) => {
        // Live bookmaker link while the leg is unsettled and the match page
        // was still active at build time.
        const url = leg.outcome == null ? leg.links?.[p] : null;
        const label = `${p} ${Number(v).toFixed(2)}`;
        return (
            <span key={p}>
                {i > 0 && ' · '}
                {url
                    ? <a href={url} target="_blank" rel="noopener noreferrer"
                        className="text-accent hover:underline" title={`Open this match on ${p}`}>{label}</a>
                    : label}
            </span>
        );
    });
}

function Score({ leg }) {
    if (!leg.score) return null;
    return (
        <span className={`rounded px-1 tabular-nums font-semibold ${leg.outcome === 'hit' ? 'bg-hit/10 text-hit' : leg.outcome === 'miss' ? 'bg-miss/10 text-miss' : 'bg-fill text-label'}`}
            title={`Final score ${leg.score}`}>
            {leg.score}
        </span>
    );
}

function Why({ leg }) {
    if (!leg.reasoning) return null;
    return (
        <details className="mt-0.5">
            <summary className="cursor-pointer text-[11.5px] text-label-3 hover:text-label-2 select-none">Why this pick</summary>
            <p className="text-[12px] text-label-2 leading-relaxed pt-0.5">{leg.reasoning}</p>
        </details>
    );
}

// One step of the picks path: a node (won / missed / to play) on a vertical
// line, then the game, the pick, its price and our chance.
function PathStep({ leg, index, last, allPrices }) {
    const node = leg.outcome === 'hit'
        ? { cls: 'bg-hit text-white border-hit', mark: '✓', title: 'Won' }
        : leg.outcome === 'miss'
            ? { cls: 'bg-surface text-miss border-miss', mark: '✗', title: 'Missed' }
            : leg.outcome === 'void'
                ? { cls: 'bg-surface text-label-3 border-separator', mark: '↩', title: 'Void - stake returned' }
                : { cls: 'bg-surface text-label-2 border-separator', mark: String(index + 1), title: 'To play' };
    const line = leg.outcome === 'hit' ? 'bg-hit' : leg.outcome === 'miss' ? 'bg-miss/40' : 'bg-separator';
    return (
        <li className="relative flex gap-3">
            <div className="flex flex-col items-center">
                <span className={`mt-1 w-6 h-6 shrink-0 rounded-full border-2 grid place-items-center text-[12px] font-bold ${node.cls}`}
                    title={node.title}>{node.mark}</span>
                {!last && <span className={`w-0.5 flex-1 my-0.5 rounded ${line}`} />}
            </div>
            <div className={`flex-1 min-w-0 ${last ? '' : 'pb-2.5'}`}>
                <div className="flex items-baseline gap-2 text-[13px]">
                    <span className="text-label-3 tabular-nums text-[12px]">{_kick(leg.kickoff)}</span>
                    <span className={`font-semibold truncate ${leg.outcome === 'miss' ? 'text-label-2' : 'text-label'}`}>
                        {leg.home} - {leg.away}
                    </span>
                </div>
                <div className="flex items-center gap-2 text-[12.5px]">
                    <span className={`font-semibold ${leg.outcome === 'miss' ? 'text-miss' : leg.outcome === 'hit' ? 'text-hit' : 'text-accent'}`}>
                        {leg.label ?? leg.market}
                    </span>
                    <span className="tabular-nums text-label"><Prices leg={leg} allPrices={allPrices} /></span>
                    <Score leg={leg} />
                    {leg.cal_prob != null && (
                        <span className="ml-auto tabular-nums text-label-2" title="Our calibrated win chance">
                            {Math.round(leg.cal_prob * 100)}%
                        </span>
                    )}
                </div>
                <Why leg={leg} />
            </div>
        </li>
    );
}

// The 2-leg daily slip (2026-10-16): one parlay at 2.5x or more, drawn as the
// same kickoff-order path. Its result reads WON or "1/2 legs", never LOST.
function SlipCard({ legs, allPrices }) {
    if (!legs.length) return null;
    const odds = Number(legs[0].slip_odds ?? legs.reduce((p, l) => p * Number(l.price), 1));
    const hits = legs.filter(l => l.outcome === 'hit').length;
    const decided = legs.filter(l => l.outcome === 'hit' || l.outcome === 'miss').length;
    const missed = legs.some(l => l.outcome === 'miss');
    const won = legs.every(l => l.outcome === 'hit' || l.outcome === 'void') && hits > 0;
    return (
        <div className="mt-2.5 pt-2 border-t border-separator-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide">
                <span className="font-semibold text-accent"
                    title="Two legs chosen together as the pair most likely to win at 2.5x or more. Replay: won 46.7% of training days, 56.3% of the test month.">
                    Daily slip · {odds.toFixed(2)}x
                </span>
                {legs[0].slip_chance != null && (
                    <span className="normal-case text-label-3" title="Our calibrated chance that both legs land">
                        {Math.round(legs[0].slip_chance * 100)}% by our numbers
                    </span>
                )}
                <span className={`ml-auto font-bold normal-case tabular-nums ${won ? 'text-hit' : 'text-label-2'}`}>
                    {won ? 'WON' : missed || decided ? `${hits}/${legs.length} legs` : 'to play'}
                </span>
            </div>
            <PicksPath legs={legs} allPrices={allPrices} />
        </div>
    );
}

function PicksPath({ legs, allPrices }) {
    const ordered = [...legs].sort((a, b) => (Date.parse(a.kickoff) || 0) - (Date.parse(b.kickoff) || 0));
    return (
        <ol className="mt-2">
            {ordered.map((l, i) => (
                <PathStep key={l.fixture_id ?? i} leg={l} index={i} last={i === ordered.length - 1} allPrices={allPrices} />
            ))}
        </ol>
    );
}

// Pre-v3 leg row (tier cards).
function Leg({ leg, allPrices }) {
    return (
        <div className="py-1.5 border-t border-separator-2 first:border-0">
            <div className="flex items-baseline gap-2 text-[13px]">
                <span className={`font-semibold ${leg.outcome === 'miss' ? 'text-miss' : leg.outcome === 'hit' ? 'text-hit' : 'text-label'}`}>
                    {leg.home} - {leg.away}
                </span>
                <span className="ml-auto shrink-0 tabular-nums text-label"><Prices leg={leg} allPrices={allPrices} /></span>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-label-2">
                <span>{leg.label ?? leg.market}</span>
                <Score leg={leg} />
                <span className="text-label-3">{_kick(leg.kickoff)}</span>
                {leg.cal_prob != null && <span className="ml-auto tabular-nums">{Math.round(leg.cal_prob * 100)}%</span>}
            </div>
            <Why leg={leg} />
        </div>
    );
}

// Pre-v3 tier identities, kept so history reads as it was published.
const TIER_META = {
    anchor: { label: 'Anchor 1.5x', cls: 'text-hit' },
    double: { label: 'Double 2x', cls: 'text-accent' },
    top3: { label: 'Top-3 value', cls: 'text-hot' },
    grand: { label: 'Grand 5x', cls: 'text-miss' },
    value: { label: 'Value card', cls: 'text-hot' },
    sharp: { label: 'Sharp 4x (BetPawa)', cls: 'text-hot' },
    hunter: { label: 'Hunter singles', cls: 'text-accent' },
};

function LegacyCards({ d, allPrices }) {
    if (!(d.cards_total > 1)) return <div className="mt-1.5">{d.legs.map((l, i) => <Leg key={i} leg={l} allPrices={allPrices} />)}</div>;
    return [...new Set(d.legs.map(l => l.card ?? 0))].sort((a, b) => a - b).map(ci => {
        const legs = d.legs.filter(l => (l.card ?? 0) === ci);
        const odds = legs.reduce((p, l) => p * Number(l.price), 1);
        const kind = legs[0]?.kind;
        const meta = TIER_META[kind] ?? (legs.some(l => l.kind === 'value') ? TIER_META.value : null);
        const settled = legs.every(l => l.outcome != null);
        const hits = legs.filter(l => l.outcome === 'hit').length;
        const won = settled && legs.every(l => l.outcome === 'hit' || l.outcome === 'void');
        const isSingles = kind === 'hunter';
        return (
            <div key={ci} className="mt-1.5">
                <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide">
                    <span className={`font-semibold ${meta?.cls ?? 'text-label-3'}`}>
                        {(legs[0]?.tier_label ?? meta?.label ?? `Card ${ci + 1}`)}{isSingles ? ` · ${legs.length} bet${legs.length > 1 ? 's' : ''}` : ` · ${odds.toFixed(2)}x`}
                    </span>
                    {settled && (
                        <span className={`font-bold normal-case ${won ? 'text-hit' : 'text-label-2'}`}>
                            {won ? 'WON' : `${hits}/${legs.length} legs`}
                        </span>
                    )}
                </div>
                {legs.map((l, i) => <Leg key={i} leg={l} allPrices={allPrices} />)}
            </div>
        );
    });
}

function DayCard({ d, today, allPrices }) {
    const mood = MOOD[d.mood] ?? MOOD.red;
    const teaser = d.teaser && !Array.isArray(d.legs);
    const picks = _isPicksDay(d);
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
                    {d.status !== 'published' ? ' - '
                        : picks ? `${_ofKind(d, 'pick').length} picks${d.combined_odds != null ? ` + ${Number(d.combined_odds).toFixed(2)}x slip` : ''}`
                            : d.combined_odds == null ? `${d.legs_total} picks`
                                : `${d.legs_total} legs @ ${Number(d.combined_odds).toFixed(2)}x`}
                </span>
                <OutcomeBadge d={d} />
            </div>
            {!teaser && Array.isArray(d.legs) && d.legs.length > 0 && (
                picks
                    ? <>
                        <PicksPath legs={_ofKind(d, 'pick')} allPrices={allPrices} />
                        <SlipCard legs={_ofKind(d, 'slip')} allPrices={allPrices} />
                    </>
                    : <LegacyCards d={d} allPrices={allPrices} />
            )}
        </div>
    );
}

export default function DailyMultibet({ onClose, premium, onSignIn }) {
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
                    Today's <span className="text-accent font-semibold">top 3 picks</span>: the three games whose tip at 1.50+ odds
                    carries our highest win chance, learned from our own settled results. Each pick is its own bet, so one miss
                    never wipes out the day. Below them, the <span className="text-accent font-semibold">daily slip</span>: two
                    legs that together pay 2.5x or more, the pair most likely to win. Follow each path in kickoff
                    order: <span className="text-hit font-semibold">✓</span> won, <span className="text-miss font-semibold">✗</span> missed,
                    numbers still to play.
                </p>
                {s && (
                    <div className="px-6 pb-2 flex flex-wrap gap-2 text-[12px]">
                        <span className="rounded-lg bg-fill px-2 py-1 text-label" title="Consecutive days in profit">run <b className="tabular-nums">{s.current}</b></span>
                        <span className="rounded-lg bg-fill px-2 py-1 text-label">best <b className="tabular-nums">{s.best}</b></span>
                        <span className="rounded-lg bg-fill px-2 py-1 text-label" title="Share of settled days that ended in profit">profit days <b className="tabular-nums">{Math.round((s.greenRate ?? 0) * 100)}%</b></span>
                        <span className="rounded-lg bg-fill px-2 py-1 text-label-2">played <b className="tabular-nums">{s.played}</b></span>
                        {(() => {
                            // Self-check (claimed vs realized) over settled PICKS only:
                            // the engine's own chances audited against the results.
                            let claimed = 0, hit = 0, n = 0;
                            for (const d of days) {
                                for (const l of (Array.isArray(d.legs) ? d.legs : [])) {
                                    if (l.kind !== 'pick' || (l.outcome !== 'hit' && l.outcome !== 'miss')) continue;
                                    if (typeof l.cal_prob !== 'number') continue;
                                    claimed += l.cal_prob; n++;
                                    if (l.outcome === 'hit') hit++;
                                }
                            }
                            if (n < 30) return null;
                            const c = Math.round(100 * claimed / n), r = Math.round(100 * hit / n);
                            return (
                                <span className={`rounded-lg px-2 py-1 ${r >= c ? 'bg-hit/10 text-hit' : 'bg-hot/10 text-hot'}`}
                                    title={`Self-check over ${n} settled picks: we claimed an average ${c}% win chance; reality delivered ${r}%.`}>
                                    self-check <b className="tabular-nums">{r}%</b> vs {c}% claimed
                                </span>
                            );
                        })()}
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
                        Sign in to see the picks and reasoning behind each day's card.{' '}
                        {!premium && onSignIn && (
                            <button onClick={onSignIn} className="cursor-pointer font-semibold text-accent hover:underline">Sign in</button>
                        )}
                    </div>
                )}
                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
                    {error && <div className="px-2 py-1 text-sm text-miss">{error}</div>}
                    {!error && !data && <div className="px-2 py-1 text-sm text-label-3">Loading...</div>}
                    {days.map(d => <DayCard key={d.date} d={d} today={d.date === todayKey} allPrices={allPrices} />)}
                    {data && !days.length && <div className="px-2 py-1 text-sm text-label-3">No cards yet.</div>}
                </div>
            </div>
        </Sheet>
    );
}
