// Client-sorted datatable: fixed base columns + selected market and STATS
// columns. Click a header to sort descending first (shift-click chains
// multi-sort); the whole selection is loaded, so sorting never hits the API.
// Sticky chrome: the header row pins to the top, and a duplicate Score
// column pins left only while the real one is scrolled out of view.

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { sortValue } from '../sortValues.js';
import { orderRows } from '../ordering.js';
// Shared pure scorer (also used server-side) - vite's fs.allow covers the
// out-of-root import; one implementation, no client/server drift.
import { scoreTip, STRATEGIES } from '../../../src/db/magic-rules.js';
import TipPopover, { skipLabel, SIGNAL_LABEL, signalValue } from './TipPopover.jsx';
import Tooltip from './Tooltip.jsx';

const PROVIDER_STYLE = {
    betpawa: 'bg-hit/15 text-hit',
    betika: 'bg-accent-soft text-accent',
};

// Base columns are always shown (README temp-csv order); match_url folds
// into the fixture cell as an outbound link. Exported for the settings
// modal's column-order control.
export const BASE_COLUMNS = [
    { key: 'api_id', label: 'API ID' },
    { key: 'start_time', label: 'Start' },
    { key: 'fixture', label: 'Fixture' },
    { key: 'provider', label: 'Provider' },
    { key: 'score', label: 'Score' },
    { key: 'goals', label: 'Goals' },
    { key: 'tip', label: 'Tip' },
    { key: 'status', label: 'Status' },
    { key: 'updated_at', label: 'Updated' },
    { key: 'locked_at', label: 'Locked' },
];

// Two alternating row tones cycled by canonical fixture (api_id) in
// first-appearance order: the same fixture shown once per provider shares a
// tone, adjacent fixtures always differ. Opaque classes on purpose - the
// sticky Score cell reuses them to cover content scrolling underneath.
const ROW_TINTS = ['bg-surface', 'bg-surface-2'];

// Header abbreviations (space) + definitions (header tooltip). Column keys
// missing here keep their catalog label and get the sort hint only.
const HEADER_META = {
    api_id: { short: 'ID', info: 'API-Football fixture id' },
    start_time: { info: 'Kickoff time' },
    fixture: { info: 'Bookmaker match name (links to the bookmaker page)' },
    provider: { info: 'Bookmaker' },
    score: { info: 'Final score (home-away), canonical API-Football result' },
    goals: { info: 'Total goals at full time' },
    tip: { info: 'Safest bettable outcome + how confident we are - 🔥 marks a likely 3+ goals game. Click any tip for the reasoning in plain words' },
    status: { info: 'Fixture status' },
    updated_at: { info: 'Last bookmaker odds refresh' },
    locked_at: { info: 'Betting closed - odds frozen and final' },
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

// Odds market definitions for header/cell tooltips
const MARKET_INFO = {
    1: 'Home win', X: 'Draw', 2: 'Away win',
    '1X': 'Home win or draw', X2: 'Draw or away win', 12: 'Home or away win',
};
function _marketInfo(key) {
    if (MARKET_INFO[key]) return `${MARKET_INFO[key]} (full time)`;
    const m = /^([UO]) (\d+(?:\.\d+)?)$/.exec(key);
    return m ? `${m[1] === 'O' ? 'Over' : 'Under'} ${m[2]} total goals` : null;
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
    api_id: row => [
        `Fixture #${row.api_id}`,
        row.fixture_api,
        [row.league, row.season, row.round].filter(v => v != null).join(' · ') || null,
    ].filter(Boolean).join('\n'),
    start_time: row => _dt(row.start_time),
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
    goals: row => {
        if (!row.score) return null;
        const [hs, as] = row.score.split('-');
        return [
            `${row.home_team ?? 'Home'} ${hs} - ${as} ${row.away_team ?? 'Away'}`,
            _dt(row.locked_at ?? row.updated_at),
        ].filter(Boolean).join('\n');
    },
    status: row => {
        const info = STATUS_INFO[row.status] ?? null;
        return info && LIVE_MINUTE.has(row.status) && row.elapsed != null
            ? `${info} — ${row.elapsed}'`
            : info;
    },
    updated_at: row => _dt(row.updated_at),
    locked_at: row => _dt(row.locked_at),
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

function _cellTitle(row, col) {
    const fn = CELL_TITLES[col.key];
    const base = fn
        ? fn(row)
        : col.group === 'market'
            ? _marketInfo(col.key)
            : col.key.startsWith('fs:') && row.stats?.[col.key] != null
                ? 'Home / Away - post-match statistic'
                : null;
    const hint = _sortHint(row, col);
    return [base, hint].filter(Boolean).join('\n') || undefined;
}

// Over 2.5 hot-pick badge: 🔥 while pending, 🔥✓/🔥✗ once settled. The
// tooltip carries the AI reason (when adjudicated) or the signal audit.
function _hotBadge(row) {
    // Non-hot rows are also settled in the ledger (calibration); only actual
    // picks earn the badge - a frozen pick keeps hot=1 forever.
    if (!row.hot) return null;
    const detail = row.hot_reason
        ?? (Array.isArray(row.hot_signals)
            ? row.hot_signals.map(s => `${SIGNAL_LABEL[s.key] ?? s.key}: ${signalValue(s.key, s.value) ?? '-'}`).join('\n')
            : '');
    const title = `Likely 3+ goals game (over 2.5 hot pick${row.hot_score != null ? `, score ${row.hot_score}` : ''})`
        + `${detail ? `\n${detail}` : ''}\nClick the tip for the full checks`;
    return (
        <span className="mr-1 cursor-help" title={title}>
            🔥
            {row.hot_outcome === 'hit' && <span className="text-hit font-bold">✓</span>}
            {row.hot_outcome === 'miss' && <span className="text-miss font-bold">✗</span>}
        </span>
    );
}

function _cell(row, col, linkProviders, openTip) {
    const key = col.key;
    if (key === 'start_time') return _time(row.start_time);
    if (key === 'updated_at' || key === 'locked_at') {
        return row[key] ? _time(row[key]) : <span className="text-label-3">-</span>;
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
                    className="text-label-3 italic cursor-pointer"
                    title={`${skipLabel(reason)}\nClick for details`}
                    onClick={e => openTip(row, e)}
                >
                    {reason === 'no_pick' ? '-' : 'no data'}
                </span>
            );
        }
        const pct = row.tip_confidence != null ? `${Math.round(row.tip_confidence * 100)}%` : null;
        // The pinned (sticky) duplicate drops the % to stay compact; the real
        // Tip column keeps it. Full breakdown is a tap away either way.
        const compact = col.pin;
        const vetoed = row.tip_ai_verdict === 'veto';
        const title = `Safest pick: ${row.tip_market}${row.tip_price != null ? ` @ ${row.tip_price.toFixed(2)}` : ''}`
            + ` - market+stats confidence${pct ? ` ${pct}` : ''}`
            + (row.hot ? ' - 🔥 over-2.5 hot pick fixture' : '')
            + (vetoed ? ` - AI veto: ${row.tip_ai_reason ?? 'see details'}` : '')
            + '\nClick for reasoning';
        // A missed tip turns red wholesale; a hit stays calm with its ✓; an
        // AI-vetoed tip is struck through (it stays on record and settles -
        // the performance report measures what the veto was worth).
        const missed = row.tip_outcome === 'miss';
        return (
            <span
                className={`whitespace-nowrap cursor-pointer ${missed ? 'text-miss' : vetoed ? 'text-label-3' : ''}`}
                title={title}
                onClick={e => openTip(row, e)}
            >
                {row.hot ? '🔥 ' : ''}
                <span className={`font-medium ${vetoed ? 'line-through' : ''}`}>{row.tip_market}</span>
                {pct && !compact && <span className={missed || vetoed ? '' : 'text-label-2'}> · {pct}</span>}
                {row.tip_outcome === 'hit' && <span className="text-hit font-bold"> ✓</span>}
                {missed && <span className="font-bold"> ✗</span>}
            </span>
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
        // Unavailable matches (concluded or no live markets) lose their link
        // unless the provider is opted in via Settings (betpawa keeps
        // concluded match pages up for ~6h).
        const dead = row.available === false;
        const badge = _hotBadge(row);
        if (row.match_url && (!dead || linkProviders.has(row.provider))) {
            return (
                <>
                    {badge}
                    <a href={row.match_url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                        {row.fixture}
                    </a>
                </>
            );
        }
        return (
            <>
                {badge}
                {dead ? <span title="Betting unavailable">{row.fixture}</span> : row.fixture}
            </>
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
    if (!m) return <span className="text-label-3">—</span>;
    return <span className="tabular-nums whitespace-nowrap">#{m.rank} · {m.score.toFixed(3)}</span>;
}

export default function DataTable({ catalog, rows, marketKeys, statKeys, columnOrder, chain, cal, onSort, loading, linkProviders, scrollKey }) {
    const links = new Set(linkProviders ?? []);

    // Tip justification popover, anchored at the click point (one at a time)
    const [tipPop, setTipPop] = useState(null); // { row, x, y } | null
    const openTip = (row, e) => {
        e.stopPropagation();
        setTipPop({ row, x: e.clientX, y: e.clientY });
    };

    // Column pipeline: assemble + apply the drag order, drop enabled-but-
    // empty market/stat columns (base columns always show).
    const columns = useMemo(() => {
        const statLabel = new Map(catalog?.stats.map(c => [c.key, c.label]) ?? []);
        const cols = applyOrder([
            ...BASE_COLUMNS.map(c => ({ ...c, group: 'base' })),
            ...marketKeys.map(key => ({ key, label: key, group: 'market' })),
            ...statKeys.map(key => ({ key, label: statLabel.get(key) ?? key, group: 'stat' })),
        ], columnOrder);
        if (!rows.length) return cols;
        return cols.filter(col => {
            if (col.group === 'base') return true;
            if (col.group === 'market') {
                return rows.some(r => r.markets?.[col.key] != null || r.markets_stale?.[col.key] != null);
            }
            if (col.key.startsWith('fs:')) return rows.some(r => r.stats?.[col.key] != null);
            return rows.some(r => r[col.key] != null);
        });
    }, [catalog, rows, marketKeys, statKeys, columnOrder]);

    // One ordering for the whole unified chain (column sorts + magic
    // strategies interleaved by priority); tipless/vetoed rows sink on magic
    // entries, nulls sink on column entries.
    const sorted = useMemo(
        () => orderRows(rows, chain, columns, cal),
        [rows, chain, columns, cal],
    );

    // The magic column tracks the highest-priority magic entry in the chain
    // (if any). Score from that strategy; rank per unique fixture in the FINAL
    // combined order. Null score = tipless/vetoed row - shows an em dash and
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

    // Left-pinned duplicates of the columns worth keeping in view (Score and
    // Tip), each shown only while its real column is scrolled out of view.
    // Hysteresis matters: inserting a pin shifts the table right, so a column
    // pins when it crosses the container's left edge but unpins only once it
    // would clear the TOTAL width of the currently-inserted pins - adding or
    // removing a pin moves the real columns and the threshold by the same
    // amount, so the states never oscillate at the boundary.
    // Only Score and Tip stay pinned (on every screen size) - keeping the set
    // small leaves room for other columns on narrow widths. The ephemeral magic
    // column scrolls with the rest.
    const PIN_KEYS = ['score', 'tip'];
    const containerRef = useRef(null);
    const pinThRefs = useRef({}); // key -> the real column's <th>
    const [pinState, setPinState] = useState({}); // key -> pinned?
    // Scroll preservation across data reloads: silent background refreshes
    // replace `rows` in place - the view must not jump. A scrollKey change
    // (date/server-filter navigation) is an intentional reset to the top.
    const posRef = useRef({ top: 0, left: 0 });
    const scrollKeyRef = useRef(scrollKey);
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
    }, [rows, scrollKey]);
    const onScroll = () => {
        const cont = containerRef.current;
        if (!cont) return;
        posRef.current = { top: cont.scrollTop, left: cont.scrollLeft };
        const contLeft = cont.getBoundingClientRect().left;
        setPinState(prev => {
            const pinnedWidth = PIN_KEYS.reduce((sum, key) =>
                sum + (prev[key] ? pinThRefs.current[key]?.offsetWidth ?? 0 : 0), 0);
            const next = {};
            let changed = false;
            for (const key of PIN_KEYS) {
                const th = pinThRefs.current[key];
                if (!th) continue;
                const dx = th.getBoundingClientRect().left - contLeft;
                next[key] = prev[key] ? dx < pinnedWidth : dx < 0;
                if (next[key] !== !!prev[key]) changed = true;
            }
            return changed ? next : prev;
        });
    };
    // Pins keep the columns' own (drag-order) relative order and stack with
    // cumulative left offsets so they never overlap.
    let pinLeft = 0;
    const pins = displayColumns.filter(c => pinState[c.key]).map(c => {
        const p = { ...c, pin: true, left: pinLeft };
        pinLeft += pinThRefs.current[c.key]?.offsetWidth ?? 0;
        return p;
    });
    const pinned = pins.length ? [...pins, ...displayColumns] : displayColumns;

    return (
        <>
        {tipPop && <TipPopover row={tipPop.row} x={tipPop.x} y={tipPop.y} onClose={() => setTipPop(null)} />}
        <div
            ref={containerRef}
            onScroll={onScroll}
            className={`flex-1 min-h-0 overflow-auto bg-surface rounded-2xl border border-separator-2 shadow-sm ${loading ? 'opacity-60' : ''}`}
        >
            <table className="w-full text-xs whitespace-nowrap">
                <thead>
                    <tr className="text-left text-label-2 select-none">
                        {pinned.map(col => {
                            const s = order.get(col.key);
                            const meta = HEADER_META[col.key];
                            const info = meta?.info
                                ?? (col.group === 'market' ? _marketInfo(col.key) : null)
                                ?? (col.key.startsWith('fs:') ? 'Home / Away - post-match statistic' : null);
                            // Backgrounds and edge shadows live on the sticky
                            // cells themselves (tr backgrounds/borders don't
                            // stick); a pinned corner cell wins both axes.
                            const sticky = col.pin
                                ? 'sticky top-0 z-30 shadow-[inset_-1px_-1px_0_var(--separator-2)]'
                                : 'sticky top-0 z-20 shadow-[inset_0_-1px_0_var(--separator-2)]';
                            return (
                                <th
                                    key={col.pin ? `pin:${col.key}` : col.key}
                                    style={col.pin ? { left: col.left } : undefined}
                                    ref={!col.pin && PIN_KEYS.includes(col.key)
                                        ? el => { pinThRefs.current[col.key] = el; }
                                        : undefined}
                                    onClick={col.key === 'magic' ? undefined : e => onSort(col.key, e.shiftKey)}
                                    className={`${sticky} bg-surface-2 px-2.5 py-2 font-semibold ${col.key === 'magic' ? '' : 'cursor-pointer hover:bg-fill'} ${col.group === 'market' ? 'text-center' : ''}`}
                                    title={col.key === 'magic'
                                        ? `Magic sort${magicLabels.length > 1 ? `s (${magicLabels.length})` : ''}: ${magicLabels.join(', ')} - #rank · strategy score`
                                        : `${info ? `${info}\n` : ''}${meta?.short ? `${col.label}\n` : ''}Click to add/cycle sort (desc first) - shift-click to sort by only this column`}
                                >
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
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody>
                    {sorted.map(row => (
                        <tr
                            key={row.match_id}
                            className={`group border-b border-hairline ${tint.get(row.api_id) ?? ''} hover:bg-fill`}
                        >
                            {pinned.map(col => {
                                const content = col.key === 'magic' ? _magicCell(row, magicMeta)
                                    : col.group === 'market' ? _marketCell(row, col.key)
                                    : _cell(row, col, links, openTip);
                                const cellTitle = _cellTitle(row, col);
                                // Tip & fixture own their tap actions (popover / link) and
                                // keep their native titles; every other cell routes its
                                // hidden-content title through the touch-friendly Tooltip.
                                const wrap = cellTitle && col.key !== 'tip' && col.key !== 'fixture';
                                return (
                                    <td
                                        key={col.pin ? `pin:${col.key}` : col.key}
                                        title={wrap ? undefined : cellTitle}
                                        style={col.pin ? { left: col.left } : undefined}
                                        className={`px-2.5 py-1.5 ${col.group === 'market' ? 'text-center tabular-nums' : ''} ${col.pin
                                            ? `sticky z-10 ${tint.get(row.api_id) ?? 'bg-surface'} group-hover:bg-fill shadow-[inset_-1px_0_0_var(--separator-2)]`
                                            : ''}`}
                                    >
                                        {wrap ? <Tooltip content={cellTitle}>{content}</Tooltip> : content}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                    {!rows.length && (
                        <tr>
                            <td colSpan={pinned.length} className="px-2 py-8 text-center text-label-3">
                                {loading ? 'Loading...' : 'No correlated records for this selection.'}
                            </td>
                        </tr>
                    )}
                </tbody>
            </table>
        </div>
        </>
    );
}
