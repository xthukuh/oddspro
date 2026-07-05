import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchColumns, fetchMagicSort, fetchRecords, fetchRefreshStatus, startRefresh } from './api.js';
import { applyClientFilters, splitFilters } from './filterValues.js';
import BetslipPlayground from './components/BetslipPlayground.jsx';
import DataTable from './components/DataTable.jsx';
import FilterBuilder from './components/FilterBuilder.jsx';
import MagicMenu from './components/MagicMenu.jsx';
import SettingsModal from './components/SettingsModal.jsx';

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
// Active magic-sort strategy id (header ✨ menu; null = normal order)
const LS_MAGIC = 'oddspro.magic.strategy';

function _load(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key));
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

const _today = () => new Date(new Date().setHours(13)).toISOString().substring(0, 10);

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
    const [date, setDate] = useState(() => _dateFromUrl() ?? _today());
    const [sort, setSort] = useState([]);
    const [magicId, setMagicId] = useState(() => localStorage.getItem(LS_MAGIC) || null);
    const [magicData, setMagicData] = useState(null); // /api/magic-sort payload
    const [magicError, setMagicError] = useState(null);
    const [filters, setFilters] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [showSlips, setShowSlips] = useState(false);
    const [refresh, setRefresh] = useState(null); // /api/refresh job state
    const [refreshTick, setRefreshTick] = useState(0); // bump -> reload records

    // Column catalog once; default selections when nothing persisted yet
    useEffect(() => {
        fetchColumns().then(setCatalog).catch(e => setError(String(e.message ?? e)));
    }, []);
    // Magic-sort strategies once (server caches per day). A failure only
    // degrades the ✨ menu - the table itself is unaffected.
    useEffect(() => {
        fetchMagicSort().then(setMagicData).catch(e => setMagicError(String(e.message ?? e)));
    }, []);
    // Persisted strategy id revalidates against the fetched list (catalog-
    // sanitizer idiom): a renamed/retired strategy falls back to normal order.
    const activeMagic = useMemo(
        () => (magicId && magicData?.strategies.some(s => s.id === magicId) ? magicId : null),
        [magicId, magicData],
    );
    const magic = useMemo(
        () => (activeMagic ? { id: activeMagic, calibration: magicData.calibration } : null),
        [activeMagic, magicData],
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
    const rows = useMemo(
        () => applyClientFilters(result?.data ?? [], clientFilters, filterColumns),
        [result, clientFilters, filterColumns],
    );
    const rates = useMemo(() => _hitRates(rows), [rows]);
    // Known bookmakers come from the catalog; null selection = all visible
    const providers = catalog?.providers ?? [];
    const selectedProviders = useMemo(() => {
        if (!providerKeys) return providers;
        const valid = new Set(providers);
        return providerKeys.filter(p => valid.has(p));
    }, [providerKeys, providers]);

    // Records whenever the SERVER query shape changes (or a refresh lands
    // new data). Client-only filter edits re-filter locally, never refetch:
    // the effect keys on the serialized server subset, not `filters`.
    const serverFiltersKey = JSON.stringify(serverFilters);
    useEffect(() => {
        let stale = false;
        setLoading(true);
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
            .finally(() => !stale && setLoading(false));
        return () => { stale = true; };
    }, [date, serverFiltersKey, refreshTick, showCompleted, providerKeys, selectedProviders, providers.length]);

    // Back/forward restore the date encoded in the URL
    useEffect(() => {
        const onPop = () => setDate(_dateFromUrl() ?? _today());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    // Pick up a refresh already in flight (e.g. page reloaded mid-refresh)
    useEffect(() => {
        fetchRefreshStatus().then(st => st?.running && setRefresh(st)).catch(() => {});
    }, []);

    // Poll the refresh job while it runs; reload records when it finishes
    useEffect(() => {
        if (!refresh?.running) return;
        const id = setInterval(async () => {
            try {
                const st = await fetchRefreshStatus();
                setRefresh(st);
                if (!st.running) {
                    setRefreshTick(t => t + 1);
                    if (st.error) setError(`Refresh failed: ${st.error}`);
                }
            } catch {
                // transient poll failure - keep polling
            }
        }, 2000);
        return () => clearInterval(id);
    }, [refresh?.running]);

    const onRefresh = async () => {
        try {
            setRefresh(await startRefresh(date));
        } catch (e) {
            setError(String(e.message ?? e));
        }
    };

    // Exactly one ordering mechanism is ever active: picking a strategy
    // clears the column sort, any header click clears magic (below).
    const saveMagic = useCallback(id => {
        setMagicId(id);
        if (id) {
            localStorage.setItem(LS_MAGIC, id);
            setSort([]);
        } else {
            localStorage.removeItem(LS_MAGIC);
        }
    }, []);

    // Header click: plain = single toggle desc/asc/off (descending first -
    // "best" values on top); shift = multi-sort chain. Sorting is client-side
    // (the table holds the whole selection), so clicks never hit the network.
    const onSort = useCallback((key, additive) => {
        setMagicId(null);
        localStorage.removeItem(LS_MAGIC);
        setSort(prev => {
            const found = prev.find(s => s.key === key);
            const next = found
                ? found.dir === 'desc'
                    ? { key, dir: 'asc' }
                    : null // asc -> remove
                : { key, dir: 'desc' };
            if (!additive) return next ? [next] : [];
            const rest = prev.filter(s => s.key !== key);
            return next ? [...rest, next] : rest;
        });
    }, []);

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

    const TODAY = _today();
    const DAY_MS = 86400000;
    const MIN_DATE = '2026-07-02';
    const MAX_DATE = new Date(new Date().setHours(13) + DAY_MS * 7).toISOString().substring(0,10);
    const PREV_DATE = new Date(new Date(date).setHours(13) - DAY_MS).toISOString().substring(0,10);
    const NEXT_DATE = new Date(new Date(date).setHours(13) + DAY_MS).toISOString().substring(0,10);

    return (
        <div className="min-h-screen bg-slate-100 text-slate-800">
            <header className="bg-slate-900 text-white px-4 py-3 flex flex-wrap items-center gap-2">
                <a href="/" className="text-lg font-semibold tracking-wide" title="ODDS PRO">[OP]</a>
                <span className="text-slate-400 text-xs">
                    By <a className="font-bold" href="https://github.com/xthukuh" target="_blank" title="Maintained by Martin Thuku">Martin</a>
                </span>
                <div className="grow" />
                { date === TODAY ? null : (
                    <button
                        onClick={() => changeDate(TODAY)}
                        className="cursor-pointer px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                    >
                        Today
                    </button>
                )}
                <button
                    onClick={() => changeDate(PREV_DATE)}
                    className="cursor-pointer px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                    disabled={date <= MIN_DATE}
                    title={`Previous (${PREV_DATE})`}
                >
                    &#10094;
                </button>
                <label className="flex items-center gap-2 text-sm">
                    <input
                        type="date"
                        value={date}
                        min={MIN_DATE}
                        max={MAX_DATE}
                        onFocus={e => e.target.showPicker?.()}
                        onClick={e => e.target.showPicker?.()}
                        onChange={e => changeDate(e.target.value)}
                        className="date-input-dark cursor-pointer bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white"
                        title="Clear to show all dates"
                    />
                </label>
                <button
                    onClick={() => changeDate(NEXT_DATE)}
                    className="cursor-pointer px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                    disabled={date >= MAX_DATE}
                    title={`Next (${NEXT_DATE})`}
                >
                    &#10095;
                </button>
                <button
                    onClick={onRefresh}
                    disabled={!date || refresh?.running}
                    title={date
                        ? 'Re-fetch fixtures, results & odds for this date'
                        : 'Pick a date to refresh'}
                    className={`cursor-pointer px-3 py-1 rounded border text-sm ${refresh?.running
                        ? 'bg-amber-600 border-amber-500 cursor-wait'
                        : 'bg-slate-800 border-slate-700 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed'}`}
                >
                    {refresh?.running
                        ? `Refreshing ${refresh.date}${refresh.step ? ` — ${refresh.step}` : ''}…`
                        : 'Refresh'}
                </button>
                <MagicMenu
                    data={magicData}
                    error={magicError}
                    active={activeMagic}
                    onPick={saveMagic}
                />
                <button
                    onClick={() => setShowSlips(true)}
                    title="Betslip playground - build virtual multi-bet slips from the day's tips"
                    className="cursor-pointer px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                >
                    Slips
                </button>
                <button
                    onClick={() => setShowFilters(v => !v)}
                    className={`cursor-pointer px-3 py-1 rounded border text-sm ${showFilters || filters.length
                        ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
                >
                    Filters{filters.length ? ` (${filters.length})` : ''}
                </button>
                <button
                    onClick={() => setShowSettings(true)}
                    className="cursor-pointer px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                >
                    Settings
                </button>
            </header>

            {showFilters && catalog && (
                <FilterBuilder
                    catalog={catalog}
                    filters={filters}
                    onApply={setFilters}
                />
            )}

            {error && (
                <div className="m-4 px-4 py-2 rounded border border-red-300 bg-red-50 text-red-700 text-sm">
                    {error}
                </div>
            )}

            <main className="p-4">
                <DataTable
                    catalog={catalog}
                    rows={rows}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    columnOrder={columnOrder}
                    sort={sort}
                    onSort={onSort}
                    magic={magic}
                    loading={loading}
                    linkProviders={linkProviders}
                />
                <div className="py-3 text-sm text-slate-500">
                    <span>
                        {rows.length}{clientFilters.length ? ` of ${result?.total ?? 0}` : ''}
                        {' '}record{(clientFilters.length ? result?.total : rows.length) === 1 ? '' : 's'}
                    </span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span
                        className="cursor-help"
                        title="Over 2.5 hot picks shown: settled hits / settled picks (unique fixtures; pending picks excluded)"
                    >
                        🔥 O2.5: {_rate(rates.hot)}
                    </span>
                    <span className="mx-2 text-slate-300">·</span>
                    <span
                        className="cursor-help"
                        title="Tips shown: settled hits / settled tips (unique fixtures; pending tips excluded, AI-vetoed included)"
                    >
                        Tips: {_rate(rates.tips)}
                    </span>
                </div>
            </main>

            {showSlips && (
                <BetslipPlayground
                    rows={rows}
                    magic={magic}
                    calibration={magicData?.calibration ?? null}
                    date={date || 'all'}
                    onClose={() => setShowSlips(false)}
                />
            )}

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
                    onMarkets={saveMarkets}
                    onStats={saveStats}
                    onOrder={saveOrder}
                    onVisibleProviders={saveProviders}
                    onLinkProviders={saveLinkProviders}
                    onShowCompleted={saveShowCompleted}
                    onClose={() => setShowSettings(false)}
                />
            )}
        </div>
    );
}
