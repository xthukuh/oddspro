// Client-sorted datatable: fixed base columns + selected market and STATS
// columns. Click a header to sort descending first (shift-click chains
// multi-sort); the whole selection is loaded, so sorting never hits the API.
// Sticky chrome: the header row pins to the top, and ONE consolidated summary
// column (Score / Tip / Magic, colour-coded) pins left only while the real Tip
// column is scrolled out of view.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sortValue } from '../sortValues.js';
import { orderRows } from '../ordering.js';
// Shared pure scorer (also used server-side) - vite's fs.allow covers the
// out-of-root import; one implementation, no client/server drift.
import { scoreTip, STRATEGIES } from '../../../src/db/magic-rules.js';
// Pure settler (zero-import) - grades a runner-up market from the final score
// (the settle pass only stores the CHOSEN tip's outcome). tipHitSafe never
// throws (unknown key -> null) and returns 'void' for a DNB push, so the
// runner-up tick matches the chosen-tip pill's semantics.
import { tipHitSafe } from '../../../src/db/tip-rules.js';
import TipPopover, { skipLabel } from './TipPopover.jsx';
import { track } from '../track.js';
import { EV } from '../trackEvents.js';
import Tooltip from './Tooltip.jsx';
import BulkActionsMenu from './BulkActionsMenu.jsx';
import { prioritizeSelectedRows } from '../filterValues.js';
import { IconSpinner } from './icons.jsx';
import { BASE_COLUMNS } from '../baseColumns.js';
import { filterHint } from '../columns.js';
// Re-exported so existing importers (App, SettingsModal) keep their path.
export { BASE_COLUMNS } from '../baseColumns.js';

// Distinct, non-semantic badge hues (AX4): blue vs violet, so a provider chip
// never collides with hit(green)/accent(teal)/hot(orange)/miss(red). New
// bookmakers fall back to a neutral fill.
const PROVIDER_STYLE = {
    betpawa: 'bg-provider-a/15 text-provider-a',
    betika: 'bg-provider-b/15 text-provider-b',
};

// Two alternating row tones cycled by canonical fixture (api_id) in
// first-appearance order: the same fixture shown once per provider shares a
// tone, adjacent fixtures always differ. Opaque classes on purpose - the
// sticky Score cell reuses them to cover content scrolling underneath.
const ROW_TINTS = ['bg-surface', 'bg-surface-2'];

// Header abbreviations (space) + definitions (header tooltip). Column keys
// missing here keep their catalog label and get the sort hint only.
const HEADER_META = {
    no: { info: 'Row number in the current order. Sort by it, or freeze it with "Pin position" in Settings so re-sorting doesn\'t renumber.' },
    start_time: { info: 'Kickoff time (with the fixture id) - hover a cell for the full date & match details' },
    fixture: { info: 'Bookmaker match name (links to the bookmaker page)' },
    provider: { info: 'Bookmaker' },
    score: { info: 'Final score (home-away), canonical API-Football result' },
    tip: { info: 'Safest bettable outcome + how confident we are - 🔥 marks a likely 3+ goals game. Click any tip for the reasoning in plain words' },
    status: { info: 'Fixture status - hover a cell for the odds-refresh & betting-closed times' },
    league: { info: 'Country - league' },
    season: { info: 'Season (starting year)' },
    round: { info: 'Competition round' },
    home_rank: { short: 'H Rank', info: 'Home team league rank' },
    away_rank: { short: 'A Rank', info: 'Away team league rank' },
    home_form: { short: 'H Form', info: 'Home team league form, most recent last (W win · D draw · L loss)' },
    away_form: { short: 'A Form', info: 'Away team league form, most recent last (W win · D draw · L loss)' },
    h2h: { info: 'Head-to-head record from the home team\'s perspective (W-D-L)' },
    h2h_count: { short: 'Mtgs', info: 'Finished head-to-head meetings on record' },
    home_goals_h2h: { short: 'H:GvO', info: 'Home goals for/against vs this opponent, recent meetings (avg total per game)' },
    away_goals_h2h: { short: 'A:GvO', info: 'Away goals for/against vs this opponent, recent meetings (avg total per game)' },
    home_goals_oth: { short: 'H:GvR', info: 'Home goals for/against vs other teams, recent games (avg total per game)' },
    away_goals_oth: { short: 'A:GvR', info: 'Away goals for/against vs other teams, recent games (avg total per game)' },
};

// Odds market definitions for header/cell tooltips. Canonical result/DC
// markets and O/U lines keep their plain-English description (unchanged);
// anything outside that set (BTTS/DNB/odd-even/team totals/combos/period-
// tagged variants/...) falls back to the market catalog's own `label` (passed
// in as `marketMap`, a key->catalog-entry Map) instead of rendering no
// tooltip at all.
const MARKET_INFO = {
    1: 'Home win', X: 'Draw', 2: 'Away win',
    '1X': 'Home win or draw', X2: 'Draw or away win', 12: 'Home or away win',
};
function _marketInfo(key, marketMap) {
    if (MARKET_INFO[key]) return `${MARKET_INFO[key]} (full time)`;
    const m = /^([UO]) (\d+(?:\.\d+)?)$/.exec(key);
    if (m) return `${m[1] === 'O' ? 'Over' : 'Under'} ${m[2]} total goals`;
    return marketMap?.get(key)?.label ?? null;
}

// API-Football fixture status glossary (short codes are cryptic)
const STATUS_INFO = {
    TBD: 'Time to be defined', NS: 'Not started', '1H': 'First half (live)',
    HT: 'Half time', '2H': 'Second half (live)', ET: 'Extra time (live)',
    BT: 'Break time (live)', P: 'Penalty shootout (live)', LIVE: 'In play',
    SUSP: 'Suspended', INT: 'Interrupted', FT: 'Full time',
    AET: 'Finished after extra time', PEN: 'Finished after penalties',
    PST: 'Postponed', CANC: 'Cancelled', ABD: 'Abandoned',
    AWD: 'Awarded (technical result)', WO: 'Walkover',
};

// Statuses whose tooltip appends the live minute (HT is self-describing;
// finals keep their last seen elapsed, which must not render as live).
const LIVE_MINUTE = new Set(['1H', '2H', 'ET', 'BT', 'P', 'LIVE']);

// Rearrange columns by the persisted key order (settings drag control):
// ordered keys first, anything new/unknown keeps its natural position after.
export function applyOrder(columns, order) {
    if (!Array.isArray(order) || !order.length) return columns;
    const byKey = new Map(columns.map(c => [c.key, c]));
    const ordered = order.map(k => byKey.get(k)).filter(Boolean);
    const placed = new Set(ordered.map(c => c.key));
    return [...ordered, ...columns.filter(c => !placed.has(c.key))];
}

function _time(value) {
    const d = new Date(value);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Time only (HH:MM). The date is redundant now that the whole table is one day
// (the toolbar shows it), so the Start column drops the date to save width.
function _hm(value) {
    const d = new Date(value);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const _dt = value => (value ? new Date(value).toLocaleString() : null);

// H2H tooltip: recent meeting lines (date, names, score) + overflow marker
// when the frozen snapshot count exceeds the capped list.
function _h2hTitle(row) {
    const list = row.h2h_meetings ?? [];
    if (!list.length) return null;
    const lines = list.map(m => `${m.date}  ${m.home} ${m.score} ${m.away}`);
    const more = (row.h2h_count ?? 0) - list.length;
    if (more > 0) lines.push(`+${more} more`);
    return lines.join('\n');
}

// Per-column cell tooltips: advantageous context for the value, kept short.
// Interactive inner elements (fixture link, tip span, hot badge) carry their
// own titles, which win on direct hover.
const CELL_TITLES = {
    // Start now carries the fixture id + canonical name + league context that the
    // removed ID column used to own, on top of the full kickoff timestamp.
    start_time: row => [
        _dt(row.start_time),
        `Fixture #${row.api_id}`,
        row.fixture_api,
        [row.league, row.season, row.round].filter(v => v != null).join(' · ') || null,
    ].filter(Boolean).join('\n'),
    fixture: row => (row.fixture_api && row.fixture_api !== row.fixture ? row.fixture_api : null),
    score: row => {
        if (!row.score) return null;
        const [hs, as] = row.score.split('-');
        return [
            _time(row.start_time),
            `${row.home_team ?? 'Home'} ${hs}`,
            `${row.away_team ?? 'Away'} ${as}`,
            _dt(row.locked_at ?? row.updated_at),
        ].filter(Boolean).join('\n');
    },
    // Status absorbs the removed Updated/Locked columns: the human status (plus
    // live minute) then the odds-refresh and betting-closed timestamps.
    status: row => {
        const info = STATUS_INFO[row.status] ?? row.status;
        const head = info && LIVE_MINUTE.has(row.status) && row.elapsed != null
            ? `${info} - ${row.elapsed}'`
            : info;
        return [
            head,
            row.updated_at ? `Updated ${_dt(row.updated_at)}` : null,
            row.locked_at ? `Locked ${_dt(row.locked_at)}` : null,
        ].filter(Boolean).join('\n');
    },
    home_rank: row => (row.home_rank != null ? `${row.home_team ?? 'Home'} - current league rank` : null),
    away_rank: row => (row.away_rank != null ? `${row.away_team ?? 'Away'} - current league rank` : null),
    home_form: row => (row.home_form ? `${row.home_team ?? 'Home'} - ${HEADER_META.home_form.info}` : null),
    away_form: row => (row.away_form ? `${row.away_team ?? 'Away'} - ${HEADER_META.away_form.info}` : null),
    h2h: _h2hTitle,
    h2h_count: _h2hTitle,
    home_goals_h2h: row => (row.home_goals_h2h ? HEADER_META.home_goals_h2h.info : null),
    away_goals_h2h: row => (row.away_goals_h2h ? HEADER_META.away_goals_h2h.info : null),
    home_goals_oth: row => (row.home_goals_oth ? HEADER_META.home_goals_oth.info : null),
    away_goals_oth: row => (row.away_goals_oth ? HEADER_META.away_goals_oth.info : null),
};

// Text columns whose DERIVED sort value is otherwise hidden get it rendered
// inline as a "<value>:<text>" prefix (form -> points, "2W-1D-0L" -> points,
// score -> total goals, fs: stat -> H+A sum). The prefix reuses the same
// sortValue() call, so the shown number is exactly what sorting/filtering uses.
const PREFIX_KEYS = new Set(['score', 'home_form', 'away_form', 'h2h']);
const _isPrefixed = key => PREFIX_KEYS.has(key) || key.startsWith('fs:');

// Rounded derived value for the inline prefix / tooltip hint.
const _sortNum = v => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);

// Columns still relying on the "⇅ sorts as:" tooltip (sort value NOT shown
// inline): tip (its own rich cell) and the rolling-goals columns (avg already
// visible in parentheses).
const SORT_HINT_KEYS = new Set(['tip',
    'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth']);

// "⇅ sorts as: <derived value>" - the exact value sorting/filtering uses
// (same sortValue call), so the hint can never disagree with the ordering.
function _sortHint(row, col) {
    if (!SORT_HINT_KEYS.has(col.key)) return null;
    const v = sortValue(row, col);
    if (v == null) return null;
    return `⇅ sorts as: ${_sortNum(v)}`;
}

function _cellTitle(row, col, marketMap) {
    const fn = CELL_TITLES[col.key];
    const base = fn
        ? fn(row)
        : col.group === 'market'
            ? _marketInfo(col.key, marketMap)
            : col.key.startsWith('fs:') && row.stats?.[col.key] != null
                ? 'Home / Away - post-match statistic'
                : null;
    const hint = _sortHint(row, col);
    return [base, hint].filter(Boolean).join('\n') || undefined;
}

// Over 2.5 hot-pick badge: 🔥 while pending, 🔥✓/🔥✗ once settled. Tooltip is
// deliberately non-revealing - the signal audit / AI reason (our edge) stays
// out of the UI (see TipPopover's SHOW_INTERNALS).
function _hotBadge(row) {
    // Non-hot rows are also settled in the ledger (calibration); only actual
    // picks earn the badge - a frozen pick keeps hot=1 forever.
    if (!row.hot) return null;
    const title = 'Likely a high-scoring game (3+ goals). Click the tip for more.';
    return (
        <span className="mr-1 cursor-help" title={title}>
            🔥
            {row.hot_outcome === 'hit' && <span className="text-hit font-bold">✓</span>}
            {row.hot_outcome === 'miss' && <span className="text-miss font-bold">✗</span>}
        </span>
    );
}

// Win-% weight tiers (AX1): the confidence is the number the app exists to
// surface, so strong picks pop in accent, mid stays default, weak is muted -
// instead of the flat dim grey it used to share with inert metadata.
function _pctClass(conf) {
    if (conf == null) return 'text-label-3';
    if (conf >= 0.70) return 'text-accent font-semibold';
    if (conf >= 0.65) return '';
    return 'text-label-3';
}

// Settle any market for a final fixture from its canonical score. Runners-up
// carry no stored outcome (only the chosen tip is graded), so we grade them
// here; a non-final row (no score) returns null -> pending, no tick. Returns
// 'hit'|'miss'|'void'|null - a DNB runner-up landing on a draw is a push
// (↩ void via _tick), never a miss, and an unknown key renders no tick
// instead of throwing in the browser.
function _marketOutcome(row, market) {
    if (!row.score) return null;
    const [hs, as] = row.score.split('-').map(Number);
    if (!Number.isFinite(hs) || !Number.isFinite(as)) return null;
    return tipHitSafe(market, hs, as);
}

function _tick(outcome) {
    if (outcome === 'hit') return <span className="text-hit font-bold"> ✓</span>;
    if (outcome === 'miss') return <span className="text-miss font-bold"> ✗</span>;
    // M3: a draw-no-bet push (DNB1/DNB2 on a draw) is neither a win nor a loss
    // - the stake is simply returned. Neutral muted marker, own tooltip (wins
    // over any ancestor title on direct hover).
    if (outcome === 'void') {
        return <span className="text-label-3 font-bold" title="Void - stake returned (draw no bet push)"> ↩</span>;
    }
    return null;
}

// The chosen-tip main line (🔥 badge · market-as-link · confidence · settled
// tick), shared VERBATIM by the real Tip cell and the consolidated sticky
// summary so the two never drift. Needs a `group/tip` ancestor for the
// market's hover-underline. Missed = red wholesale. The AI verdict is
// recorded but never styled: it shows no discrimination on settled data
// (M4.1 spec 3.8), so it must not shape what the user sees. The popover
// still spells the verdict out.
function _tipMainInner(row) {
    const pct = row.tip_confidence != null ? `${Math.round(row.tip_confidence * 100)}%` : null;
    const missed = row.tip_outcome === 'miss';
    return (
        <div className={`whitespace-nowrap ${missed ? 'text-miss' : ''}`}>
            {row.hot ? '🔥 ' : ''}
            <span className={`font-semibold decoration-dotted underline-offset-2 group-hover/tip:underline ${missed ? '' : 'text-accent'}`}>{row.tip_market}</span>
            {pct && <span className={missed ? '' : _pctClass(row.tip_confidence)}> · {pct}</span>}
            {_tick(row.tip_outcome)}
        </div>
    );
}

function _cell(row, col, linkProviders, openTip) {
    const key = col.key;
    if (key === 'start_time') {
        // Two lines (R30): the fixture id as a tiny greyed label on top, the
        // kickoff time below - uses the taller row the multi-line Tip introduced
        // and saves horizontal width. Full id/date context lives in the tooltip.
        return (
            <div className="leading-tight whitespace-nowrap">
                <div className="text-label-3 text-[10px] tabular-nums">{row.api_id}</div>
                <div className="tabular-nums">{_hm(row.start_time)}</div>
            </div>
        );
    }
    if (key === 'tip') {
        // Safest bettable outcome + blended confidence; 🔥 marks the fixture
        // as an over-2.5 hot pick; ✓/✗ appear once the tip settles. Clicking
        // opens the justification popover (blend breakdown, gate audit, AI).
        if (!row.tip_market) {
            // Distinguish "not enough data" (eligibility skip) from "no value
            // found" ('no_pick') and from old rows without a stored reason.
            const reason = row.tip_skip_reason;
            if (!reason) return <span className="text-label-3">-</span>;
            return (
                <span
                    className="text-label-3 italic cursor-pointer decoration-dotted underline-offset-2 hover:underline"
                    title={`${skipLabel(reason)}\nClick for details`}
                    onClick={e => openTip(row, e)}
                >
                    {reason === 'no_pick' ? '-' : 'no data'}
                </span>
            );
        }
        const pct = row.tip_confidence != null ? `${Math.round(row.tip_confidence * 100)}%` : null;
        // Non-revealing tooltip: the pick, its odds and confidence - never HOW
        // it's derived (see TipPopover's SHOW_DETAILS). The AI verdict is not
        // surfaced here (M4.1 spec 3.8) - the popover still spells it out.
        const title = `Safest pick: ${row.tip_market}${row.tip_price != null ? ` @ ${row.tip_price.toFixed(2)}` : ''}`
            + (pct ? ` - confidence ${pct}` : '')
            + (row.hot ? ' - 🔥 likely high-scoring' : '')
            + '\nClick for details';
        // Top-3 picks stacked: the chosen main line (shared _tipMainInner - it's
        // the sort value, so bold/full-size) + up to two smaller, muted runners-up,
        // each with its own settled ✓/✗ graded from the score. The left-pinned
        // sticky summary reuses _tipMainInner (main line only) for the same look.
        const ups = Array.isArray(row.tip_breakdown?.runners_up)
            ? row.tip_breakdown.runners_up.slice(0, 2) : [];
        return (
            <div
                className="group/tip cursor-pointer leading-tight"
                title={title}
                onClick={e => openTip(row, e)}
            >
                {_tipMainInner(row)}
                {ups.map((r, i) => {
                    const rpct = r.confidence != null ? `${Math.round(r.confidence * 100)}%` : null;
                    return (
                        <div key={i} className="whitespace-nowrap text-[11px] text-label-3">
                            <span className="tabular-nums">{i + 2}.</span>{' '}
                            <span>{r.market}</span>
                            {rpct && <span> · {rpct}</span>}
                            {_tick(_marketOutcome(row, r.market))}
                        </div>
                    );
                })}
            </div>
        );
    }
    if (key === 'provider') {
        return (
            <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${PROVIDER_STYLE[row.provider] ?? ''}`}>
                {row.provider}
            </span>
        );
    }
    if (key === 'fixture') {
        // A match link dies once betting closes. The server marks `available`
        // false when the fixture is terminal / completed OR the latest refresh
        // returned zero markets (no betting options). On TOP of that we disable
        // the link client-side once KICKOFF has passed (start_time <= the
        // client's clock): many books (e.g. Betika) drop the pre-match link at
        // kickoff, well before the server records zero markets. Providers opted
        // in via Settings keep their link regardless (betpawa serves live /
        // concluded pages ~6h). Re-evaluates on the 60s freshness re-render.
        const started = row.start_time != null && new Date(row.start_time).getTime() <= Date.now();
        const dead = row.available === false || started;
        const badge = _hotBadge(row);
        if (row.match_url && (!dead || linkProviders.has(row.provider))) {
            return (
                <>
                    {badge}
                    <a href={row.match_url} target="_blank" rel="noreferrer" className="text-accent hover:opacity-70">
                        {row.fixture}
                    </a>
                </>
            );
        }
        const deadTitle = row.available === false ? 'Betting unavailable' : 'Betting closed - match has started';
        return (
            <>
                {badge}
                {dead ? <span title={deadTitle}>{row.fixture}</span> : row.fixture}
            </>
        );
    }
    if (key === 'status' && LIVE_MINUTE.has(row.status) && row.elapsed != null) {
        // In-play: surface the live minute on a second muted line - the taller
        // row (R30, driven by the multi-line Tip/Start cells) gives it space, so
        // the minute reads at a glance without hovering the tooltip. Static
        // statuses stay single-line via the generic path below.
        return (
            <div className="leading-tight whitespace-nowrap">
                <div>{row.status}</div>
                <div className="text-label-3 text-[10px] tabular-nums">{row.elapsed}&rsquo;</div>
            </div>
        );
    }
    const value = key.startsWith('fs:') ? row.stats[key] : row[key];
    if (value == null) return <span className="text-label-3">-</span>;
    // Prefix text columns with their hidden derived sort value (e.g. 8:LWWWD).
    if (_isPrefixed(key)) {
        const v = sortValue(row, col);
        if (v != null) {
            return <><span className="text-label-3">{_sortNum(v)}:</span>{value}</>;
        }
    }
    return value;
}

// Odds cell: fresh price, or the greyed last-seen price of a market that
// vanished from the latest bookmaker update, or an empty dash. A frozen
// match (concluded / no longer refreshed - `available` is false) greys ALL
// its prices the same way: these odds can no longer be taken.
function _marketCell(row, key) {
    const frozen = row.available === false;
    const fresh = row.markets[key];
    // A non-positive price (0.00) is a suspended/void market, not a real odd -
    // render it as a distinct placeholder so it can't read as a genuine number.
    if (fresh != null && fresh <= 0) {
        return <span className="text-label-3" title="Suspended - no price">✕</span>;
    }
    if (fresh != null) {
        return frozen
            ? <span className="text-label-3" title="Frozen - betting unavailable">{fresh.toFixed(2)}</span>
            : fresh.toFixed(2);
    }
    const stale = row.markets_stale?.[key];
    if (stale != null) return <span className="text-label-3" title="No longer offered">{stale.toFixed(2)}</span>;
    return <span className="text-label-3">-</span>;
}

// Magic column cell: the row's rank under the active strategy + its raw
// score (strategies keep their native scales - no fake percentages).
function _magicCell(row, meta) {
    const m = meta?.info.get(row.api_id);
    if (!m) return <span className="text-label-3">-</span>;
    return <span className="tabular-nums whitespace-nowrap">#{m.rank} · {m.score.toFixed(3)}</span>;
}

// Consolidated left-pinned SUMMARY cell (v1.0.2): one sticky column stacking the
// key decision fields, colour-coded so each reads as itself - score (neutral),
// the main Tip pick (accent link, click opens the popover), and the active magic
// rank (dim). Replaces the separate Score/Tip/Magic pinned duplicates; the real
// columns (with runners-up + independent sort) still scroll in place.
function _summaryCell(row, { scoreHasData, magicMeta, openTip }) {
    const hasScore = scoreHasData && !!row.score;
    let total = null;
    if (hasScore) {
        const [hs, as] = row.score.split('-').map(Number);
        if (Number.isFinite(hs) && Number.isFinite(as)) total = hs + as;
    }
    // Extra-small (10px) so the pinned column stays as narrow as possible - it
    // steals horizontal space from the scrolling columns the whole time it shows.
    return (
        <div className="leading-tight space-y-0.5 text-[10px]">
            {hasScore && (
                <div className="whitespace-nowrap tabular-nums">
                    <span className="text-label font-medium">{row.score}</span>
                    {total != null && <span className="text-label-3"> · {total} gls</span>}
                </div>
            )}
            <div className="group/tip cursor-pointer whitespace-nowrap" onClick={e => openTip(row, e)}>
                {row.tip_market ? _tipMainInner(row) : <span className="text-label-3">-</span>}
            </div>
            {magicMeta && <div className="text-label-3">{_magicCell(row, magicMeta)}</div>}
        </div>
    );
}

export default function DataTable({
    catalog, rows, marketKeys, statKeys, columnOrder, chain, cal, onSort, loading, linkProviders, scrollKey,
    visibleBase = null, selection, onToggleSelect, bulk, noPin = false,
    filterCount = 0, onClearFilters,
}) {
    const links = new Set(linkProviders ?? []);
    // Base/synthetic column visibility (R27b/R28a): null = all shown.
    const baseVisible = key => !visibleBase || visibleBase.has(key);
    const showSelect = baseVisible('select');

    // Market key -> full catalog entry (label/group/...), for the data-driven
    // tooltip fallback in _marketInfo (BTTS/DNB/team-totals/combos/... markets
    // outside the hardcoded canonical glossary).
    const marketCatalog = useMemo(
        () => new Map((catalog?.markets ?? []).map(m => [m.key, m])),
        [catalog],
    );

    // Tip justification popover, anchored at the click point (one at a time)
    const [tipPop, setTipPop] = useState(null); // { row, x, y } | null
    const openTip = (row, e) => {
        e.stopPropagation();
        track(EV.TIP_POPOVER, row.tip_market);
        setTipPop({ row, x: e.clientX, y: e.clientY });
    };

    // Column pipeline: assemble + apply the drag order, drop enabled-but-
    // empty market/stat columns (base columns always show).
    const columns = useMemo(() => {
        const statLabel = new Map(catalog?.stats.map(c => [c.key, c.label]) ?? []);
        // The synthetic "No" row-number column joins the base set (orderable +
        // sortable); "Select" is handled separately (always-left pin). Base
        // columns are now individually hideable via `visibleBase`.
        const baseCols = [
            { key: 'no', label: 'No', group: 'base' },
            ...BASE_COLUMNS.map(c => ({ ...c, group: 'base' })),
        ].filter(c => baseVisible(c.key));
        let cols = applyOrder([
            ...baseCols,
            ...marketKeys.map(key => ({ key, label: key, group: 'market' })),
            ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key, group: 'stat' })),
        ], columnOrder);
        // "No" defaults to the first column after the pinned Select checkbox.
        // A saved order predating the column (legacy) would otherwise append it
        // at the end; only an order that EXPLICITLY lists `no` may move it.
        if (baseVisible('no') && !(Array.isArray(columnOrder) && columnOrder.includes('no'))) {
            const noCol = cols.find(c => c.key === 'no');
            if (noCol) cols = [noCol, ...cols.filter(c => c.key !== 'no')];
        }
        if (!rows.length) return cols;
        return cols.filter(col => {
            if (col.group === 'base') return true;
            if (col.group === 'market') {
                return rows.some(r => r.markets?.[col.key] != null || r.markets_stale?.[col.key] != null);
            }
            if (col.key.startsWith('fs:')) return rows.some(r => r.stats?.[col.key] != null);
            return rows.some(r => r[col.key] != null);
        });
    }, [catalog, rows, marketKeys, statKeys, columnOrder, visibleBase]);

    // One ordering for the whole unified chain (column sorts + magic strategies
    // interleaved by priority); tipless rows sink on magic entries, nulls
    // sink on column entries (the AI veto is not acted on - M4.1 spec 3.8).
    // The `_no` load-order anchor is stamped by App
    // (upstream of the client filters, so `no` is filterable too) - a No-column
    // sort reads it via sortValue.
    // "Prioritize Selected" (bulk menu) floats checked rows to the top of the
    // final order (orderRows has no pin concept); a stable partition so both
    // groups keep their sorted order and a newly-checked row rises automatically.
    const sorted = useMemo(() => {
        const s = orderRows(rows, chain, columns, cal);
        return bulk?.prioritizeSelected ? prioritizeSelectedRows(s) : s;
    }, [rows, chain, columns, cal, bulk?.prioritizeSelected]);

    // Displayed row number per row: live position in the sorted order, or the
    // frozen load-order anchor (`_no`) when "pin position" is on (so re-sorting
    // doesn't renumber).
    const noByRow = useMemo(() => {
        const m = new Map();
        sorted.forEach((r, i) => m.set(r.match_id, noPin ? (r._no ?? i + 1) : i + 1));
        return m;
    }, [sorted, noPin]);

    // The magic column tracks the highest-priority magic entry in the chain
    // (if any). Score from that strategy; rank per unique fixture in the FINAL
    // combined order. Null score = tipless row - shows an em dash and
    // shares the sunk tail.
    const primaryMagicId = chain.find(e => e.type === 'magic')?.id;
    const magicMeta = useMemo(() => {
        if (!primaryMagicId) return null;
        const label = STRATEGIES.find(s => s.id === primaryMagicId)?.label ?? primaryMagicId;
        const info = new Map(); // api_id -> { rank, score } | null
        let n = 0;
        for (const row of sorted) {
            if (info.has(row.api_id)) continue;
            const score = scoreTip(row, primaryMagicId, cal);
            info.set(row.api_id, score == null ? null : { rank: ++n, score });
        }
        return { label, info };
    }, [primaryMagicId, cal, sorted]);

    // While magic is active a synthetic score column sits immediately left
    // of Tip (ephemeral: not in the catalog, order persistence or settings).
    const displayColumns = useMemo(() => {
        if (!magicMeta) return columns;
        const col = { key: 'magic', label: '✨', group: 'base' };
        const i = columns.findIndex(c => c.key === 'tip');
        return i < 0 ? [...columns, col] : [...columns.slice(0, i), col, ...columns.slice(i)];
    }, [columns, magicMeta]);

    // Column-header sort indicators: each column entry's priority index across
    // the WHOLE chain; the magic column shows the primary magic entry's slot.
    const order = new Map();
    chain.forEach((e, i) => { if (e.type === 'column') order.set(e.key, { dir: e.dir, i }); });
    const magicPos = chain.findIndex(e => e.type === 'magic');
    const magicLabels = chain.filter(e => e.type === 'magic')
        .map(e => STRATEGIES.find(s => s.id === e.id)?.label ?? e.id);
    const tint = new Map();
    for (const row of rows) {
        if (!tint.has(row.api_id)) tint.set(row.api_id, ROW_TINTS[tint.size % ROW_TINTS.length]);
    }

    // ONE left-pinned SUMMARY cell (v1.0.2) keeps the key decision fields (Score
    // / Tip / Magic) in view once the real Tip column scrolls off the left edge,
    // stacking them colour-coded (see _summaryCell) instead of spreading 2-3
    // separate pinned duplicates - freeing horizontal space. The real columns
    // (own headers, runners-up, independent sort) still scroll in place.
    // Anchored on Tip (always present), so the summary appears only once Tip is
    // gone and never duplicates a still-visible column. Hysteresis: pin when
    // Tip's real column crosses the container's left edge, unpin only once it
    // clears the whole pinned region (Select + summary), so the state can't
    // oscillate at the boundary. The score line shows only when the day HAS
    // scores; the magic line only when a magic strategy is active.
    const scoreHasData = rows.some(r => r.score != null && r.score !== '');
    const ANCHOR_KEY = 'tip';
    const SELECT_W = 44;
    // The summary column is CONTENT-FIT (no fixed width) so it never wastes
    // horizontal space; this is only the hysteresis fallback until the real
    // pinned width is measured from the DOM.
    const SUMMARY_W_FALLBACK = 116;
    const containerRef = useRef(null);
    const pinThRefs = useRef({}); // key -> the real anchor column's <th>
    const summaryThRef = useRef(null); // the pinned summary <th> (measured width)
    const [summaryPinned, setSummaryPinned] = useState(false);
    // Scroll preservation across data reloads: silent background refreshes
    // replace `rows` in place - the view must not jump. A scrollKey change
    // (date/server-filter navigation) is an intentional reset to the top.
    const posRef = useRef({ top: 0, left: 0 });
    const scrollKeyRef = useRef(scrollKey);
    // Right-edge fade affordance (AX8): true once the table is scrolled to its
    // right end (or isn't horizontally scrollable) - the fade then hides. The
    // left edge needs no fade: the pinned columns already occupy it.
    const [atEnd, setAtEnd] = useState(true);
    const _atEnd = cont => cont.scrollLeft + cont.clientWidth >= cont.scrollWidth - 1;
    useLayoutEffect(() => {
        const cont = containerRef.current;
        if (!cont) return;
        if (scrollKeyRef.current !== scrollKey) {
            scrollKeyRef.current = scrollKey;
            posRef.current = { top: 0, left: 0 };
            cont.scrollTo(0, 0);
        } else {
            cont.scrollTop = posRef.current.top;
            cont.scrollLeft = posRef.current.left;
        }
        setAtEnd(_atEnd(cont));
    }, [rows, scrollKey]);
    const onScroll = () => {
        const cont = containerRef.current;
        if (!cont) return;
        posRef.current = { top: cont.scrollTop, left: cont.scrollLeft };
        setAtEnd(_atEnd(cont));
        const th = pinThRefs.current[ANCHOR_KEY];
        if (!th) return;
        const dx = th.getBoundingClientRect().left - cont.getBoundingClientRect().left;
        // Pinned region occupied at the left edge = the Select pin + the summary
        // (its real measured width once shown, else the fallback estimate).
        const summaryW = summaryThRef.current?.offsetWidth || SUMMARY_W_FALLBACK;
        const region = (showSelect ? SELECT_W : 0) + summaryW;
        setSummaryPinned(prev => {
            const next = prev ? dx < region : dx < 0;
            return next === prev ? prev : next;
        });
    };
    // The Select column (R28) is a permanent left-pinned column (fixed width, no
    // scrolling duplicate) at the very left edge; the summary pin sits to its
    // right and appears only while the real Tip column is scrolled out of view.
    const selectCol = showSelect ? { key: 'select', group: 'select', pin: true, left: 0, width: SELECT_W } : null;
    // No fixed width: the table sizes the column to its widest (10px) content.
    const summaryCol = summaryPinned
        ? { key: 'pin-summary', group: 'summary', pin: true, left: showSelect ? SELECT_W : 0, width: undefined }
        : null;
    const pinned = [
        ...(selectCol ? [selectCol] : []),
        ...(summaryCol ? [summaryCol] : []),
        ...displayColumns,
    ];

    // Check-all state over the currently displayed rows (R28).
    const selCount = sorted.reduce((n, r) => n + (r.select ? 1 : 0), 0);
    const allSelected = sorted.length > 0 && selCount === sorted.length;
    const someSelected = selCount > 0 && !allSelected;

    return (
        <>
        {tipPop && <TipPopover row={tipPop.row} x={tipPop.x} y={tipPop.y} catalog={catalog} cal={cal} onClose={() => setTipPop(null)} />}
        <div className="relative flex-1 min-h-0 flex flex-col">
        {/* Non-silent load: blur the stale table + float a spinner over it
            (silent background reloads pass loading=false, so they never dim). */}
        {loading && (
            <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                <div className="flex items-center gap-2 px-3.5 py-2 rounded-full bg-surface/90 border border-separator-2 shadow-lg [backdrop-filter:blur(6px)]">
                    <IconSpinner className="[animation:op-spin_0.8s_linear_infinite] text-accent" />
                    <span className="text-xs font-medium text-label-2">Loading…</span>
                </div>
            </div>
        )}
        <div
            ref={containerRef}
            onScroll={onScroll}
            className={`flex-1 min-h-0 overflow-auto bg-surface border border-separator-2 shadow-sm transition-[filter,opacity] ${loading ? 'blur-[1.5px] opacity-70' : ''}`}
        >
            <table className="w-full text-xs whitespace-nowrap">
                <thead>
                    <tr className="text-left text-label-2 select-none">
                        {pinned.map(col => {
                            const s = order.get(col.key);
                            const meta = HEADER_META[col.key];
                            const info = meta?.info
                                ?? (col.group === 'market' ? _marketInfo(col.key, marketCatalog) : null)
                                ?? (col.key.startsWith('fs:') ? 'Home / Away - post-match statistic' : null);
                            // Backgrounds and edge shadows live on the sticky
                            // cells themselves (tr backgrounds/borders don't
                            // stick); a pinned corner cell wins both axes.
                            const sticky = col.pin
                                ? 'sticky top-0 z-30 shadow-[inset_-1px_-1px_0_var(--separator-2)]'
                                : 'sticky top-0 z-20 shadow-[inset_0_-1px_0_var(--separator-2)]';
                            const isSelect = col.group === 'select';
                            const isSummary = col.group === 'summary';
                            const noSort = col.key === 'magic' || isSelect || isSummary;
                            // Filter hint (key · type · example expression) for
                            // real, filterable columns - not the ephemeral magic
                            // column, the select checkbox or the summary pin.
                            const fhint = noSort ? null : filterHint(col);
                            return (
                                <th
                                    key={col.pin ? `pin:${col.key}` : col.key}
                                    style={col.pin ? { left: col.left, width: col.width, minWidth: col.width, maxWidth: col.width } : undefined}
                                    ref={isSummary
                                        ? el => { summaryThRef.current = el; }
                                        : !col.pin && col.key === ANCHOR_KEY
                                            ? el => { pinThRefs.current[col.key] = el; }
                                            : undefined}
                                    onClick={noSort ? undefined : e => onSort(col.key, e.shiftKey)}
                                    className={`${sticky} bg-surface-2 ${isSummary ? 'px-2 text-[11px]' : 'px-2.5'} py-2 font-semibold ${noSort ? '' : 'cursor-pointer hover:bg-fill'} ${col.group === 'market' || isSelect ? 'text-center' : ''}`}
                                    title={col.key === 'magic'
                                        ? `Magic sort${magicLabels.length > 1 ? `s (${magicLabels.length})` : ''}: ${magicLabels.join(', ')} - #rank · strategy score`
                                        : isSummary
                                            ? 'Frozen summary of Score, Tip and the active Magic sort - the full columns scroll to the right'
                                            : isSelect
                                                ? 'Bulk selection actions'
                                                : `${info ? `${info}\n` : ''}${meta?.short ? `${col.label}\n` : ''}Click to add/cycle sort (desc first) - shift-click to sort by only this column${fhint ? `\n\nFilter: ${fhint.key} · ${fhint.type}\ne.g. ${fhint.example}` : ''}`}
                                >
                                    {isSummary ? (
                                        <span className="text-label-2">{scoreHasData ? 'Score / Tip' : 'Tip'}</span>
                                    ) : isSelect ? (
                                        // The bulk-actions menu (R29): the trigger still shows the
                                        // tri-state selection indicator + a "sel/total" badge and
                                        // opens the with-selected action menu (moved from Settings).
                                        <BulkActionsMenu
                                            allSelected={allSelected}
                                            someSelected={someSelected}
                                            selCount={selCount}
                                            shownCount={sorted.length}
                                            {...bulk}
                                        />
                                    ) : (
                                        <>
                                            {meta?.short ?? col.label}
                                            {s && (
                                                <span className="ml-1 text-accent">
                                                    {s.dir === 'asc' ? '▲' : '▼'}
                                                    {chain.length > 1 && <sup>{s.i + 1}</sup>}
                                                </span>
                                            )}
                                            {col.key === 'magic' && magicPos >= 0 && chain.length > 1 && (
                                                <sup className="ml-0.5 text-accent">{magicPos + 1}</sup>
                                            )}
                                        </>
                                    )}
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map(row => (
                        <tr
                            key={row.match_id}
                            // Opaque bg fallback MUST match the pinned cell's fallback below
                            // (both 'bg-surface') so a tint-less row can't bleed the app
                            // background through the gap beside the left-pinned columns.
                            className={`group border-b border-hairline ${tint.get(row.api_id) ?? 'bg-surface'} hover:bg-fill`}
                        >
                            {pinned.map(col => {
                                const isSelect = col.group === 'select';
                                const isSummary = col.group === 'summary';
                                const content = isSelect ? (
                                    <input
                                        type="checkbox"
                                        aria-label="Select row"
                                        checked={!!row.select}
                                        onChange={() => onToggleSelect?.(row.match_id)}
                                        className="accent-accent h-4 w-4 cursor-pointer"
                                    />
                                ) : isSummary ? _summaryCell(row, { scoreHasData, magicMeta, openTip })
                                    : col.key === 'no' ? (
                                    <span className="text-label-3 tabular-nums">{noByRow.get(row.match_id) ?? ''}</span>
                                ) : col.key === 'magic' ? _magicCell(row, magicMeta)
                                    : col.group === 'market' ? _marketCell(row, col.key)
                                    : _cell(row, col, links, openTip);
                                const cellTitle = (isSelect || isSummary) ? undefined : _cellTitle(row, col, marketCatalog);
                                // Tip & fixture own their tap actions (popover / link) and
                                // keep their native titles; every other cell routes its
                                // hidden-content title through the touch-friendly Tooltip.
                                const wrap = cellTitle && col.key !== 'tip' && col.key !== 'fixture';
                                return (
                                    <td
                                        key={col.pin ? `pin:${col.key}` : col.key}
                                        title={wrap ? undefined : cellTitle}
                                        style={col.pin ? { left: col.left, width: col.width, minWidth: col.width, maxWidth: col.width } : undefined}
                                        // Sticky cells keep their OPAQUE row tint at all times;
                                        // the hover fill is LAYERED over it (a translucent
                                        // gradient), never swapped in as the bg-color - otherwise
                                        // the hovered cell goes translucent and scrolling content
                                        // bleeds through the pinned column.
                                        className={`${isSummary ? 'px-2' : 'px-2.5'} py-1.5 ${col.group === 'market' ? 'text-center tabular-nums' : ''} ${isSelect ? 'text-center' : ''} ${col.pin
                                            ? `sticky z-10 ${tint.get(row.api_id) ?? 'bg-surface'} group-hover:[background-image:linear-gradient(var(--color-fill),var(--color-fill))] shadow-[inset_-1px_0_0_var(--separator-2)]`
                                            : ''}`}
                                    >
                                        {wrap ? <Tooltip content={cellTitle}>{content}</Tooltip> : content}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                    {!rows.length && !loading && (
                        <tr>
                            <td colSpan={pinned.length} className="px-2 py-10 text-center">
                                <div className="flex flex-col items-center gap-2 text-label-3">
                                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true" className="opacity-70">
                                        <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6"/>
                                        <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                                        <path d="M8 11h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                                    </svg>
                                    <span className="text-sm text-label-2">
                                        {filterCount > 0
                                            ? 'No rows match your filters.'
                                            : 'No correlated records for this selection.'}
                                    </span>
                                    {filterCount > 0 && onClearFilters && (
                                        <button
                                            onClick={onClearFilters}
                                            className="cursor-pointer mt-0.5 px-3 h-8 rounded-full border border-accent/50 text-accent text-xs font-semibold hover:bg-accent hover:text-white"
                                        >
                                            Clear {filterCount} filter{filterCount === 1 ? '' : 's'}
                                        </button>
                                    )}
                                </div>
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
        {/* Right-edge fade (AX8): a subtle "more columns →" affordance that
            hides once scrolled to the end (or when nothing overflows). Sits
            over the scroll container, pointer-transparent so it never blocks
            interaction. */}
        <div
            aria-hidden="true"
            className={`pointer-events-none absolute inset-y-0 right-0 w-8 z-10 bg-gradient-to-l from-surface to-transparent transition-opacity duration-200 ${atEnd ? 'opacity-0' : 'opacity-100'}`}
        />
        </div>
        </>
    );
}
