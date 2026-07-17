import { useState } from 'react';
import Sheet, { SheetClose, PinToggle } from './Sheet.jsx';
import { useShowDetails } from '../details.js';

// Magic-sort sheet: pick one or more backtest-ranked tip-sorting strategies
// (GET /api/magic-sort) to reorder the table most-likely-to-win first. Stats
// shown are BACKTESTS over settled tips, not forecasts - labeled as such. Owns
// its own Sheet (like the other modals) so it can carry the standard pin toggle;
// the toolbar/overflow trigger owns open/close via `showMagic`.

const _pct = v => (v == null ? '-' : `${Math.round(v * 100)}%`);
const _roi = v => (v == null ? '-' : `${v >= 0 ? '+' : ''}${Math.round(v * 100)}%`);

const STATS_TITLE = 'What each number means (replayed on past days):\n'
    + '· slips - days a 4-game multi-bet built from this ranking\'s top picks won\n'
    + '· top picks - how often its highest-ranked tips actually won\n'
    + '· streak - wins in a row from the top of the list (average / best day)\n'
    + '· ROI - average profit per day, in stakes (+100% = doubled the stake)';

export default function MagicMenu({
    data, error, activeIds, onToggle, onClearMagic, onClose,
    signedIn, sureBets, sureCount, sureCap, slipSize, onSureBets, onTopSlip,
}) {
    // Session-aware: methodology prose + backtest numbers hide for guests
    const showDetails = useShowDetails();
    const strategies = data?.strategies ?? [];
    const sample = data?.sample;
    const active = new Set(activeIds ?? []);
    const [pinned, setPinned] = useState(false);

    return (
        <Sheet onClose={onClose} className="max-w-md" dismissable={!pinned}>
        <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
            <div className="flex items-center gap-3 px-6 pt-5 pb-2">
                <h2 className="text-[22px] font-extrabold tracking-tight">Magic sort</h2>
                <span className="text-[13px] text-label-2 hidden sm:inline">most-likely-to-win first</span>
                <div className="flex-1" />
                <PinToggle pinned={pinned} onToggle={() => setPinned(v => !v)} />
                <SheetClose onClose={onClose} />
            </div>
            {showDetails && (
                <p className="px-6 pb-3 text-[13px] text-label-2 leading-relaxed">
                    Tip rankings replayed against every settled day: build the top-4 slip each
                    strategy would have picked, settle it at real prices. Backtests, not forecasts.
                </p>
            )}
            <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2">
                {error && <div className="px-2 py-1 text-sm text-miss">{error}</div>}
                {!error && !data && <div className="px-2 py-1 text-sm text-label-3">Loading…</div>}
                {strategies.map(s => (
                    <button
                        key={s.id}
                        onClick={() => onToggle(s.id)}
                        className={`cursor-pointer block w-full text-left px-3 py-2.5 rounded-xl hover:bg-fill ${active.has(s.id) ? 'bg-accent-soft' : ''}`}
                    >
                        <span className="flex items-center text-[15px]">
                            <span className="font-semibold text-label">{s.label}</span>
                            {showDetails && s.low_sample && (
                                <span className="ml-2 text-xs text-hot" title={`Fewer than ${sample?.min_days ?? 5} replayable days - treat with caution`}>
                                    ⚠ small sample
                                </span>
                            )}
                            {active.has(s.id) && <span className="ml-auto text-accent">✓</span>}
                        </span>
                        {showDetails && (
                            <span className="block text-[12.5px] text-label-2 tabular-nums" title={STATS_TITLE}>
                                slips {s.stats.survived}/{s.stats.days} ({_pct(s.stats.survival)})
                                {' · '}top picks {s.stats.quartile.hits}/{s.stats.quartile.n} ({_pct(s.stats.quartile.rate)})
                                {' · '}streak {s.stats.streak?.avg ?? '-'}/{s.stats.streak?.best ?? '-'}
                                {' · '}ROI {_roi(s.stats.roi)}
                            </span>
                        )}
                    </button>
                ))}
                {data && !strategies.length && (
                    <div className="px-2 py-1 text-sm text-label-3">No settled tips to rank yet.</div>
                )}
                {/* Sure bets (2026-07-17 spec) - a FILTER, not a sort: the daily
                    top-10 safe list. Signed-in only: guest rows are redacted
                    (no tip_breakdown), so the gates cannot evaluate. */}
                <div className="mt-2 pt-2 border-t border-separator-2">
                    {signedIn ? (
                        <div className={`px-3 py-2.5 rounded-xl ${sureBets ? 'bg-accent-soft' : ''}`}>
                            <button onClick={() => onSureBets(!sureBets)} className="cursor-pointer block w-full text-left">
                                <span className="flex items-center text-[15px]">
                                    <span className="font-semibold text-label">⭐ Sure bets</span>
                                    <span className="ml-2 text-xs text-label-2 tabular-nums">{sureCount} of {sureCap} today</span>
                                    {sureBets && <span className="ml-auto text-accent">✓</span>}
                                </span>
                                <span className="block text-[12.5px] text-label-2">
                                    Filter the table to the day's safest list, ranked by calibrated win chance.
                                </span>
                            </button>
                            {sureBets && sureCount === 0 && (
                                <div className="mt-1 text-xs text-hot">No sure bets today - no fixture passed the safety gates.</div>
                            )}
                            <div className="mt-1.5 flex items-center gap-3">
                                <button
                                    onClick={onTopSlip}
                                    disabled={!sureCount}
                                    title={`Seed a slip with the top ${slipSize} legs and open the playground`}
                                    className="cursor-pointer text-[13px] font-semibold text-accent hover:underline disabled:opacity-50 disabled:cursor-default disabled:no-underline"
                                >
                                    Top-{slipSize} slip
                                </button>
                                {showDetails && (
                                    <span className="text-xs text-label-3" title="Live replay numbers - survival odds, not profit. Flat-stake EV stays ~ -vig.">
                                        legs ~72-76% · 3-leg slip lands ~40% of days
                                    </span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="px-3 py-2.5 text-[13px] text-label-2">
                            ⭐ Sure bets - sign in to unlock the daily top-10 safe list.
                        </div>
                    )}
                </div>
            </div>
            <div className="px-5 py-3 border-t border-separator-2">
                <button
                    onClick={() => { onClearMagic(); onClose(); }}
                    disabled={!active.size}
                    className="cursor-pointer text-[15px] text-label-2 hover:text-label disabled:opacity-50 disabled:cursor-default"
                >
                    Clear magic sorts
                </button>
                {showDetails && sample && (
                    <div className="pt-1 text-xs text-label-3">
                        {sample.settled} settled tips · {sample.days} day{sample.days === 1 ? '' : 's'}
                        {!sample.sufficient && (
                            <span className="block text-hot">
                                ⚠ Under {sample.min_days} replayable days - rankings firm up as results accrue.
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
        </Sheet>
    );
}
