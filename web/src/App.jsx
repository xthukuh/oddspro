import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchColumns, fetchHotpicks, fetchRecords, fetchRefreshStatus, startRefresh } from './api.js';
import DataTable from './components/DataTable.jsx';
import FilterBuilder from './components/FilterBuilder.jsx';
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

function _load(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key));
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

const _today = () => new Date(new Date().setHours(13)).toISOString().substring(0, 10);

export default function App() {
    const [catalog, setCatalog] = useState(null);
    const [marketKeys, setMarketKeys] = useState(() => _load(LS_MARKETS));
    const [statKeys, setStatKeys] = useState(() => _load(LS_STATS));
    const [columnOrder, setColumnOrder] = useState(() => _load(LS_ORDER));
    const [linkProviders, setLinkProviders] = useState(() => _load(LS_LINKS) ?? []);
    const [providerKeys, setProviderKeys] = useState(() => _load(LS_PROVIDERS));
    const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem(LS_COMPLETED) !== '0');
    const [date, setDate] = useState(_today);
    const [sort, setSort] = useState([]);
    const [filters, setFilters] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [refresh, setRefresh] = useState(null); // /api/refresh job state
    const [refreshTick, setRefreshTick] = useState(0); // bump -> reload records
    const [hotpicks, setHotpicks] = useState(null); // /api/hotpicks summary

    // Column catalog once; default selections when nothing persisted yet
    useEffect(() => {
        fetchColumns().then(setCatalog).catch(e => setError(String(e.message ?? e)));
    }, []);
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
    // Known bookmakers come from the catalog; null selection = all visible
    const providers = catalog?.providers ?? [];
    const selectedProviders = useMemo(() => {
        if (!providerKeys) return providers;
        const valid = new Set(providers);
        return providerKeys.filter(p => valid.has(p));
    }, [providerKeys, providers]);

    // Records whenever the query shape changes (or a refresh lands new data)
    useEffect(() => {
        let stale = false;
        setLoading(true);
        fetchRecords({
            date: date || 'all',
            sort,
            filters,
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
    }, [date, sort, filters, refreshTick, showCompleted, providerKeys, selectedProviders, providers.length]);

    // Hot-pick accuracy summary on load and whenever a refresh lands new data
    useEffect(() => {
        fetchHotpicks().then(setHotpicks).catch(() => {});
    }, [refreshTick]);

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

    // Header click: plain = single toggle asc/desc/off; shift = multi-sort chain
    const onSort = useCallback((key, additive) => {
        setSort(prev => {
            const found = prev.find(s => s.key === key);
            const next = found
                ? found.dir === 'asc'
                    ? { key, dir: 'desc' }
                    : null // desc -> remove
                : { key, dir: 'asc' };
            if (!additive) return next ? [next] : [];
            const rest = prev.filter(s => s.key !== key);
            return next ? [...rest, next] : rest;
        });
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

    // Header chip: settled hit-rate over the freshest window with data
    // (30d, else all-time), or the pending count while nothing has settled.
    const hotChip = useMemo(() => {
        if (!hotpicks) return null;
        const { windows, pending } = hotpicks;
        const [w, label] = windows['30d'].picks ? [windows['30d'], '30d'] : [windows.all, 'all'];
        const title = `Over 2.5 hot picks - 7d ${windows['7d'].hits}/${windows['7d'].picks}`
            + ` · 30d ${windows['30d'].hits}/${windows['30d'].picks}`
            + ` · all ${windows.all.hits}/${windows.all.picks} · ${pending} pending`;
        if (w.picks) {
            return { title, text: `🔥 ${w.hits}/${w.picks} · ${Math.round(w.rate * 100)}% (${label})` };
        }
        return pending ? { title, text: `🔥 ${pending} pending` } : null;
    }, [hotpicks]);

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
                {hotChip && (
                    <span
                        className="px-2 py-0.5 rounded-full text-xs bg-slate-800 border border-slate-700 text-amber-300 cursor-help"
                        title={hotChip.title}
                    >
                        {hotChip.text}
                    </span>
                )}
                <div className="grow" />
                { date === TODAY ? null : (
                    <button
                        onClick={() => setDate(TODAY)}
                        className="cursor-pointer px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                    >
                        Today
                    </button>
                )}
                <button
                    onClick={() => setDate(PREV_DATE)}
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
                        onChange={e => setDate(e.target.value)}
                        className="cursor-pointer bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white"
                        title="Clear to show all dates"
                    />
                </label>
                <button
                    onClick={() => setDate(NEXT_DATE)}
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
                    rows={result?.data ?? []}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    columnOrder={columnOrder}
                    sort={sort}
                    onSort={onSort}
                    loading={loading}
                    linkProviders={linkProviders}
                />
                <div className="py-3 text-sm text-slate-500">
                    {result?.total ?? 0} record{result?.total === 1 ? '' : 's'}
                </div>
            </main>

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
