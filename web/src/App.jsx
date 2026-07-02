import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchColumns, fetchRecords } from './api.js';
import DataTable from './components/DataTable.jsx';
import FilterBuilder from './components/FilterBuilder.jsx';
import Pagination from './components/Pagination.jsx';
import SettingsModal from './components/SettingsModal.jsx';

// Selected column keys persist across sessions (settings modal choices)
const LS_MARKETS = 'oddspro.cols.markets';
const LS_STATS = 'oddspro.cols.stats';

function _load(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key));
        return Array.isArray(v) ? v : null;
    } catch {
        return null;
    }
}

const _today = () => new Date().toISOString().substring(0, 10);

export default function App() {
    const [catalog, setCatalog] = useState(null);
    const [marketKeys, setMarketKeys] = useState(() => _load(LS_MARKETS));
    const [statKeys, setStatKeys] = useState(() => _load(LS_STATS));
    const [date, setDate] = useState(_today);
    const [page, setPage] = useState(1);
    const [perPage, setPerPage] = useState(50);
    const [sort, setSort] = useState([]);
    const [filters, setFilters] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showFilters, setShowFilters] = useState(false);

    // Column catalog once; default selections when nothing persisted yet
    useEffect(() => {
        fetchColumns().then(setCatalog).catch(e => setError(String(e.message ?? e)));
    }, []);
    const selectedMarkets = useMemo(
        () => marketKeys ?? catalog?.markets.filter(c => c.default).map(c => c.key) ?? [],
        [marketKeys, catalog],
    );
    const selectedStats = useMemo(
        () => statKeys ?? catalog?.stats.filter(c => c.default).map(c => c.key) ?? [],
        [statKeys, catalog],
    );

    // Records whenever the query shape changes
    useEffect(() => {
        let stale = false;
        setLoading(true);
        fetchRecords({ date: date || 'all', page, perPage, sort, filters })
            .then(res => {
                if (stale) return;
                setResult(res);
                setError(null);
            })
            .catch(e => !stale && setError(String(e.message ?? e)))
            .finally(() => !stale && setLoading(false));
        return () => { stale = true; };
    }, [date, page, perPage, sort, filters]);

    // Header click: plain = single toggle asc/desc/off; shift = multi-sort chain
    const onSort = useCallback((key, additive) => {
        setPage(1);
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

    return (
        <div className="min-h-screen bg-slate-100 text-slate-800">
            <header className="bg-slate-900 text-white px-4 py-3 flex flex-wrap items-center gap-3">
                <h1 className="text-lg font-semibold tracking-wide">ODDS PRO</h1>
                <span className="text-slate-400 text-sm">correlated bookmaker odds &amp; stats</span>
                <div className="grow" />
                <label className="flex items-center gap-2 text-sm">
                    <span className="text-slate-300">Date</span>
                    <input
                        type="date"
                        value={date}
                        onChange={e => { setDate(e.target.value); setPage(1); }}
                        className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-white"
                        title="Clear to show all dates"
                    />
                </label>
                <button
                    onClick={() => setShowFilters(v => !v)}
                    className={`px-3 py-1 rounded border text-sm ${showFilters || filters.length
                        ? 'bg-sky-600 border-sky-500' : 'bg-slate-800 border-slate-700 hover:bg-slate-700'}`}
                >
                    Filters{filters.length ? ` (${filters.length})` : ''}
                </button>
                <button
                    onClick={() => setShowSettings(true)}
                    className="px-3 py-1 rounded border text-sm bg-slate-800 border-slate-700 hover:bg-slate-700"
                >
                    Settings
                </button>
            </header>

            {showFilters && catalog && (
                <FilterBuilder
                    catalog={catalog}
                    filters={filters}
                    onApply={next => { setFilters(next); setPage(1); }}
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
                    sort={sort}
                    onSort={onSort}
                    loading={loading}
                />
                <Pagination
                    page={result?.page ?? page}
                    pages={result?.pages ?? 1}
                    total={result?.total ?? 0}
                    perPage={perPage}
                    onPage={setPage}
                    onPerPage={n => { setPerPage(n); setPage(1); }}
                />
            </main>

            {showSettings && catalog && (
                <SettingsModal
                    catalog={catalog}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    onMarkets={saveMarkets}
                    onStats={saveStats}
                    onClose={() => setShowSettings(false)}
                />
            )}
        </div>
    );
}
