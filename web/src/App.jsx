import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchColumns, fetchMagicSort, fetchRecords, fetchRefreshStatus, startRefresh } from './api.js';
import { shouldReloadForJob } from './freshness.js';
import { applyClientFilters, applyOutcomeToggles, splitFilters } from './filterValues.js';
import BetslipPlayground from './components/BetslipPlayground.jsx';
import DataTable, { BASE_COLUMNS } from './components/DataTable.jsx';
import FilterBuilder from './components/FilterBuilder.jsx';
import HelpModal from './components/HelpModal.jsx';
import MagicMenu from './components/MagicMenu.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import SortPills from './components/SortPills.jsx';
import Tooltip from './components/Tooltip.jsx';

// Selected column keys persist across sessions (settings modal choices)
const LS_MARKETS = 'oddspro.cols.markets';
const LS_STATS = 'oddspro.cols.stats';
// Custom column order (settings drag control; null = natural order)
const LS_ORDER = 'oddspro.cols.order';
// Providers whose unavailable matches keep a clickable link (settings toggle;
// betpawa serves concluded match pages for ~6h)
const LS_LINKS = 'oddspro.links.unavailable';
// Providers whose rows show in the table (settings multi-select; default all -
// the catalog discovers new bookmakers, so null means "everything known")
const LS_PROVIDERS = 'oddspro.providers.visible';
// Whether concluded games stay in the table (settings toggle; default on)
const LS_COMPLETED = 'oddspro.show.completed';
// Settled-outcome display toggles (settings; all default off, client-side over
// the loaded day): hide winning tips / hide losing tips / keep only clean markets
const LS_HIDE_HITS = 'oddspro.show.hideHits';
const LS_HIDE_MISS = 'oddspro.show.hideMiss';
const LS_NO_MISS = 'oddspro.show.noMiss';
// Legacy single magic-strategy id (superseded by the unified sort chain below;
// still read once for a one-time migration).
const LS_MAGIC = 'oddspro.magic.strategy';
// Unified sort chain: column sorts AND magic strategies in one prioritized
// list (index 0 = highest priority). Entries are { type:'column', key, dir }
// or { type:'magic', id }.
const LS_SORT = 'oddspro.sort';

function _load(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key));
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

// Load the persisted sort chain; one-time migrate the legacy magic key.
function _loadSort() {
    const raw = _load(LS_SORT);
    if (raw) {
        return raw.filter(e => e && (
            (e.type === 'column' && typeof e.key === 'string')
            || (e.type === 'magic' && typeof e.id === 'string')
        ));
    }
    const legacy = localStorage.getItem(LS_MAGIC);
    if (legacy) {
        const seed = [{ type: 'magic', id: legacy }];
        localStorage.setItem(LS_SORT, JSON.stringify(seed));
        localStorage.removeItem(LS_MAGIC);
        return seed;
    }
    return [];
}

// Stable empty-array reference for null-catalog fallbacks - a fresh `[]` per
// render would churn downstream memos/effect deps (see the providers note).
const EMPTY_PROVIDERS = [];

const _today = () => new Date(new Date().setHours(13)).toISOString().substring(0, 10);

// Display an ISO date compactly as D/M/YYYY (no leading zeros); tooltip spells
// it out (noon-anchored to dodge tz day-shift). Native <input type="date">
// can't be reformatted, so a formatted label is overlaid on a transparent
// picker input in the header.
const _dmy = iso => { const [y, m, d] = iso.split('-'); return `${+d}/${+m}/${y}`; };
const _fullDate = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});

// Footer scoreboard: settled over-2.5 hot-pick / tip hit rates over the
// displayed rows, counted once per canonical fixture (each provider row
// duplicates the same fixture_predictions data). AI-vetoed tips count -
// they stay on record and settle; /api/performance isolates veto impact.
function _hitRates(rows) {
    const seen = new Set();
    const hot = { hits: 0, settled: 0 }, tips = { hits: 0, settled: 0 };
    for (const r of rows) {
        if (seen.has(r.api_id)) continue;
        seen.add(r.api_id);
        if (r.hot && (r.hot_outcome === 'hit' || r.hot_outcome === 'miss')) {
            hot.settled += 1;
            if (r.hot_outcome === 'hit') hot.hits += 1;
        }
        if (r.tip_market && (r.tip_outcome === 'hit' || r.tip_outcome === 'miss')) {
            tips.settled += 1;
            if (r.tip_outcome === 'hit') tips.hits += 1;
        }
    }
    return { hot, tips };
}

const _rate = ({ hits, settled }) => (settled
    ? `${hits}/${settled} (${(hits / settled * 100).toFixed(1)}%)`
    : '—');

// 'HH:MM' local wall-clock for the status bar's last-refresh stamp
const _hm = iso => {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Selected date round-trips through the URL (?date=YYYY-MM-DD; ?date=all is
// the cleared all-dates view) so reload / back / forward keep the navigation.
const _dateFromUrl = () => {
    const v = new URLSearchParams(location.search).get('date');
    if (v === 'all') return '';
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

export default function App() {
    const [catalog, setCatalog] = useState(null);
    const [marketKeys, setMarketKeys] = useState(() => _load(LS_MARKETS));
    const [statKeys, setStatKeys] = useState(() => _load(LS_STATS));
    const [columnOrder, setColumnOrder] = useState(() => _load(LS_ORDER));
    const [linkProviders, setLinkProviders] = useState(() => _load(LS_LINKS) ?? []);
    const [providerKeys, setProviderKeys] = useState(() => _load(LS_PROVIDERS));
    const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem(LS_COMPLETED) !== '0');
    const [hideHits, setHideHits] = useState(() => localStorage.getItem(LS_HIDE_HITS) === '1');
    const [hideMiss, setHideMiss] = useState(() => localStorage.getItem(LS_HIDE_MISS) === '1');
    const [noMiss, setNoMiss] = useState(() => localStorage.getItem(LS_NO_MISS) === '1');
    const [date, setDate] = useState(() => _dateFromUrl() ?? _today());
    const [sortChain, setSortChain] = useState(_loadSort);
    const [magicData, setMagicData] = useState(null); // /api/magic-sort payload
    const [magicError, setMagicError] = useState(null);
    const [filters, setFilters] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [showSlips, setShowSlips] = useState(false);
    const [showHelp, setShowHelp] = useState(false);
    const [refresh, setRefresh] = useState(null); // /api/refresh job state
    const [refreshTick, setRefreshTick] = useState(0); // bump -> reload records
    const [notice, setNotice] = useState(null); // transient neutral banner
    // Freshness signal plumbing: last seen data_version (null until the first
    // poll - the baseline observation must not reload), whether the next
    // records load is a silent background one (skip the loading dim), and the
    // current date for interval callbacks (they must not re-subscribe per date).
    const lastVersionRef = useRef(null);
    const silentRef = useRef(false);
    const dateRef = useRef(date);
    useEffect(() => { dateRef.current = date; }, [date]);

    // Column catalog once; default selections when nothing persisted yet
    useEffect(() => {
        fetchColumns().then(setCatalog).catch(e => setError(String(e.message ?? e)));
    }, []);
    // Magic-sort strategies once (server caches per day). A failure only
    // degrades the ✨ menu - the table itself is unaffected.
    useEffect(() => {
        fetchMagicSort().then(setMagicData).catch(e => setMagicError(String(e.message ?? e)));
    }, []);
    // Persisted magic entries revalidate against the fetched strategy list
    // (catalog-sanitizer idiom): a renamed/retired strategy drops out of the
    // chain. Column entries pass through - orderRows tolerates unknown keys.
    const activeChain = useMemo(() => {
        if (!magicData) return sortChain;
        const ids = new Set(magicData.strategies.map(s => s.id));
        return sortChain.filter(e => e.type !== 'magic' || ids.has(e.id));
    }, [sortChain, magicData]);
    const cal = magicData?.calibration ?? null;
    const activeMagicIds = useMemo(
        () => activeChain.filter(e => e.type === 'magic').map(e => e.id),
        [activeChain],
    );
    // Persisted keys are filtered against the loaded catalog so selections
    // that no longer exist (e.g. status moved to base columns) don't render
    // ghost columns; localStorage itself is left untouched.
    const selectedMarkets = useMemo(() => {
        const keys = marketKeys ?? catalog?.markets.filter(c => c.default).map(c => c.key) ?? [];
        if (!catalog) return keys;
        const valid = new Set(catalog.markets.map(c => c.key));
        return keys.filter(k => valid.has(k));
    }, [marketKeys, catalog]);
    const selectedStats = useMemo(() => {
        const keys = statKeys ?? catalog?.stats.filter(c => c.default).map(c => c.key) ?? [];
        if (!catalog) return keys;
        const valid = new Set(catalog.stats.map(c => c.key));
        return keys.filter(k => valid.has(k));
    }, [statKeys, catalog]);
    // Server/client filter split: conditions on derived STATS columns (or
    // score) can't run in SQL - they filter locally over the loaded rows.
    // Until the catalog arrives filters can only be [] (the builder needs
    // the catalog to render), so the fallback split is moot but safe.
    const { server: serverFilters, client: clientFilters } = useMemo(
        () => (catalog ? splitFilters(filters, catalog) : { server: filters, client: [] }),
        [filters, catalog],
    );
    // Column descriptors for the client engine: the FULL catalog (plus the
    // table-only score column), independent of visible-column selections -
    // hidden columns still filter because rows carry every field.
    const filterColumns = useMemo(() => (catalog ? [
        ...catalog.base.map(c => ({ key: c.key, group: 'base' })),
        { key: 'score', group: 'base' },
        ...catalog.markets.map(c => ({ key: c.key, group: 'market' })),
        ...catalog.stats.map(c => ({ key: c.key, group: 'stat' })),
    ] : []), [catalog]);
    // Advanced-filter the loaded rows, then apply the settled-outcome toggles
    // (Hide hits / Hide miss / No miss) over what survives.
    const rows = useMemo(
        () => applyOutcomeToggles(
            applyClientFilters(result?.data ?? [], clientFilters, filterColumns),
            { hideHits, hideMiss, noMiss },
        ),
        [result, clientFilters, filterColumns, hideHits, hideMiss, noMiss],
    );
    // Day-level hit-rate scoreboard: computed over the whole loaded selection
    // (result.data), NOT the client-filtered rows - the KPI reflects the day's
    // picks and stays stable when you filter or hide rows in the view.
    const dayRates = useMemo(() => _hitRates(result?.data ?? []), [result]);
    // Known bookmakers come from the catalog; null selection = all visible.
    // The fallback MUST be a stable reference (module-level EMPTY_PROVIDERS,
    // not a fresh `[]`): a new array each render would change the
    // selectedProviders memo and the records-effect deps every render, which
    // on a failed catalog fetch spins an infinite refetch loop (see the
    // "records effect" note below).
    const providers = catalog?.providers ?? EMPTY_PROVIDERS;
    const selectedProviders = useMemo(() => {
        if (!providerKeys) return providers;
        const valid = new Set(providers);
        return providerKeys.filter(p => valid.has(p));
    }, [providerKeys, providers]);

    // Records whenever the SERVER query shape changes (or a refresh lands
    // new data). Client-only filter edits re-filter locally, never refetch:
    // the effect keys on the serialized server subset, not `filters`.
    // NOTE: every dep here must be reference-stable across renders (strings,
    // numbers, or memoized arrays) - an unstable dep would refetch on its own
    // setState, and on a failing request that becomes an infinite refetch loop.
    const serverFiltersKey = JSON.stringify(serverFilters);
    useEffect(() => {
        let stale = false;
        // Silent background reloads (auto-refresh landed new data) skip the
        // loading dim - the table just updates in place.
        if (!silentRef.current) setLoading(true);
        fetchRecords({
            date: date || 'all',
            filters: serverFilters,
            completed: showCompleted,
            // Only constrain when a strict subset is chosen
            providers: providerKeys && selectedProviders.length < providers.length ? selectedProviders : null,
        })
            .then(res => {
                if (stale) return;
                setResult(res);
                setError(null);
            })
            .catch(e => !stale && setError(String(e.message ?? e)))
            .finally(() => {
                silentRef.current = false;
                if (!stale) setLoading(false);
            });
        return () => { stale = true; };
    }, [date, serverFiltersKey, refreshTick, showCompleted, providerKeys, selectedProviders, providers.length]);

    // Auto-dismiss the error banner after 3s (it's also manually closable).
    // A new error resets the timer; clearing on unmount avoids a stray setState.
    useEffect(() => {
        if (!error) return;
        const id = setTimeout(() => setError(null), 3000);
        return () => clearTimeout(id);
    }, [error]);

    // Same auto-dismiss for the neutral notice ("Already fresh ...").
    useEffect(() => {
        if (!notice) return;
        const id = setTimeout(() => setNotice(null), 3000);
        return () => clearTimeout(id);
    }, [notice]);

    // Back/forward restore the date encoded in the URL
    useEffect(() => {
        const onPop = () => setDate(_dateFromUrl() ?? _today());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    // Freshness gate: reload (silently) when the server's data_version moved
    // AND the successful run's scope covers the loaded date. The FIRST
    // observed version is just the baseline - a page load or server restart
    // must not trigger a reload of data we already fetched.
    const maybeReload = useCallback(st => {
        if (st == null || typeof st.data_version !== 'number') return;
        if (lastVersionRef.current === null) {
            lastVersionRef.current = st.data_version;
            return;
        }
        if (st.running || st.data_version === lastVersionRef.current) return;
        lastVersionRef.current = st.data_version;
        if (shouldReloadForJob(st.last_success, dateRef.current)) {
            silentRef.current = true;
            setRefreshTick(t => t + 1);
        }
    }, []);

    // Slow freshness poll (always on): the in-process scheduler refreshes
    // data server-side on its own cadence - this is how every connected
    // client learns about it. Also adopts a refresh already in flight on
    // mount (e.g. page reloaded mid-refresh).
    useEffect(() => {
        let stale = false;
        const poll = async () => {
            try {
                const st = await fetchRefreshStatus();
                if (stale) return;
                setRefresh(st);
                maybeReload(st);
            } catch {
                // transient poll failure - next interval retries
            }
        };
        poll();
        const id = setInterval(poll, 60_000);
        return () => { stale = true; clearInterval(id); };
    }, [maybeReload]);

    // Fast poll while a job runs (manual or scheduled - the ⟳ button spins
    // for both). Manual completions reload unconditionally (the user asked;
    // even a failed run may have landed partial data) and surface errors;
    // auto completions go through the silent freshness gate - their failures
    // belong to logs/auto-refresh.log, not the UI.
    useEffect(() => {
        if (!refresh?.running) return;
        const id = setInterval(async () => {
            try {
                const st = await fetchRefreshStatus();
                setRefresh(st);
                if (!st.running) {
                    if (st.mode === 'manual') {
                        if (typeof st.data_version === 'number') lastVersionRef.current = st.data_version;
                        setRefreshTick(t => t + 1);
                        if (st.error) setError(`Refresh failed: ${st.error}`);
                    } else {
                        maybeReload(st);
                    }
                }
            } catch {
                // transient poll failure - keep polling
            }
        }, 2000);
        return () => clearInterval(id);
    }, [refresh?.running, maybeReload]);

    const onRefresh = async () => {
        try {
            const body = await startRefresh(date);
            if (body?.fresh) {
                // Server-side cache says this date was refreshed moments ago -
                // no new run; just reload what we show and say so.
                if (typeof body.data_version === 'number') lastVersionRef.current = body.data_version;
                const mins = body.last_refreshed_at
                    ? Math.max(1, Math.round((Date.now() - new Date(body.last_refreshed_at).getTime()) / 60_000))
                    : null;
                setNotice(`Already fresh${mins ? ` — refreshed ${mins}m ago` : ''}. Reloading the view.`);
                setRefreshTick(t => t + 1);
                return;
            }
            setRefresh(body);
        } catch (e) {
            setError(String(e.message ?? e));
        }
    };

    // Every chain mutation persists (paired-save idiom)
    const setSortChainPersist = useCallback(updater => {
        setSortChain(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater;
            localStorage.setItem(LS_SORT, JSON.stringify(next));
            return next;
        });
    }, []);

    // Header click: additive by default - cycle THIS column (desc -> asc ->
    // removed) while leaving the rest of the chain (columns and magic) intact;
    // a new column appends at the lowest priority. Shift-click isolates to just
    // this column (fast reset). Sorting is client-side (the table holds the
    // whole selection), so clicks never hit the network.
    const onSort = useCallback((key, isolate) => setSortChainPersist(prev => {
        const found = prev.find(e => e.type === 'column' && e.key === key);
        const next = found
            ? found.dir === 'desc'
                ? { type: 'column', key, dir: 'asc' }
                : null // asc -> remove
            : { type: 'column', key, dir: 'desc' };
        if (isolate) return next ? [next] : [];
        const rest = prev.filter(e => !(e.type === 'column' && e.key === key));
        return next ? [...rest, next] : rest;
    }), [setSortChainPersist]);

    // Magic menu: toggle a strategy in/out of the chain (multiple allowed);
    // clear drops every magic entry but keeps the column sorts.
    const onToggleMagic = useCallback(id => setSortChainPersist(prev => (
        prev.some(e => e.type === 'magic' && e.id === id)
            ? prev.filter(e => !(e.type === 'magic' && e.id === id))
            : [...prev, { type: 'magic', id }]
    )), [setSortChainPersist]);
    const onClearMagic = useCallback(
        () => setSortChainPersist(prev => prev.filter(e => e.type !== 'magic')),
        [setSortChainPersist],
    );

    // Settings drag-list reorder + pill/list removal (match by identity fields
    // so it works regardless of object reference)
    const onReorderChain = useCallback(next => setSortChainPersist(next), [setSortChainPersist]);
    const onRemoveEntry = useCallback(entry => setSortChainPersist(prev => prev.filter(e => (
        !(e.type === entry.type && (e.type === 'magic' ? e.id === entry.id : e.key === entry.key))
    ))), [setSortChainPersist]);

    // Human label for a chain entry (pills + settings drag list)
    const entryLabel = useCallback(e => {
        if (e.type === 'magic') return `✨ ${magicData?.strategies.find(s => s.id === e.id)?.label ?? e.id}`;
        const base = BASE_COLUMNS.find(c => c.key === e.key);
        if (base) return base.label;
        const stat = catalog?.stats.find(c => c.key === e.key);
        return stat?.label ?? e.key; // markets use their key as the label
    }, [magicData, catalog]);

    // Navigate dates keeping state and URL in sync (today = clean URL)
    const changeDate = useCallback(d => {
        setDate(d);
        history.pushState(null, '', d === _today() ? location.pathname : `?date=${d || 'all'}`);
    }, []);

    const saveMarkets = keys => {
        setMarketKeys(keys);
        localStorage.setItem(LS_MARKETS, JSON.stringify(keys));
    };
    const saveStats = keys => {
        setStatKeys(keys);
        localStorage.setItem(LS_STATS, JSON.stringify(keys));
    };
    const saveOrder = keys => {
        setColumnOrder(keys);
        if (keys) localStorage.setItem(LS_ORDER, JSON.stringify(keys));
        else localStorage.removeItem(LS_ORDER); // Reset order
    };
    const saveLinkProviders = keys => {
        setLinkProviders(keys);
        localStorage.setItem(LS_LINKS, JSON.stringify(keys));
    };
    const saveProviders = keys => {
        setProviderKeys(keys);
        localStorage.setItem(LS_PROVIDERS, JSON.stringify(keys));
    };
    const saveShowCompleted = value => {
        setShowCompleted(value);
        localStorage.setItem(LS_COMPLETED, value ? '1' : '0');
    };
    const saveHideHits = value => {
        setHideHits(value);
        localStorage.setItem(LS_HIDE_HITS, value ? '1' : '0');
    };
    const saveHideMiss = value => {
        setHideMiss(value);
        localStorage.setItem(LS_HIDE_MISS, value ? '1' : '0');
    };
    const saveNoMiss = value => {
        setNoMiss(value);
        localStorage.setItem(LS_NO_MISS, value ? '1' : '0');
    };

    const TODAY = _today();
    const DAY_MS = 86400000;
    const MIN_DATE = '2026-07-02';
    const MAX_DATE = new Date(new Date().setHours(13) + DAY_MS * 7).toISOString().substring(0,10);
    const PREV_DATE = new Date(new Date(date).setHours(13) - DAY_MS).toISOString().substring(0,10);
    const NEXT_DATE = new Date(new Date(date).setHours(13) + DAY_MS).toISOString().substring(0,10);

    return (
        <div className="min-h-screen bg-slate-100 text-slate-800">
            {/* Two-tier responsive topbar: brand + merged date-nav on one line,
                action buttons on the next below md (single row from md up). */}
            <header className="bg-slate-900 text-white px-2 py-2 md:px-4 md:py-3 flex flex-col gap-2 md:flex-row md:items-center">
                <div className="flex items-center gap-2">
                    {/* The SVG badge's background is #0f172a (= bg-slate-900,
                        the topbar) so it blends in; the sky border + white "OP"
                        are what read against the bar. */}
                    <a href="/" title="ODDS PRO" className="shrink-0 hover:opacity-80">
                        <img src="/icon.svg" alt="Odds Pro" className="h-8 w-8" />
                    </a>
                    {/* Merged segmented date-nav: [⌂] [‹] [ D/M/YYYY ] [›]. The
                        centre cell is a transparent native picker under a
                        formatted label (native date inputs can't be reformatted);
                        tooltip spells the full day, clearing shows all dates. */}
                    <div className="inline-flex items-stretch overflow-hidden rounded-md border border-slate-700 bg-slate-800 text-sm">
                        {date !== TODAY && (
                            <button
                                onClick={() => changeDate(TODAY)}
                                title="Jump to today"
                                className="cursor-pointer border-r border-slate-700 px-2 py-1 hover:bg-slate-700"
                            >
                                ⌂
                            </button>
                        )}
                        <button
                            onClick={() => changeDate(PREV_DATE)}
                            disabled={date <= MIN_DATE}
                            title={`Previous (${PREV_DATE})`}
                            className="cursor-pointer border-r border-slate-700 px-2 py-1 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                            &#8249;
                        </button>
                        <label className="relative inline-flex items-center" title={date ? _fullDate(date) : 'All dates'}>
                            <span className="pointer-events-none min-w-[6.5rem] px-3 py-1 text-center tabular-nums">
                                {date ? _dmy(date) : 'All dates'}
                            </span>
                            <input
                                type="date"
                                value={date}
                                min={MIN_DATE}
                                max={MAX_DATE}
                                onFocus={e => e.target.showPicker?.()}
                                onClick={e => e.target.showPicker?.()}
                                onChange={e => changeDate(e.target.value)}
                                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                                aria-label="Select date (clear to show all dates)"
                            />
                        </label>
                        <button
                            onClick={() => changeDate(NEXT_DATE)}
                            disabled={date >= MAX_DATE}
                            title={`Next (${NEXT_DATE})`}
                            className="cursor-pointer border-l border-slate-700 px-2 py-1 hover:bg-slate-700 disabled:opacity-40 disabled:hover:bg-transparent"
                        >
                            &#8250;
                        </button>
                    </div>
                </div>
                {/* App-header style action bar: icon-only buttons (Android/iOS
                    convention) with uniform touch targets + accessible labels;
                    text lives in tooltips/aria-label, not on the chrome. */}
                <div className="flex items-center justify-between gap-1.5 md:ml-auto md:justify-end">
                    <button
                        onClick={onRefresh}
                        disabled={!date || refresh?.running}
                        aria-label={refresh?.running ? 'Refreshing' : 'Refresh this date'}
                        title={refresh?.running
                            ? `Refreshing ${refresh.date}${refresh.step ? ` — ${refresh.step}` : ''}…`
                            : date ? 'Re-fetch fixtures, results & odds for this date' : 'Pick a date to refresh'}
                        className={`cursor-pointer h-9 min-w-9 px-2 inline-flex items-center justify-center rounded-md border text-lg leading-none ${refresh?.running
                            ? 'bg-amber-600 border-amber-500 cursor-wait'
                            : 'bg-slate-800 border-slate-700 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed'}`}
                    >
                        <span className={refresh?.running ? 'inline-block animate-spin' : ''}>⟳</span>
                    </button>
                    <MagicMenu
                        data={magicData}
                        error={magicError}
                        activeIds={activeMagicIds}
                        onToggle={onToggleMagic}
                        onClearMagic={onClearMagic}
                    />
                    <button
                        onClick={() => setShowSlips(true)}
                        aria-label="Betslip playground"
                        title="Betslip playground - build virtual multi-bet slips from the day's tips"
                        className="cursor-pointer h-9 min-w-9 px-2 inline-flex items-center justify-center rounded-md border text-lg leading-none bg-slate-800 border-slate-700 hover:bg-slate-700"
                    >
                        🧾
                    </button>
                    <button
                        onClick={() => setShowFilters(v => !v)}
                        aria-label={`Filters${filters.length ? ` (${filters.length} active)` : ''}`}
                        title="Filter the table rows"
                        className={`cursor-pointer h-9 min-w-9 px-2 inline-flex items-center justify-center gap-0.5 rounded-md border text-lg leading-none ${showFilters || filters.length
                            ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
                    >
                        ▽{filters.length ? <span className="text-xs tabular-nums">{filters.length}</span> : null}
                    </button>
                    <button
                        onClick={() => setShowHelp(true)}
                        aria-label="Help"
                        title="Help - what Odds Pro does + demo video"
                        className="cursor-pointer h-9 min-w-9 px-2 inline-flex items-center justify-center rounded-md border text-lg leading-none font-semibold bg-slate-800 border-slate-700 hover:bg-slate-700"
                    >
                        ?
                    </button>
                    <button
                        onClick={() => setShowSettings(true)}
                        aria-label="Display settings"
                        title="Display settings"
                        className="cursor-pointer h-9 min-w-9 px-2 inline-flex items-center justify-center rounded-md border text-lg leading-none bg-slate-800 border-slate-700 hover:bg-slate-700"
                    >
                        ⚙
                    </button>
                </div>
            </header>

            <SortPills
                chain={activeChain}
                entryLabel={entryLabel}
                onRemove={onRemoveEntry}
                onClear={() => onReorderChain([])}
            />

            {showFilters && catalog && (
                <FilterBuilder
                    catalog={catalog}
                    filters={filters}
                    onApply={setFilters}
                />
            )}

            {error && (
                <div className="m-4 px-4 py-2 rounded border border-red-300 bg-red-50 text-red-700 text-sm flex items-start gap-2" role="alert">
                    <span className="grow">{error}</span>
                    <button
                        onClick={() => setError(null)}
                        aria-label="Dismiss error"
                        title="Dismiss"
                        className="cursor-pointer shrink-0 text-red-400 hover:text-red-700 text-lg leading-none"
                    >
                        &times;
                    </button>
                </div>
            )}

            {notice && (
                <div className="m-4 px-4 py-2 rounded border border-sky-300 bg-sky-50 text-sky-700 text-sm flex items-start gap-2" role="status">
                    <span className="grow">{notice}</span>
                    <button
                        onClick={() => setNotice(null)}
                        aria-label="Dismiss notice"
                        title="Dismiss"
                        className="cursor-pointer shrink-0 text-sky-400 hover:text-sky-700 text-lg leading-none"
                    >
                        &times;
                    </button>
                </div>
            )}

            <main className="p-4 pb-10">
                <DataTable
                    catalog={catalog}
                    rows={rows}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    columnOrder={columnOrder}
                    chain={activeChain}
                    cal={cal}
                    onSort={onSort}
                    loading={loading}
                    linkProviders={linkProviders}
                    scrollKey={`${date || 'all'}|${serverFiltersKey}|${showCompleted}`}
                />
            </main>

            {/* Bottom status bar (fixed, z-30 - under the z-40 modals): record
                count, the day-level hit-rate scoreboard and the last refresh
                time. Small text with a subtle lift shadow, wraps on narrow
                screens; <main> reserves pb-10 so content clears it. */}
            {(() => {
                const total = result?.data?.length ?? 0;
                const filtered = rows.length !== total;
                const last = refresh?.last_success;
                return (
                    <div className="fixed bottom-0 inset-x-0 z-30 bg-slate-100/90 backdrop-blur border-t border-slate-300 px-3 py-1 text-xs text-slate-500 [text-shadow:0_1px_0_rgba(255,255,255,0.7)] flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span>
                            {filtered ? `${rows.length}/${total}` : total}
                            {' '}record{total === 1 && !filtered ? '' : 's'}
                        </span>
                        <span className="text-slate-300">·</span>
                        <Tooltip content="Over 2.5 hot picks for the day: settled hits / settled picks (unique fixtures; pending excluded). Day-level - unaffected by view filters.">
                            <span>🔥 O2.5: {_rate(dayRates.hot)}</span>
                        </Tooltip>
                        <span className="text-slate-300">·</span>
                        <Tooltip content="Tips for the day: settled hits / settled tips (unique fixtures; pending excluded, AI-vetoed included). Day-level - unaffected by view filters.">
                            <span>Tips: {_rate(dayRates.tips)}</span>
                        </Tooltip>
                        {(last || refresh?.running) && (
                            <Tooltip content={refresh?.running
                                ? `Refreshing (${refresh.mode ?? 'manual'})${refresh.step ? ` — ${refresh.step}` : ''}…`
                                : `Last data refresh: ${new Date(last.at).toLocaleString()} (${last.mode})`}>
                                <span className="ml-auto tabular-nums">
                                    <span className={refresh?.running ? 'inline-block animate-pulse' : ''}>⟳</span>
                                    {' '}{refresh?.running
                                        ? (refresh.step ?? 'refreshing')
                                        : _hm(last.at)}
                                </span>
                            </Tooltip>
                        )}
                    </div>
                );
            })()}

            {showSlips && (
                <BetslipPlayground
                    rows={rows}
                    chain={activeChain}
                    cal={cal}
                    columns={filterColumns}
                    calibration={magicData?.calibration ?? null}
                    date={date || 'all'}
                    onClose={() => setShowSlips(false)}
                />
            )}

            {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}

            {showSettings && catalog && (
                <SettingsModal
                    catalog={catalog}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    columnOrder={columnOrder}
                    providers={providers}
                    visibleProviders={selectedProviders}
                    linkProviders={linkProviders}
                    showCompleted={showCompleted}
                    hideHits={hideHits}
                    hideMiss={hideMiss}
                    noMiss={noMiss}
                    sortChain={activeChain}
                    entryLabel={entryLabel}
                    onReorderSort={onReorderChain}
                    onRemoveSort={onRemoveEntry}
                    onMarkets={saveMarkets}
                    onStats={saveStats}
                    onOrder={saveOrder}
                    onVisibleProviders={saveProviders}
                    onLinkProviders={saveLinkProviders}
                    onShowCompleted={saveShowCompleted}
                    onHideHits={saveHideHits}
                    onHideMiss={saveHideMiss}
                    onNoMiss={saveNoMiss}
                    onClose={() => setShowSettings(false)}
                />
            )}
        </div>
    );
}
