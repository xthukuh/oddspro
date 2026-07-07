import { useEffect, useMemo, useRef, useState } from 'react';
import { buildSlips, estimateLegProb, magicSortRows, slipOutcome, slipSummary, slipTotals, tipView } from '../../../src/db/magic-rules.js';
import { orderRows } from '../ordering.js';
import NumberInput from './NumberInput.jsx';

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

// Stored slips survive reloads within the same table date; a date change
// keeps the limits but clears the slips (their fixtures are gone anyway).
function _loadSlips(date) {
    try {
        const v = JSON.parse(localStorage.getItem(LS_SLIPS));
        const config = { ...DEFAULT_CONFIG, ...(v && typeof v.config === 'object' ? v.config : {}) };
        // Migrate the old "Min odds" limit to "Target odds" (same number)
        if (config.minOdds != null && v?.config?.targetOdds == null) config.targetOdds = config.minOdds;
        delete config.minOdds;
        const slips = v?.date === date && Array.isArray(v.slips)
            ? v.slips.filter(s => s && typeof s === 'object' && Array.isArray(s.legs))
            : [];
        return { config, slips };
    } catch {
        return { config: { ...DEFAULT_CONFIG }, slips: [] };
    }
}

// Wrap buildSlips leg-arrays into named slip objects numbered from `start`
const _wrap = (legArrays, start) => legArrays.map((legs, i) => ({ id: _id(), name: `Slip ${start + i}`, legs }));

export default function BetslipPlayground({ rows, chain, cal, columns, calibration, date, onClose }) {
    const hasMagic = chain?.some(e => e.type === 'magic');
    const [{ config, slips }, setState] = useState(() => _loadSlips(date));
    const [activeId, setActiveId] = useState(() => _loadSlips(date).slips[0]?.id ?? null);
    const [drag, setDrag] = useState(null); // dragged candidate api_id

    // Persist on every change (paired-save idiom)
    useEffect(() => {
        localStorage.setItem(LS_SLIPS, JSON.stringify({ date, config, slips }));
    }, [date, config, slips]);

    // The modal no longer closes on backdrop click (slips are easy to lose by
    // a stray click) - Escape and the x button are the close paths.
    useEffect(() => {
        const onKey = e => e.key === 'Escape' && onClose();
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

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
        }));
    }, [rows, chain, columns, cal, calibration]);
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
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/50 p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col p-5">
                <div className="flex items-center mb-3">
                    <h2 className="text-lg font-semibold">Betslip playground</h2>
                    <span className="ml-3 text-xs text-slate-400">virtual slips - nothing is placed</span>
                    <div className="grow" />
                    <button onClick={onClose} className="text-slate-500 hover:text-slate-800 text-xl leading-none">&times;</button>
                </div>

                <div className="flex flex-wrap items-end gap-3 mb-3 text-sm">
                    {[
                        ['Stake / slip', 'stake', { min: 1, max: 1_000_000 }, 'w-24'],
                        ['Max legs', 'maxLegs', { min: 1, max: 20, int: true }, 'w-16'],
                        ['Target odds', 'targetOdds', { min: 1, max: 1000 }, 'w-20',
                            'Autogeneration closes a slip once its combined odds reach this'],
                        ['Max slips', 'maxSlips', { min: 0, max: 100, int: true }, 'w-16',
                            'Cap the number of slips autogeneration creates (0 = unlimited)'],
                    ].map(([label, key, bounds, w, hint]) => (
                        <label key={key} className="flex flex-col gap-1 text-xs text-slate-600" title={hint}>
                            {label}
                            <NumberInput
                                value={config[key]}
                                onCommit={n => setConfig(key, n)}
                                min={bounds.min}
                                max={bounds.max}
                                int={bounds.int}
                                className={`${w} border border-slate-300 rounded px-2 py-1 text-sm`}
                            />
                        </label>
                    ))}
                    <label
                        className="flex items-center gap-1.5 pb-1.5 text-xs text-slate-600 cursor-pointer select-none"
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
                        className="flex items-center gap-1.5 pb-1.5 text-xs text-slate-600 cursor-pointer select-none"
                        title="Hide tips already placed on a slip from the list below (Fill from top always skips them)"
                    >
                        <input
                            type="checkbox"
                            checked={config.hideUsed}
                            onChange={() => setState(s => ({ ...s, config: { ...s.config, hideUsed: !s.config.hideUsed } }))}
                        />
                        Hide used
                    </label>
                    <div className="grow" />
                    <button
                        onClick={clearSlips}
                        disabled={!slips.length}
                        title="Remove all slips at once (their tips become available again)"
                        className="cursor-pointer px-3 py-1.5 rounded border border-slate-300 text-sm text-slate-600 hover:bg-red-50 hover:border-red-300 hover:text-red-700 disabled:opacity-50"
                    >
                        Clear slips
                    </button>
                    <button
                        onClick={() => addSlip()}
                        className="cursor-pointer px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                    >
                        + New slip
                    </button>
                    <button
                        onClick={fillFromTop}
                        disabled={!plannedFill.length}
                        title={plannedFill.length
                            ? `Autogenerate ${plannedFill.length} slip${plannedFill.length > 1 ? 's' : ''} from ${unused.length} unused tip${unused.length > 1 ? 's' : ''} (best first, ≤${config.maxLegs} legs, target ${config.targetOdds})`
                            : 'All tips are already on slips'}
                        className="cursor-pointer px-3 py-1.5 rounded bg-sky-600 text-white text-sm hover:bg-sky-500 disabled:opacity-50"
                    >
                        ✨ Fill from top
                    </button>
                </div>

                <div className="flex gap-4 min-h-0 grow">
                    {/* Candidates: the view's tips ranked best-first (settled included) */}
                    <div className="w-2/5 min-w-0 flex flex-col">
                        <h3 className="text-sm font-medium text-slate-700 mb-1">
                            Tips <span className="text-slate-400 font-normal">
                                ({shown.length}{candidates.length > shown.length ? ` · ${candidates.length - shown.length} used hidden` : ''}, best first{hasMagic ? ' · magic' : ''})
                            </span>
                        </h3>
                        <div className="grow overflow-y-auto border border-slate-200 rounded p-1">
                            {shown.map(c => (
                                <div
                                    key={c.api_id}
                                    draggable
                                    onDragStart={() => setDrag(c.api_id)}
                                    onDragEnd={() => setDrag(null)}
                                    className={`flex items-center gap-2 px-1.5 py-1 rounded text-xs cursor-grab select-none hover:bg-slate-50 ${
                                        drag === c.api_id ? 'opacity-40' : ''}`}
                                >
                                    <button
                                        onClick={() => activeSlip && addLeg(activeSlip.id, c)}
                                        disabled={!activeSlip}
                                        title={activeSlip ? `Add to ${activeSlip.name}` : 'Create a slip first'}
                                        className="cursor-pointer px-1.5 rounded border border-slate-300 text-slate-600 hover:bg-sky-50 disabled:opacity-40"
                                    >
                                        +
                                    </button>
                                    <span className="truncate grow" title={c.fixture}>{c.fixture}</span>
                                    <span className="font-medium whitespace-nowrap">{c.market}</span>
                                    <span className="tabular-nums">{c.price?.toFixed(2) ?? '—'}</span>
                                    {c.outcome === 'hit' && <span className="text-emerald-600 font-bold">✓</span>}
                                    {c.outcome === 'miss' && <span className="text-rose-600 font-bold">✗</span>}
                                    <span className="tabular-nums text-slate-500" title="Calibrated win estimate">{_pct(c.prob)}</span>
                                </div>
                            ))}
                            {!shown.length && (
                                <div className="p-2 text-sm text-slate-400">
                                    {candidates.length ? 'All tips are on slips.' : 'No tips on this view.'}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Slips: drop targets */}
                    <div className="w-3/5 min-w-0 flex flex-col">
                        <h3 className="text-sm font-medium text-slate-700 mb-1">Slips</h3>
                        <div className="grow overflow-y-auto space-y-3 pr-1">
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
                                        className={`rounded border p-2 ${slip.id === activeSlip?.id
                                            ? 'border-sky-400 ring-1 ring-sky-200' : 'border-slate-200'} ${
                                            drag ? 'border-dashed border-sky-400' : ''}`}
                                    >
                                        <div className="flex items-center gap-2 mb-1">
                                            <input
                                                value={slip.name}
                                                onChange={e => renameSlip(slip.id, e.target.value)}
                                                className="text-sm font-medium border-b border-transparent focus:border-slate-300 outline-none w-32"
                                            />
                                            <span className="text-xs text-slate-400">{slip.legs.length}/{config.maxLegs} legs</span>
                                            <div className="grow" />
                                            <button
                                                onClick={() => removeSlip(slip.id)}
                                                title="Delete slip"
                                                className="cursor-pointer text-slate-400 hover:text-red-600"
                                            >
                                                &times;
                                            </button>
                                        </div>
                                        {slip.legs.map(l => (
                                            <div
                                                key={l.api_id}
                                                className={`flex items-center gap-2 text-xs py-0.5 ${live.has(l.api_id) ? '' : 'opacity-50'} ${
                                                    verdict.broken.includes(l.api_id) ? 'text-rose-600' : ''}`}
                                            >
                                                <span className="truncate grow" title={l.fixture}>{l.fixture}</span>
                                                {!live.has(l.api_id) && (
                                                    <span className="text-amber-600" title="No longer a tip on this view">gone</span>
                                                )}
                                                <span className="font-medium whitespace-nowrap">{l.market}</span>
                                                <span className="tabular-nums">{l.price?.toFixed(2) ?? '—'}</span>
                                                {l.outcome === 'hit' && <span className="text-emerald-600 font-bold">✓</span>}
                                                {l.outcome === 'miss' && <span className="text-rose-600 font-bold">✗</span>}
                                                <span className="tabular-nums text-slate-500">{_pct(l.prob)}</span>
                                                <button
                                                    onClick={() => removeLeg(slip.id, l.api_id)}
                                                    className="cursor-pointer text-slate-400 hover:text-red-600"
                                                >
                                                    &times;
                                                </button>
                                            </div>
                                        ))}
                                        {!slip.legs.length && (
                                            <div className="text-xs text-slate-400 py-1">Drag tips here (or use their + button).</div>
                                        )}
                                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 pt-1 border-t border-slate-100 text-xs tabular-nums">
                                            {verdict.state === 'won' && (
                                                <span className="text-emerald-700 font-semibold">WON · paid {sum.payout.toFixed(2)}</span>
                                            )}
                                            {verdict.state === 'lost' && (
                                                <span className="text-rose-600 font-semibold">
                                                    LOST · {verdict.broken.length} leg{verdict.broken.length > 1 ? 's' : ''} broke it
                                                </span>
                                            )}
                                            {verdict.state === 'open' && verdict.settled > 0 && (
                                                <span className="text-slate-500">alive · {verdict.settled}/{verdict.total} settled</span>
                                            )}
                                            <span>odds <b>{sum.odds.toFixed(2)}</b></span>
                                            <span>payout <b>{sum.payout.toFixed(2)}</b></span>
                                            <span title="Product of the legs' calibrated win estimates (assumes independence)">
                                                survival <b>{_pct(sum.survival)}</b>
                                            </span>
                                            <span className={sum.ev >= 0 ? 'text-emerald-700' : 'text-red-600'}>
                                                EV <b>{sum.ev >= 0 ? '+' : ''}{(sum.ev * 100).toFixed(1)}%</b>
                                            </span>
                                            {under && <span className="text-amber-600">⚠ below target {config.targetOdds}</span>}
                                            {over && <span className="text-red-600">⚠ over {config.maxLegs} legs</span>}
                                        </div>
                                    </div>
                                );
                            })}
                            {!slips.length && (
                                <div className="text-sm text-slate-400 border border-dashed border-slate-300 rounded p-4 text-center">
                                    No slips yet - "✨ Fill from top" builds one from the best-ranked tips.
                                </div>
                            )}
                        </div>
                        {totals.slips > 0 && (
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 mt-2 pt-2 border-t border-slate-200 text-xs tabular-nums font-medium">
                                <span className="text-slate-600">
                                    {totals.slips} slip{totals.slips === 1 ? '' : 's'}
                                    <span className="text-slate-400 font-normal">
                                        {' '}({totals.won} won · {totals.lost} lost{totals.open ? ` · ${totals.open} open` : ''})
                                    </span>
                                </span>
                                <span>staked <b>{totals.staked.toFixed(2)}</b></span>
                                <span>returned <b>{totals.returned.toFixed(2)}</b></span>
                                {totals.open > 0 && (
                                    <span
                                        className="text-sky-700"
                                        title="What the open (unsettled) slips would pay if every pending leg landed"
                                    >
                                        potential <b>{totals.potential.toFixed(2)}</b>
                                    </span>
                                )}
                                <span
                                    className={totals.profit >= 0 ? 'text-emerald-700' : 'text-red-600'}
                                    title="Returned minus stakes of settled slips - open slips' stakes are not yet lost"
                                >
                                    P/L <b>{totals.profit >= 0 ? '+' : ''}{totals.profit.toFixed(2)}</b>
                                </span>
                            </div>
                        )}
                        <p className="text-xs text-slate-400 mt-2">
                            Survival multiplies each leg's calibrated win estimate (independence assumption) -
                            an expectation over many slips, not a promise for this one.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
