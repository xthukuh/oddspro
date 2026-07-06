import { useEffect, useMemo, useState } from 'react';
import { estimateLegProb, magicSortRows, slipOutcome, slipSummary, tipView } from '../../../src/db/magic-rules.js';

// Betslip playground: build VIRTUAL multi-bet slips from the day's tips -
// drag a candidate onto a slip card (or use its + button), tune the
// stake / leg / odds limits, and read combined odds, potential payout and
// the calibrated survival estimate per slip. Client-only simulation, no
// real betting. Settled tips are candidates too (backtest mode: past dates
// replay at frozen tip prices and grade their slips WON/LOST). Candidates
// come pre-ranked by the active magic strategy (blend confidence when
// none), so "Fill from top" is a one-click best slip.

const LS_SLIPS = 'oddspro.betslips';
const DEFAULT_CONFIG = { stake: 100, maxLegs: 4, minOdds: 2.5, hideUsed: true };

const _id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const _pct = v => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

// Stored slips survive reloads within the same table date; a date change
// keeps the limits but clears the slips (their fixtures are gone anyway).
function _loadSlips(date) {
    try {
        const v = JSON.parse(localStorage.getItem(LS_SLIPS));
        const config = { ...DEFAULT_CONFIG, ...(v && typeof v.config === 'object' ? v.config : {}) };
        const slips = v?.date === date && Array.isArray(v.slips)
            ? v.slips.filter(s => s && typeof s === 'object' && Array.isArray(s.legs))
            : [];
        return { config, slips };
    } catch {
        return { config: { ...DEFAULT_CONFIG }, slips: [] };
    }
}

function _numInput(value, { min, max, int }) {
    let n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (int) n = Math.round(n);
    return Math.min(max, Math.max(min, n));
}

export default function BetslipPlayground({ rows, magic, calibration, date, onClose }) {
    const [{ config, slips }, setState] = useState(() => _loadSlips(date));
    const [activeId, setActiveId] = useState(() => _loadSlips(date).slips[0]?.id ?? null);
    const [drag, setDrag] = useState(null); // dragged candidate api_id

    // Persist on every change (paired-save idiom)
    useEffect(() => {
        localStorage.setItem(LS_SLIPS, JSON.stringify({ date, config, slips }));
    }, [date, config, slips]);

    // Slip candidates: the table's non-vetoed tips - one per canonical
    // fixture - ranked by the active magic strategy. Settled tips are
    // included (backtest mode: past dates replay at their frozen tip
    // prices); their outcome grades the slip.
    const candidates = useMemo(() => {
        const seen = new Set();
        const unique = [];
        for (const r of rows) {
            if (seen.has(r.api_id)) continue;
            seen.add(r.api_id);
            if (r.tip_market != null && r.tip_ai_verdict !== 'veto') unique.push(r);
        }
        return magicSortRows(unique, magic?.id ?? 'confidence', magic?.calibration ?? calibration).map(r => ({
            api_id: r.api_id,
            fixture: r.fixture,
            market: r.tip_market,
            price: r.tip_price,
            prob: estimateLegProb(tipView(r), calibration),
            outcome: r.tip_outcome ?? null,
        }));
    }, [rows, magic, calibration]);
    const live = useMemo(() => new Set(candidates.map(c => c.api_id)), [candidates]);

    // Tips already sitting on any slip: "Fill from top" ALWAYS skips them, so
    // each click autogenerates the next distinct slip (ranks 1-4, then 5-8, …)
    // until the day's tips are exhausted; the Hide-used toggle additionally
    // hides them from the list below. Removing a slip/leg frees its tips.
    const usedIds = useMemo(() => new Set(slips.flatMap(s => s.legs.map(l => l.api_id))), [slips]);
    const unused = useMemo(() => candidates.filter(c => !usedIds.has(c.api_id)), [candidates, usedIds]);
    const shown = config.hideUsed ? unused : candidates;

    const setConfig = (key, raw, bounds) => {
        const n = _numInput(raw, bounds);
        if (n != null) setState(s => ({ ...s, config: { ...s.config, [key]: n } }));
    };
    const setSlips = fn => setState(s => ({ ...s, slips: fn(s.slips) }));

    const addSlip = (legs = []) => {
        const slip = { id: _id(), name: `Slip ${slips.length + 1}`, legs };
        setSlips(prev => [...prev, slip]);
        setActiveId(slip.id);
    };
    const fillFromTop = () => addSlip(unused.slice(0, config.maxLegs));
    const removeSlip = id => {
        setSlips(prev => prev.filter(s => s.id !== id));
        if (activeId === id) setActiveId(null);
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

    return (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
            <div
                className="bg-white rounded-lg shadow-xl w-full max-w-5xl max-h-[85vh] flex flex-col p-5"
                onClick={e => e.stopPropagation()}
            >
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
                        ['Min odds', 'minOdds', { min: 1, max: 1000 }, 'w-20'],
                    ].map(([label, key, bounds, w]) => (
                        <label key={key} className="flex flex-col gap-1 text-xs text-slate-600">
                            {label}
                            <input
                                type="number"
                                value={config[key]}
                                min={bounds.min}
                                step={key === 'maxLegs' ? 1 : 0.1}
                                onChange={e => setConfig(key, e.target.value, bounds)}
                                className={`${w} border border-slate-300 rounded px-2 py-1 text-sm`}
                            />
                        </label>
                    ))}
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
                        onClick={() => addSlip()}
                        className="cursor-pointer px-3 py-1.5 rounded border border-slate-300 text-sm hover:bg-slate-50"
                    >
                        + New slip
                    </button>
                    <button
                        onClick={fillFromTop}
                        disabled={!unused.length}
                        title={unused.length
                            ? `New slip from the ${Math.min(config.maxLegs, unused.length)} top-ranked unused tips (${unused.length} left)`
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
                                ({shown.length}{candidates.length > shown.length ? ` · ${candidates.length - shown.length} used hidden` : ''}, best first{magic ? ' · magic' : ''})
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
                                const under = slip.legs.length > 0 && sum.odds < config.minOdds;
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
                                            {under && <span className="text-amber-600">⚠ below min odds {config.minOdds}</span>}
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
