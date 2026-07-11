import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSlips, estimateLegProb, magicSortRows, slipOutcome, slipSummary, slipTotals, tipView } from '../../../src/db/magic-rules.js';
import { orderRows } from '../ordering.js';
import NumberInput from './NumberInput.jsx';
import Sheet, { SheetClose, PinToggle } from './Sheet.jsx';

// Betslip playground: build VIRTUAL multi-bet slips from the day's tips -
// drag a candidate onto a slip card (or use its + button), tune the
// stake / leg / target-odds limits, and read combined odds, potential payout
// and the calibrated survival estimate per slip. Client-only simulation, no
// real betting. Settled tips are candidates too (backtest mode: past dates
// replay at frozen tip prices and grade their slips WON/LOST). Candidates
// follow the table's sort order (blend confidence when none). Autogeneration
// (Fill from top, + New slip, Auto mode) packs the ranked tips into slips
// that each close once their combined odds reach Target odds.

const LS_SLIPS = 'oddspro.betslips';
// maxSlips 0 = unlimited; auto = rebuild slips on config change (default off).
const DEFAULT_CONFIG = { stake: 100, maxLegs: 4, targetOdds: 2.5, maxSlips: 0, hideUsed: true, auto: false };

const _id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const _pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
// HH:MM kickoff (matches the table's Start column) and a compact "Jul 9" date -
// a leg on the loaded day shows its time, a leg from another day shows its date.
const _hm = iso => {
    if (!iso) return null;
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
};
const _shortDate = iso => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null);

// Stored slips + limits survive reloads AND date changes, so one multi-bet slip
// can accumulate tips from several days. Legs are self-contained (each carries
// its own fixture/market/price/prob/outcome), so they render and settle no
// matter which date is loaded. Only the user empties them - the Clear-slips
// button or removing legs. (`date` in the payload is just the last-viewed date.)
function _loadSlips() {
    try {
        const v = JSON.parse(localStorage.getItem(LS_SLIPS));
        const config = { ...DEFAULT_CONFIG, ...(v && typeof v.config === 'object' ? v.config : {}) };
        // Migrate the old "Min odds" limit to "Target odds" (same number)
        if (config.minOdds != null && v?.config?.targetOdds == null) config.targetOdds = config.minOdds;
        delete config.minOdds;
        const slips = Array.isArray(v?.slips)
            ? v.slips.filter(s => s && typeof s === 'object' && Array.isArray(s.legs))
            : [];
        return { config, slips };
    } catch {
        return { config: { ...DEFAULT_CONFIG }, slips: [] };
    }
}

// Wrap buildSlips leg-arrays into named slip objects numbered from `start`
const _wrap = (legArrays, start) => legArrays.map((legs, i) => ({ id: _id(), name: `Slip ${start + i}`, legs }));

// One good / caution / bad pill scale for a slip or book outcome (AX6), kept
// separate from the numeric metrics grid so the state reads at a glance.
function OutcomePill({ tone, children }) {
    const cls = tone === 'won' ? 'bg-hit/15 text-hit'
        : tone === 'lost' ? 'bg-miss/15 text-miss'
            : 'bg-fill text-label-2';
    return (
        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
            {children}
        </span>
    );
}

export default function BetslipPlayground({ rows, chain, cal, columns, calibration, date, onClose }) {
    const hasMagic = chain?.some(e => e.type === 'magic');
    const [{ config, slips }, setState] = useState(() => _loadSlips());
    const [activeId, setActiveId] = useState(() => _loadSlips().slips[0]?.id ?? null);
    const [drag, setDrag] = useState(null); // dragged candidate api_id
    // Defaults PINNED: slips are easy to lose to a stray backdrop click, so the
    // playground opens with background-dismiss disabled (Escape / × still close).
    const [pinned, setPinned] = useState(true);
    // Collapsible panes (small screens only): collapsing Tips or Slips frees
    // vertical room for the other when they're stacked. On md+ (side-by-side)
    // both always show - the collapse class only hides below md.
    const [panes, setPanes] = useState({ tips: true, slips: true });
    const togglePane = k => setPanes(p => ({ ...p, [k]: !p[k] }));
    // Config inputs collapse on mobile only (a one-line summary shows the current
    // settings so you needn't expand to read them). On md+ the full input row
    // always shows - the `contents`/`hidden` swap only bites below md.
    const [cfgOpen, setCfgOpen] = useState(false);
    const bodyCls = open => (open
        ? 'flex flex-col min-h-0 md:grow'
        : 'hidden md:flex md:flex-col md:min-h-0 md:grow');

    // Persist on every change (paired-save idiom)
    useEffect(() => {
        localStorage.setItem(LS_SLIPS, JSON.stringify({ date, config, slips }));
    }, [date, config, slips]);

    // Slip candidates: the table's non-vetoed tips - one per canonical
    // fixture - in the SAME order the table shows (the unified sort chain);
    // with no active sort they fall back to blend-confidence best-first.
    // Settled tips are included (backtest mode: past dates replay at their
    // frozen tip prices); their outcome grades the slip.
    const candidates = useMemo(() => {
        const seen = new Set();
        const unique = [];
        for (const r of rows) {
            if (seen.has(r.api_id)) continue;
            seen.add(r.api_id);
            if (r.tip_market != null && r.tip_ai_verdict !== 'veto') unique.push(r);
        }
        const ranked = chain?.length
            ? orderRows(unique, chain, columns, cal)
            : magicSortRows(unique, 'confidence', calibration);
        return ranked.map(r => ({
            api_id: r.api_id,
            fixture: r.fixture,
            market: r.tip_market,
            price: r.tip_price,
            prob: estimateLegProb(tipView(r), calibration),
            outcome: r.tip_outcome ?? null,
            date, // origin date - lets legs from other days render un-dimmed
            time: _hm(r.start_time), // kickoff HH:MM (D5 same-day leg tag)
        }));
    }, [rows, chain, columns, cal, calibration, date]);
    const live = useMemo(() => new Set(candidates.map(c => c.api_id)), [candidates]);

    // Tips already sitting on any slip: "Fill from top" ALWAYS skips them, so
    // each click autogenerates the next distinct slip (ranks 1-4, then 5-8, …)
    // until the day's tips are exhausted; the Hide-used toggle additionally
    // hides them from the list below. Removing a slip/leg frees its tips.
    const usedIds = useMemo(() => new Set(slips.flatMap(s => s.legs.map(l => l.api_id))), [slips]);
    const unused = useMemo(() => candidates.filter(c => !usedIds.has(c.api_id)), [candidates, usedIds]);
    const shown = config.hideUsed ? unused : candidates;
    const fillOpts = { maxLegs: config.maxLegs, targetOdds: config.targetOdds, maxSlips: config.maxSlips };

    // NumberInput commits an already-clamped number
    const setConfig = (key, n) => setState(s => ({ ...s, config: { ...s.config, [key]: n } }));
    const setSlips = fn => setState(s => ({ ...s, slips: fn(s.slips) }));

    // Slips Fill-from-top would create from the current unused pool (drives the
    // button count/enable and the fill itself).
    const plannedFill = useMemo(
        () => buildSlips(unused, fillOpts),
        [unused, config.maxLegs, config.targetOdds, config.maxSlips],
    );

    // + New slip prefills ONE slip from the next unused top-ranked tips (both
    // modes) - empty when nothing is unused, so manual drag still works.
    const addSlip = () => {
        const legs = buildSlips(unused, { ...fillOpts, maxSlips: 1 })[0] ?? [];
        const [slip] = _wrap([legs], slips.length + 1);
        setSlips(prev => [...prev, slip]);
        setActiveId(slip.id);
    };
    // One click packs the WHOLE unused pool (best first) into slips that each
    // close at Target odds or Max legs, capped by Max slips.
    const fillFromTop = () => {
        if (!plannedFill.length) return;
        const created = _wrap(plannedFill, slips.length + 1);
        setSlips(prev => [...prev, ...created]);
        setActiveId(created[0].id);
    };
    const removeSlip = id => {
        setSlips(prev => prev.filter(s => s.id !== id));
        if (activeId === id) setActiveId(null);
    };
    // Wipe the whole book at once - frees every tip, so "Fill from top"
    // re-enables. No confirm: slips are virtual and one click rebuilds them.
    const clearSlips = () => {
        setSlips(() => []);
        setActiveId(null);
    };
    const renameSlip = (id, name) => setSlips(prev => prev.map(s => (s.id === id ? { ...s, name } : s)));
    const addLeg = (slipId, candidate) => {
        if (!candidate) return;
        setSlips(prev => prev.map(s => {
            if (s.id !== slipId) return s;
            if (s.legs.length >= config.maxLegs || s.legs.some(l => l.api_id === candidate.api_id)) return s;
            return { ...s, legs: [...s.legs, candidate] };
        }));
    };
    const removeLeg = (slipId, apiId) => setSlips(prev => prev.map(s => (
        s.id === slipId ? { ...s, legs: s.legs.filter(l => l.api_id !== apiId) } : s
    )));

    const activeSlip = slips.find(s => s.id === activeId) ?? slips[0] ?? null;
    // The active slip has reached its leg cap - the tip ＋ auto-hides (D2).
    const slipFull = !!activeSlip && activeSlip.legs.length >= config.maxLegs;
    // Touch add: land the tip on the active slip, or - with ZERO slips - create
    // one seeded with just this tip (guardrail: auto-create only on an explicit
    // add when the book is empty; activeSlip is null only when slips is empty).
    const addToActiveOrNew = candidate => {
        if (!candidate) return;
        if (activeSlip) { addLeg(activeSlip.id, candidate); return; }
        const [slip] = _wrap([[candidate]], slips.length + 1);
        setSlips(prev => [...prev, slip]);
        setActiveId(slip.id);
    };
    const totals = useMemo(() => slipTotals(slips, config.stake), [slips, config.stake]);

    // Auto mode: rebuild the whole book from the ranked candidates whenever the
    // limits or the tip pool change. Debounced 200ms with a 500ms max wait so
    // fast edits don't thrash; blank and 0 collapse to the same value (|| 0) so
    // clearing then re-typing a field causes no extra regeneration. Stake is
    // excluded - it changes payouts, not slip composition.
    const autoKey = config.auto ? JSON.stringify({
        maxLegs: config.maxLegs || 0,
        targetOdds: config.targetOdds || 0,
        maxSlips: config.maxSlips || 0,
        pool: candidates.map(c => c.api_id),
    }) : null;
    const timer = useRef(null);
    const burstStart = useRef(0);
    useEffect(() => {
        if (autoKey == null) return; // manual mode - leave slips alone
        const now = Date.now();
        if (!burstStart.current) burstStart.current = now;
        const delay = Math.min(200, Math.max(0, 500 - (now - burstStart.current)));
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            burstStart.current = 0;
            const created = _wrap(buildSlips(candidates, fillOpts), 1);
            setSlips(() => created);
            setActiveId(created[0]?.id ?? null);
        }, delay);
        return () => clearTimeout(timer.current);
    }, [autoKey]);

    return (
        <Sheet onClose={onClose} className="max-w-5xl flex flex-col p-3 md:p-5" dismissable={!pinned}>
                <div className="flex items-center gap-3 mb-3">
                    <h2 className="text-[22px] font-extrabold tracking-tight">Betslip playground</h2>
                    <span className="text-xs text-label-2 hidden sm:inline">virtual slips — nothing is placed</span>
                    <div className="grow" />
                    <PinToggle pinned={pinned} onToggle={() => setPinned(v => !v)} />
                    <SheetClose onClose={onClose} />
                </div>

                <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
                    {/* Mobile-only: collapse the limits behind a one-line summary
                        (desktop always shows the full row via `md:contents`). */}
                    <button
                        type="button" onClick={() => setCfgOpen(o => !o)} aria-expanded={cfgOpen}
                        title="Show / hide the slip limits"
                        className="md:hidden flex items-center gap-1.5 h-9 text-xs text-label-2"
                    >
                        <span className={`text-label-3 transition-transform ${cfgOpen ? 'rotate-90' : ''}`}>▸</span>
                        <span>Config <span className="text-label-3">
                            · 💰{config.stake} · {config.maxLegs} legs · ≥{config.targetOdds}{config.maxSlips ? ` · max ${config.maxSlips}` : ''}
                        </span></span>
                    </button>
                    <div className={cfgOpen ? 'contents' : 'hidden md:contents'}>
                    {[
                        ['Stake / slip', 'stake', { min: 1, max: 1_000_000, step: 1 }, 'w-24'],
                        ['Max legs', 'maxLegs', { min: 1, max: 20, int: true }, 'w-16'],
                        ['Target odds', 'targetOdds', { min: 1, max: 1000 }, 'w-20',
                            'Autogeneration closes a slip once its combined odds reach this'],
                        ['Max slips', 'maxSlips', { min: 0, max: 100, int: true }, 'w-16',
                            'Cap the number of slips autogeneration creates (0 = unlimited)'],
                    ].map(([label, key, bounds, w, hint]) => (
                        <label key={key} className="flex flex-col gap-1 text-xs text-label-2" title={hint}>
                            {label}
                            <NumberInput
                                value={config[key]}
                                onCommit={n => setConfig(key, n)}
                                min={bounds.min}
                                max={bounds.max}
                                int={bounds.int}
                                step={bounds.step}
                                className={`${w} bg-fill text-label rounded-[10px] px-2 h-9 text-sm outline-none`}
                            />
                        </label>
                    ))}
                    <label
                        className="flex items-center gap-1.5 pb-1.5 text-xs text-label-2 cursor-pointer select-none"
                        title="Auto mode rebuilds the slips from the tips whenever you change a limit (debounced)"
                    >
                        <input
                            type="checkbox"
                            checked={config.auto}
                            onChange={() => setState(s => ({ ...s, config: { ...s.config, auto: !s.config.auto } }))}
                        />
                        Auto
                    </label>
                    <label
                        className="flex items-center gap-1.5 pb-1.5 text-xs text-label-2 cursor-pointer select-none"
                        title="Hide tips already placed on a slip from the list below (Fill from top always skips them)"
                    >
                        <input
                            type="checkbox"
                            checked={config.hideUsed}
                            onChange={() => setState(s => ({ ...s, config: { ...s.config, hideUsed: !s.config.hideUsed } }))}
                        />
                        Hide used
                    </label>
                    </div>
                    <div className="grow" />
                    <button
                        onClick={clearSlips}
                        disabled={!slips.length}
                        title="Remove all slips at once (their tips become available again)"
                        className="cursor-pointer h-10 px-3 rounded-full border border-separator text-sm text-label-2 hover:bg-fill hover:text-miss disabled:opacity-50"
                    >
                        Clear slips
                    </button>
                    <button
                        onClick={() => addSlip()}
                        className="cursor-pointer h-10 px-3 rounded-full border border-separator text-sm hover:bg-fill"
                    >
                        + New slip
                    </button>
                    <button
                        onClick={fillFromTop}
                        disabled={!plannedFill.length}
                        title={plannedFill.length
                            ? `Autogenerate ${plannedFill.length} slip${plannedFill.length > 1 ? 's' : ''} from ${unused.length} unused tip${unused.length > 1 ? 's' : ''} (best first, ≤${config.maxLegs} legs, target ${config.targetOdds})`
                            : 'All tips are already on slips'}
                        className="cursor-pointer h-10 px-4 rounded-full bg-accent text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                    >
                        ✨ Fill from top
                    </button>
                </div>

                {/* On mobile this whole region scrolls as ONE column (the Tips
                    list is height-capped so a long list can't bury the Slips
                    below it); on md+ it's two side-by-side independently-scrolling
                    panes. */}
                <div className="flex flex-col md:flex-row gap-4 min-h-0 grow overflow-y-auto md:overflow-visible">
                    {/* Candidates: the view's tips ranked best-first (settled included) */}
                    <div className="w-full md:w-2/5 min-w-0 flex flex-col md:min-h-0">
                        <button
                            type="button" onClick={() => togglePane('tips')} aria-expanded={panes.tips}
                            title="Collapse / expand the tips list (small screens)"
                            className="flex items-center gap-1.5 text-sm font-medium text-label mb-0.5 text-left w-full md:cursor-default"
                        >
                            <span className={`md:hidden text-label-3 text-xs transition-transform ${panes.tips ? 'rotate-90' : ''}`}>▸</span>
                            <span>Tips <span className="text-label-3 font-normal">
                                ({shown.length}{candidates.length > shown.length ? ` · ${candidates.length - shown.length} used hidden` : ''}, best first{hasMagic ? ' · magic' : ''})
                            </span></span>
                        </button>
                        <div className={bodyCls(panes.tips)}>
                        {/* Touch-first: tapping the teal ＋ adds a tip to the active slip
                            (drag still works on desktop). The hint names where ＋ lands. */}
                        <p className="text-xs mb-1">
                            {slipFull
                                ? <span className="text-hot"><b>{activeSlip.name}</b> is full — <b>+ New slip</b> to keep adding.</span>
                                : activeSlip
                                    ? <span className="text-accent">Tap <b>+</b> to add to <b>{activeSlip.name}</b></span>
                                    : <span className="text-label-3">Tap <b>+</b> on a tip to start a slip.</span>}
                        </p>
                        <div className="max-h-[38vh] md:max-h-none md:grow overflow-y-auto border border-separator-2 rounded-lg p-1">
                            {shown.map(c => (
                                <div
                                    key={c.api_id}
                                    draggable
                                    onDragStart={() => setDrag(c.api_id)}
                                    onDragEnd={() => setDrag(null)}
                                    className={`flex items-center gap-2 px-1.5 py-1.5 rounded-lg text-xs select-none hover:bg-fill md:cursor-grab ${
                                        drag === c.api_id ? 'opacity-40' : ''}`}
                                >
                                    {/* Small ＋ chip with a ≥44px invisible tap-zone
                                        (after:-inset-2.5). Auto-hidden when the active
                                        slip is full; with zero slips it auto-creates. */}
                                    {!slipFull && (
                                        <button
                                            onClick={e => { e.stopPropagation(); addToActiveOrNew(c); }}
                                            aria-label={activeSlip ? `Add ${c.fixture} to ${activeSlip.name}` : `Start a slip with ${c.fixture}`}
                                            title={activeSlip ? `Add to ${activeSlip.name}` : 'Start a new slip with this tip'}
                                            className="relative cursor-pointer shrink-0 w-6 h-6 inline-flex items-center justify-center rounded-full bg-accent-soft text-accent text-sm leading-none font-semibold hover:bg-accent hover:text-white after:content-[''] after:absolute after:-inset-2.5"
                                        >
                                            +
                                        </button>
                                    )}
                                    <span className="truncate grow" title={c.fixture}>{c.fixture}</span>
                                    <span className="font-medium whitespace-nowrap">{c.market}</span>
                                    <span className="tabular-nums">{c.price?.toFixed(2) ?? '—'}</span>
                                    {c.outcome === 'hit' && <span className="text-hit font-bold">✓</span>}
                                    {c.outcome === 'miss' && <span className="text-miss font-bold">✗</span>}
                                    <span className="tabular-nums text-label-2" title="Calibrated win estimate">{_pct(c.prob)}</span>
                                </div>
                            ))}
                            {!shown.length && (
                                <div className="p-2 text-sm text-label-3">
                                    {candidates.length ? 'All tips are on slips.' : 'No tips on this view.'}
                                </div>
                            )}
                        </div>
                        </div>
                    </div>

                    {/* Slips: drop targets */}
                    <div className="w-full md:w-3/5 min-w-0 flex flex-col md:min-h-0">
                        <button
                            type="button" onClick={() => togglePane('slips')} aria-expanded={panes.slips}
                            title="Collapse / expand the slips (small screens)"
                            className="flex items-center gap-1.5 text-sm font-medium text-label mb-1 text-left w-full md:cursor-default"
                        >
                            <span className={`md:hidden text-label-3 text-xs transition-transform ${panes.slips ? 'rotate-90' : ''}`}>▸</span>
                            <span>Slips <span className="text-label-3 font-normal">({slips.length})</span></span>
                        </button>
                        <div className={`space-y-3 pr-1 md:grow md:overflow-y-auto ${panes.slips ? '' : 'hidden md:block'}`}>
                            {slips.map(slip => {
                                const sum = slipSummary(slip.legs, config.stake);
                                const verdict = slipOutcome(slip.legs);
                                const over = slip.legs.length > config.maxLegs;
                                const under = slip.legs.length > 0 && sum.odds < config.targetOdds;
                                return (
                                    <div
                                        key={slip.id}
                                        onClick={() => setActiveId(slip.id)}
                                        onDragOver={e => e.preventDefault()}
                                        onDrop={e => {
                                            e.preventDefault();
                                            addLeg(slip.id, candidates.find(c => c.api_id === drag));
                                            setDrag(null);
                                        }}
                                        className={`rounded-xl border p-2 transition-colors ${slip.id === activeSlip?.id
                                            ? 'border-accent ring-2 ring-accent/40 bg-accent-soft/40' : 'border-separator-2'} ${
                                            drag ? 'border-dashed border-accent' : ''}`}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <input
                                                value={slip.name}
                                                onChange={e => renameSlip(slip.id, e.target.value)}
                                                className="text-sm font-medium border-b border-transparent focus:border-separator outline-none w-28"
                                            />
                                            <span className="text-xs text-label-3">{slip.legs.length}/{config.maxLegs} legs</span>
                                            <div className="grow" />
                                            <button
                                                onClick={e => { e.stopPropagation(); removeSlip(slip.id); }}
                                                title="Delete slip"
                                                aria-label="Delete slip"
                                                className="cursor-pointer shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full text-label-3 text-lg leading-none hover:bg-fill hover:text-miss"
                                            >
                                                &times;
                                            </button>
                                        </div>
                                        {slip.legs.map(l => {
                                            // A leg's own date tells "dropped off today's view" (dim + gone)
                                            // apart from "belongs to another day" (fine - show its date).
                                            const sameDay = !l.date || l.date === date;
                                            const dropped = sameDay && !live.has(l.api_id);
                                            return (
                                            <div
                                                key={l.api_id}
                                                className={`flex items-center gap-2 text-xs py-1 ${dropped ? 'opacity-50' : ''} ${
                                                    verdict.broken.includes(l.api_id) ? 'text-miss' : ''}`}
                                            >
                                                <span className="truncate grow" title={l.fixture}>{l.fixture}</span>
                                                {dropped && (
                                                    <span className="text-hot" title="No longer a tip on today's view">gone</span>
                                                )}
                                                {/* Shared-day leg → kickoff time; other-day leg → short date */}
                                                {sameDay
                                                    ? (l.time && <span className="text-label-3 tabular-nums" title="Kickoff">{l.time}</span>)
                                                    : <span className="text-label-3" title={`From ${l.date}`}>{_shortDate(l.date)}</span>}
                                                <span className="font-medium whitespace-nowrap">{l.market}</span>
                                                <span className="tabular-nums">{l.price?.toFixed(2) ?? '—'}</span>
                                                {l.outcome === 'hit' && <span className="text-hit font-bold">✓</span>}
                                                {l.outcome === 'miss' && <span className="text-miss font-bold">✗</span>}
                                                <span className="tabular-nums text-label-2">{_pct(l.prob)}</span>
                                                <button
                                                    onClick={e => { e.stopPropagation(); removeLeg(slip.id, l.api_id); }}
                                                    aria-label={`Remove ${l.fixture}`}
                                                    className="cursor-pointer shrink-0 w-7 h-7 inline-flex items-center justify-center rounded-full text-label-3 leading-none hover:bg-fill hover:text-miss"
                                                >
                                                    &times;
                                                </button>
                                            </div>
                                            );
                                        })}
                                        {!slip.legs.length && (
                                            <div className="text-xs text-label-3 py-1">Drag tips here (or use their + button).</div>
                                        )}
                                        <div className="mt-1 pt-1 border-t border-hairline text-xs">
                                            {verdict.state === 'won' && (
                                                <OutcomePill tone="won">WON · paid {sum.payout.toFixed(2)}</OutcomePill>
                                            )}
                                            {verdict.state === 'lost' && (
                                                <OutcomePill tone="lost">
                                                    LOST · {verdict.broken.length} leg{verdict.broken.length > 1 ? 's' : ''} broke it
                                                </OutcomePill>
                                            )}
                                            {verdict.state === 'open' && verdict.settled > 0 && (
                                                <OutcomePill tone="open">alive · {verdict.settled}/{verdict.total} settled</OutcomePill>
                                            )}
                                            {/* Uniform metrics grid (shared shape with the footer totals) */}
                                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 mt-1 tabular-nums">
                                                <span>odds <b>{sum.odds.toFixed(2)}</b></span>
                                                <span>payout <b>{sum.payout.toFixed(2)}</b></span>
                                                <span title="Product of the legs' calibrated win estimates (assumes independence)">
                                                    survival <b>{_pct(sum.survival)}</b>
                                                </span>
                                                <span className={sum.ev >= 0 ? 'text-hit' : 'text-miss'}>
                                                    EV <b>{sum.ev >= 0 ? '+' : ''}{(sum.ev * 100).toFixed(1)}%</b>
                                                </span>
                                            </div>
                                            {(under || over) && (
                                                <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-0.5">
                                                    {under && <span className="text-hot">⚠ below target {config.targetOdds}</span>}
                                                    {over && <span className="text-miss">⚠ over {config.maxLegs} legs</span>}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                            {!slips.length && (
                                <div className="text-sm text-label-3 border border-dashed border-separator rounded p-4 text-center">
                                    No slips yet - "✨ Fill from top" builds one from the best-ranked tips.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
                {/* Sticky summary footer: the running slip totals + note stay
                    pinned to the modal bottom even as the panes scroll (mobile
                    especially), so the P/L is always in view. */}
                {totals.slips > 0 && (
                    <div className="shrink-0 mt-2 pt-2 border-t border-separator-2 text-xs">
                        <div className="flex items-center gap-2 mb-1">
                            <span className="font-medium text-label-2">
                                {totals.slips} slip{totals.slips === 1 ? '' : 's'}
                            </span>
                            <span className="text-label-3">
                                {totals.won} won · {totals.lost} lost{totals.open ? ` · ${totals.open} open` : ''}
                            </span>
                        </div>
                        {/* Same grid shape as each slip's metrics (D4 uniform totals) */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-0.5 tabular-nums font-medium">
                            <span>staked <b>{totals.staked.toFixed(2)}</b></span>
                            <span>returned <b>{totals.returned.toFixed(2)}</b></span>
                            {totals.open > 0 && (
                                <span
                                    className="text-accent"
                                    title="What the open (unsettled) slips would pay if every pending leg landed"
                                >
                                    potential <b>{totals.potential.toFixed(2)}</b>
                                </span>
                            )}
                            <span
                                className={totals.profit >= 0 ? 'text-hit' : 'text-miss'}
                                title="Returned minus stakes of settled slips - open slips' stakes are not yet lost"
                            >
                                P/L <b>{totals.profit >= 0 ? '+' : ''}{totals.profit.toFixed(2)}</b>
                            </span>
                        </div>
                    </div>
                )}
                <p className="shrink-0 text-xs text-label-3 mt-1">
                    Survival multiplies each leg's calibrated win estimate (independence assumption) -
                    an expectation over many slips, not a promise for this one.
                </p>
        </Sheet>
    );
}
