// Client-sorted datatable: fixed base columns + selected market and STATS
// columns. Click a header to sort descending first (shift-click chains
// multi-sort); the whole selection is loaded, so sorting never hits the API.
// Sticky chrome: the header row pins to the top, and a duplicate Score
// column pins left only while the real one is scrolled out of view.

import { useMemo, useRef, useState } from 'react';
import { sortRows, sortValue } from '../sortValues.js';
// Shared pure scorer (also used server-side) - vite's fs.allow covers the
// out-of-root import; one implementation, no client/server drift.
import { magicSortRows } from '../../../src/db/magic-rules.js';
import TipPopover, { skipLabel } from './TipPopover.jsx';

const PROVIDER_STYLE = {
    betpawa: 'bg-emerald-100 text-emerald-800',
    betika: 'bg-sky-100 text-sky-800',
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
const ROW_TINTS = ['bg-white', 'bg-slate-100'];

// Header abbreviations (space) + definitions (header tooltip). Column keys
// missing here keep their catalog label and get the sort hint only.
const HEADER_META = {
    api_id: { short: 'ID', info: 'API-Football fixture id' },
    start_time: { info: 'Kickoff time' },
    fixture: { info: 'Bookmaker match name (links to the bookmaker page)' },
    provider: { info: 'Bookmaker' },
    score: { info: 'Final score (home-away), canonical API-Football result' },
    goals: { info: 'Total goals at full time' },
    tip: { info: 'Safest bettable outcome + blended confidence - 🔥 marks an over-2.5 hot pick' },
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
    status: row => STATUS_INFO[row.status] ?? null,
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

// Columns whose sort value is DERIVED from the displayed text (form ->
// points, "gf/ga (avg)" -> avg, score -> total goals, tip -> confidence +
// hot bonus, fs: stats -> H+A sum). Plain numbers, dates and odds prices
// are skipped - the display IS the value.
const SORT_HINT_KEYS = new Set(['score', 'tip', 'home_form', 'away_form', 'h2h',
    'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth']);

// "⇅ sorts as: <derived value>" - the exact value sorting/filtering uses
// (same sortValue call), so the hint can never disagree with the ordering.
function _sortHint(row, col) {
    if (!SORT_HINT_KEYS.has(col.key) && !col.key.startsWith('fs:')) return null;
    const v = sortValue(row, col);
    if (v == null) return null;
    return `⇅ sorts as: ${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`;
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
            ? row.hot_signals.map(s => `${s.key}: ${s.value ?? '-'}`).join(' · ')
            : '');
    const title = `Over 2.5 hot pick${row.hot_score != null ? ` (score ${row.hot_score})` : ''}${detail ? ` - ${detail}` : ''}`;
    return (
        <span className="mr-1 cursor-help" title={title}>
            🔥
            {row.hot_outcome === 'hit' && <span className="text-emerald-600 font-bold">✓</span>}
            {row.hot_outcome === 'miss' && <span className="text-rose-600 font-bold">✗</span>}
        </span>
    );
}

function _cell(row, key, linkProviders, openTip) {
    if (key === 'start_time') return _time(row.start_time);
    if (key === 'updated_at' || key === 'locked_at') {
        return row[key] ? _time(row[key]) : <span className="text-slate-300">-</span>;
    }
    if (key === 'tip') {
        // Safest bettable outcome + blended confidence; 🔥 marks the fixture
        // as an over-2.5 hot pick; ✓/✗ appear once the tip settles. Clicking
        // opens the justification popover (blend breakdown, gate audit, AI).
        if (!row.tip_market) {
            // Distinguish "not enough data" (eligibility skip) from "no value
            // found" ('no_pick') and from old rows without a stored reason.
            const reason = row.tip_skip_reason;
            if (!reason) return <span className="text-slate-300">-</span>;
            return (
                <span
                    className="text-slate-300 italic cursor-pointer"
                    title={`${skipLabel(reason)}\nClick for details`}
                    onClick={e => openTip(row, e)}
                >
                    {reason === 'no_pick' ? '-' : 'no data'}
                </span>
            );
        }
        const pct = row.tip_confidence != null ? `${Math.round(row.tip_confidence * 100)}%` : null;
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
                className={`whitespace-nowrap cursor-pointer ${missed ? 'text-rose-600' : vetoed ? 'text-slate-400' : ''}`}
                title={title}
                onClick={e => openTip(row, e)}
            >
                {row.hot ? '🔥 ' : ''}
                <span className={`font-medium ${vetoed ? 'line-through' : ''}`}>{row.tip_market}</span>
                {pct && <span className={missed || vetoed ? '' : 'text-slate-500'}> · {pct}</span>}
                {row.tip_outcome === 'hit' && <span className="text-emerald-600 font-bold"> ✓</span>}
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
                    <a href={row.match_url} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline">
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
    return value ?? <span className="text-slate-300">-</span>;
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
            ? <span className="text-slate-400" title="Frozen - betting unavailable">{fresh.toFixed(2)}</span>
            : fresh.toFixed(2);
    }
    const stale = row.markets_stale?.[key];
    if (stale != null) return <span className="text-slate-400" title="No longer offered">{stale.toFixed(2)}</span>;
    return <span className="text-slate-300">-</span>;
}

export default function DataTable({ catalog, rows, marketKeys, statKeys, columnOrder, sort, onSort, magic, loading, linkProviders }) {
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

    // Magic sort (most-likely-to-win first; tipless/vetoed rows sink) takes
    // precedence over the column-sort chain - App guarantees only one is set.
    const sorted = useMemo(
        () => (magic ? magicSortRows(rows, magic.id, magic.calibration) : sortRows(rows, sort, columns)),
        [rows, sort, columns, magic],
    );
    const order = new Map(sort.map((s, i) => [s.key, { ...s, i }]));
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
    const PIN_KEYS = ['score', 'tip'];
    const containerRef = useRef(null);
    const pinThRefs = useRef({}); // key -> the real column's <th>
    const [pinState, setPinState] = useState({}); // key -> pinned?
    const onScroll = () => {
        const cont = containerRef.current;
        if (!cont) return;
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
    const pins = columns.filter(c => pinState[c.key]).map(c => {
        const p = { ...c, pin: true, left: pinLeft };
        pinLeft += pinThRefs.current[c.key]?.offsetWidth ?? 0;
        return p;
    });
    const pinned = pins.length ? [...pins, ...columns] : columns;

    return (
        <>
        {tipPop && <TipPopover row={tipPop.row} x={tipPop.x} y={tipPop.y} onClose={() => setTipPop(null)} />}
        <div
            ref={containerRef}
            onScroll={onScroll}
            className={`overflow-auto max-h-[calc(100vh-8.5rem)] bg-white rounded-lg border border-slate-200 shadow-sm ${loading ? 'opacity-60' : ''}`}
        >
            <table className="w-full text-xs whitespace-nowrap">
                <thead>
                    <tr className="text-left text-slate-600 select-none">
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
                                ? 'sticky top-0 z-30 shadow-[inset_-1px_-1px_0_#e2e8f0]'
                                : 'sticky top-0 z-20 shadow-[inset_0_-1px_0_#e2e8f0]';
                            return (
                                <th
                                    key={col.pin ? `pin:${col.key}` : col.key}
                                    style={col.pin ? { left: col.left } : undefined}
                                    ref={!col.pin && PIN_KEYS.includes(col.key)
                                        ? el => { pinThRefs.current[col.key] = el; }
                                        : undefined}
                                    onClick={e => onSort(col.key, e.shiftKey)}
                                    className={`${sticky} bg-slate-50 px-2 py-1.5 font-medium cursor-pointer hover:bg-slate-100 ${col.group === 'market' ? 'text-center' : ''}`}
                                    title={`${info ? `${info}\n` : ''}${meta?.short ? `${col.label}\n` : ''}Click to sort (desc first) - shift-click for multi-sort`}
                                >
                                    {meta?.short ?? col.label}
                                    {s && (
                                        <span className="ml-1 text-sky-600">
                                            {s.dir === 'asc' ? '▲' : '▼'}
                                            {sort.length > 1 && <sup>{s.i + 1}</sup>}
                                        </span>
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
                            className={`group border-b border-slate-100 ${tint.get(row.api_id) ?? ''} hover:bg-slate-200/70`}
                        >
                            {pinned.map(col => (
                                <td
                                    key={col.pin ? `pin:${col.key}` : col.key}
                                    title={_cellTitle(row, col)}
                                    style={col.pin ? { left: col.left } : undefined}
                                    className={`px-2 py-1 ${col.group === 'market' ? 'text-center tabular-nums' : ''} ${col.pin
                                        ? `sticky z-10 ${tint.get(row.api_id) ?? 'bg-white'} group-hover:bg-slate-200 shadow-[inset_-1px_0_0_#e2e8f0]`
                                        : ''}`}
                                >
                                    {col.group === 'market' ? _marketCell(row, col.key) : _cell(row, col.key, links, openTip)}
                                </td>
                            ))}
                        </tr>
                    ))}
                    {!rows.length && (
                        <tr>
                            <td colSpan={pinned.length} className="px-2 py-8 text-center text-slate-400">
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
