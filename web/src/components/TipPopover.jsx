import { useEffect } from 'react';

// Tip justification popover: the persisted bestTip breakdown rendered as a
// deterministic reasoning ledger - blend components with their effective
// (renormalized) weights, evidence sample sizes, runner-up candidates - plus
// the over-2.5 gate audit and any AI verdicts. Opened by clicking a tip
// cell; closes on Esc or any press outside (same idiom as MultiSelect).

const _pct = v => (v == null ? '-' : `${Math.round(v * 100)}%`);

// Gate-audit values arrive raw (e.g. an unrounded implied probability)
const _num = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v ?? '-');

const MARKET_LABEL = {
    1: 'Home win', X: 'Draw', 2: 'Away win',
    '1X': 'Home win or draw', X2: 'Draw or away win', 12: 'Home or away win',
};
function _label(market) {
    if (MARKET_LABEL[market]) return MARKET_LABEL[market];
    const m = /^([OU]) (\d+(?:\.\d+)?)$/.exec(market ?? '');
    return m ? `${m[1] === 'O' ? 'Over' : 'Under'} ${m[2]} total goals` : market;
}

// Human phrasing for a stored tip_skip_reason marker
export function skipLabel(reason) {
    if (!reason) return null;
    if (reason === 'no_pick') return 'No qualifying pick - nothing cleared the price and confidence floors.';
    if (reason === 'no_markets') return 'Insufficient data - no full odds market group available.';
    if (reason.startsWith('insufficient_history')) {
        const detail = reason.replace(/^insufficient_history:?\s*/, '');
        return `Insufficient data - not enough recent games on record${detail ? ` (${detail})` : ''}.`;
    }
    if (reason.startsWith('context')) {
        return 'Not tipped - friendly / youth / reserve game, rolling form is not valid evidence here.';
    }
    return `No tip - ${reason}`;
}

function Section({ title, children }) {
    return (
        <div className="mt-2 pt-2 border-t border-slate-100">
            <div className="font-medium text-slate-500 uppercase tracking-wide text-[10px] mb-1">{title}</div>
            {children}
        </div>
    );
}

// Structured v2 AI review extras: the model's own probability estimate,
// per-check findings (context / team news / market) and grounding citations.
// Pre-v2 rows carry only the one-line reason and render nothing here.
function AiChecks({ review }) {
    if (!review) return null;
    const checks = review.checks && typeof review.checks === 'object'
        ? Object.entries(review.checks).filter(([, v]) => v)
        : [];
    const sources = Array.isArray(review.sources) ? review.sources.filter(s => s?.uri) : [];
    if (review.probability == null && !checks.length && !sources.length) return null;
    return (
        <div className="mt-1 space-y-0.5">
            {review.probability != null && (
                <div className="flex justify-between gap-2 text-slate-600">
                    <span>AI's own probability</span>
                    <span className="tabular-nums">{_pct(review.probability)}</span>
                </div>
            )}
            {checks.map(([k, v]) => (
                <div key={k} className="text-slate-500">
                    <span className="text-slate-600 capitalize">{k.replace(/_/g, ' ')}:</span> {v}
                </div>
            ))}
            {sources.length > 0 && (
                <div className="text-slate-400">
                    Sources:{' '}
                    {sources.map((s, i) => (
                        <span key={i}>
                            {i > 0 && ', '}
                            <a href={s.uri} target="_blank" rel="noreferrer" className="underline hover:text-slate-600">
                                {s.title || 'source'}
                            </a>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

// One blend component line: probability x effective weight
function Blend({ name, prob, weight, note }) {
    return (
        <div className="flex justify-between gap-2">
            <span className="text-slate-600">{name}{note ? <span className="text-slate-400"> - {note}</span> : null}</span>
            <span className="tabular-nums">
                {prob == null ? <span className="text-slate-400">no evidence</span> : <>{_pct(prob)} <span className="text-slate-400">x {weight}</span></>}
            </span>
        </div>
    );
}

export default function TipPopover({ row, x, y, onClose }) {
    useEffect(() => {
        const key = e => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', key);
        return () => document.removeEventListener('keydown', key);
    }, [onClose]);

    const b = row.tip_breakdown;
    const vetoed = row.tip_ai_verdict === 'veto';
    const signals = Array.isArray(row.hot_signals) ? row.hot_signals : [];
    // Clamp near the click but inside the viewport
    const style = {
        top: Math.max(8, Math.min(y + 8, window.innerHeight - 400)),
        left: Math.max(8, Math.min(x + 8, window.innerWidth - 340)),
    };

    return (
        <>
        {/* Invisible dismiss overlay: a background click closes the popover and
            is swallowed here, so it can't fall through to a column header and
            trigger a sort. */}
        <div className="fixed inset-0 z-40" onClick={onClose} />
        <div
            style={style}
            className="fixed z-50 w-80 max-h-[25rem] overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-xl p-3 text-xs"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="font-medium text-slate-700">{row.fixture_api ?? row.fixture}</div>
                <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 cursor-pointer leading-none">✕</button>
            </div>

            {row.tip_market ? (
                <>
                    <div className={`mt-1 text-sm ${vetoed ? 'text-slate-400' : ''}`}>
                        <span className={`font-semibold ${vetoed ? 'line-through' : ''}`}>
                            {row.tip_market}{row.tip_price != null ? ` @ ${row.tip_price.toFixed(2)}` : ''}
                        </span>
                        <span className="text-slate-500"> - {_label(row.tip_market)}</span>
                        {row.tip_outcome === 'hit' && <span className="text-emerald-600 font-bold"> ✓ hit</span>}
                        {row.tip_outcome === 'miss' && <span className="text-rose-600 font-bold"> ✗ miss</span>}
                    </div>
                    {b ? (
                        <Section title={`Confidence blend - ${_pct(row.tip_confidence)}`}>
                            <Blend name="Market" prob={b.market_prob} weight={b.weights?.market} note="vig-removed price" />
                            <Blend name="Stats" prob={b.stats_prob} weight={b.weights?.stats} note="rolling form" />
                            <Blend name="API" prob={b.api_prob} weight={b.weights?.api} note="API-Football" />
                            {b.samples && (
                                <div className="mt-1 text-slate-500">
                                    Evidence: home last {b.samples.home_n}, away last {b.samples.away_n}, H2H {b.samples.h2h_n} meetings
                                </div>
                            )}
                        </Section>
                    ) : (
                        <div className="mt-1 text-slate-400">No stored breakdown - this tip predates justification tracking.</div>
                    )}
                    {b?.runners_up?.length > 0 && (
                        <Section title="Runners-up">
                            {b.runners_up.map(r => (
                                <div key={r.market} className="flex justify-between gap-2 text-slate-600">
                                    <span>{r.market} @ {r.price?.toFixed ? r.price.toFixed(2) : r.price}</span>
                                    <span className="tabular-nums">{_pct(r.confidence)}</span>
                                </div>
                            ))}
                        </Section>
                    )}
                </>
            ) : (
                <div className="mt-1 text-slate-500">{skipLabel(row.tip_skip_reason) ?? 'No tip for this fixture.'}</div>
            )}

            {signals.length > 0 && (
                <Section title={`Over-2.5 gate audit${row.hot ? ' - 🔥 hot pick' : ''}`}>
                    {signals.map(s => (
                        <div key={s.key} className="flex justify-between gap-2">
                            <span className="text-slate-600">{s.key}</span>
                            <span className="tabular-nums">
                                {_num(s.value)} <span className="text-slate-400">/ {_num(s.threshold)}</span>{' '}
                                {s.pass ? <span className="text-emerald-600">✓</span> : <span className="text-rose-600">✗</span>}
                            </span>
                        </div>
                    ))}
                </Section>
            )}

            {(row.tip_ai_verdict || row.hot_reason) && (
                <Section title="AI review">
                    {row.tip_ai_verdict && (
                        <div className={vetoed ? 'text-rose-600' : 'text-slate-600'}>
                            Tip {row.tip_ai_verdict}{row.tip_ai_reason ? `: ${row.tip_ai_reason}` : ''}
                        </div>
                    )}
                    <AiChecks review={row.tip_ai_review} />
                    {row.hot_reason && <div className="text-slate-600 mt-1">Hot pick: {row.hot_reason}</div>}
                    <AiChecks review={row.hot_review} />
                </Section>
            )}
        </div>
        </>
    );
}
