import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchColumns, fetchMagicSort, fetchRecords, fetchRefreshStatus, startRefresh } from './api.js';
import { shouldReloadForJob } from './freshness.js';
import { getTheme, setTheme } from './theme.js';
import { availableColumnKeys } from './columns.js';
import { applyClientFilters, applyOneOfEach, applyOutcomeToggles, splitFilters } from './filterValues.js';
import { safeSelection } from '../../src/db/magic-rules.js';
import BetslipPlayground from './components/BetslipPlayground.jsx';
import CalendarPopover from './components/CalendarPopover.jsx';
import DataTable, { BASE_COLUMNS } from './components/DataTable.jsx';
import FilterBuilder from './components/FilterBuilder.jsx';
import HelpModal from './components/HelpModal.jsx';
import Logo from './components/Logo.jsx';
import MagicMenu from './components/MagicMenu.jsx';
import OverflowMenu from './components/OverflowMenu.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import Sheet from './components/Sheet.jsx';
import SortPills from './components/SortPills.jsx';
import Tooltip from './components/Tooltip.jsx';
import { IconRefresh, IconSpinner, IconMagic, IconSlips, IconFilter, IconHelp, IconGear, IconChevronLeft, IconChevronRight, IconChevronDown } from './components/icons.jsx';

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
const LS_PROVIDER_ORDER = 'oddspro.providers.order'; // priority order (all providers)
const LS_ONE_EACH = 'oddspro.show.oneEach';          // one row per game by priority
// Whether concluded games stay in the table (settings toggle; default on)
const LS_COMPLETED = 'oddspro.show.completed';
// Settled-outcome display toggles (settings; all default off, client-side over
// the loaded day): hide winning tips / hide losing tips / keep only clean markets
const LS_HIDE_HITS = 'oddspro.show.hideHits';
const LS_HIDE_MISS = 'oddspro.show.hideMiss';
const LS_NO_MISS = 'oddspro.show.noMiss';
// Safe-only toggle (settings; default off): keep only the day's safest slip
// legs per the shared safeSelection gates (magic-rules DEFAULT_SAFE)
const LS_SAFE_ONLY = 'oddspro.show.safeOnly';
// Safe-only policy overrides (settings; merged over the server DEFAULT_SAFE
// policy and passed as safeSelection opts - the browser can't read .env, so
// this is how a user tunes the gates locally). Object, not array.
const LS_SAFE_OVERRIDES = 'oddspro.safe.overrides';
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

// Plain-object loader (safe-limit overrides); non-objects fall back to {}.
function _loadObj(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key));
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        return {};
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
// Human-friendly nav label "Thu, Jul 9" (noon-anchored to dodge tz day-shift);
// the tooltip spells out the full date.
const _human = iso => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
});
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
    const [providerOrder, setProviderOrder] = useState(() => _load(LS_PROVIDER_ORDER));
    const [oneEach, setOneEach] = useState(() => localStorage.getItem(LS_ONE_EACH) === '1');
    const [showCompleted, setShowCompleted] = useState(() => localStorage.getItem(LS_COMPLETED) !== '0');
    const [hideHits, setHideHits] = useState(() => localStorage.getItem(LS_HIDE_HITS) === '1');
    const [hideMiss, setHideMiss] = useState(() => localStorage.getItem(LS_HIDE_MISS) === '1');
    const [noMiss, setNoMiss] = useState(() => localStorage.getItem(LS_NO_MISS) === '1');
    const [safeOnly, setSafeOnly] = useState(() => localStorage.getItem(LS_SAFE_ONLY) === '1');
    const [safeOverrides, setSafeOverrides] = useState(() => _loadObj(LS_SAFE_OVERRIDES));
    // Appearance: 'system' (default) | 'light' | 'dark'. The FOUC script already
    // applied the saved value pre-paint; this just mirrors it into React state.
    const [theme, setThemeState] = useState(getTheme);
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
    const [showCal, setShowCal] = useState(false);
    const [showMagic, setShowMagic] = useState(false);
    const [showOverflow, setShowOverflow] = useState(false);
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
    // Safe-only policy served from the API (SAFE_* env → DEFAULT_SAFE fallback);
    // undefined until magic-sort loads, when safeSelection uses its own defaults.
    // The user's local overrides layer on top; the merged object drives both the
    // footer count and the Safe-only cut.
    const safeCfg = magicData?.safe ?? null;
    const effectiveSafe = useMemo(
        () => ({ ...(safeCfg ?? {}), ...safeOverrides }),
        [safeCfg, safeOverrides],
    );
    const safeCap = effectiveSafe.maxPerDay ?? 3;
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
    // Market/stat keys present in the loaded day - drives date-dynamic option
    // lists in the settings selectors and the filter builder (absent columns
    // are omitted so the controls honestly reflect the day). Recomputes on
    // date/refresh via `result`.
    const available = useMemo(
        () => availableColumnKeys(result?.data ?? [], catalog),
        [result, catalog],
    );
    // Safe picks are day-level over the whole loaded selection (result.data),
    // NOT the filtered rows - other toggles/filters must not change who wins
    // the per-day cap, and the footer count stays honest. One representative
    // row per fixture; the table filters by api_id membership.
    const safePicks = useMemo(
        () => safeSelection(result?.data ?? [], cal, effectiveSafe),
        [result, cal, effectiveSafe],
    );
    // Known bookmakers come from the catalog; null selection = all visible.
    // The fallback MUST be a stable reference (module-level EMPTY_PROVIDERS,
    // not a fresh `[]`): a new array each render would change the
    // selectedProviders memo and the records-effect deps every render, which
    // on a failed catalog fetch spins an infinite refetch loop (see the
    // "records effect" note below).
    const providers = catalog?.providers ?? EMPTY_PROVIDERS;
    // Priority order over ALL providers: saved order first (valid entries), any
    // new/unsaved bookmakers appended last, unknown dropped. Drives the provider
    // control's row order and the one-of-each pick. Declared before `rows`
    // because the one-of-each dedupe in that memo reads it.
    const orderedProviders = useMemo(() => {
        if (!providers.length) return providers;
        const valid = new Set(providers);
        const saved = (providerOrder ?? []).filter(p => valid.has(p));
        return [...saved, ...providers.filter(p => !saved.includes(p))];
    }, [providerOrder, providers]);
    // Advanced-filter the loaded rows, then apply the settled-outcome toggles
    // (Hide hits / Hide miss / No miss), then the Safe-only membership cut
    // (keeps ALL provider rows of qualifying fixtures - tint pairing intact).
    const rows = useMemo(() => {
        let out = applyOutcomeToggles(
            applyClientFilters(result?.data ?? [], clientFilters, filterColumns),
            { hideHits, hideMiss, noMiss },
        );
        if (safeOnly) {
            const ids = new Set(safePicks.map(r => r.api_id));
            out = out.filter(r => ids.has(r.api_id));
        }
        // One-of-each collapses to a single row per game (highest-priority
        // enabled provider); loaded rows are already the enabled providers.
        if (oneEach) out = applyOneOfEach(out, orderedProviders);
        return out;
    }, [result, clientFilters, filterColumns, hideHits, hideMiss, noMiss, safeOnly, safePicks, oneEach, orderedProviders]);
    // Day-level hit-rate scoreboard: computed over the whole loaded selection
    // (result.data), NOT the client-filtered rows - the KPI reflects the day's
    // picks and stays stable when you filter or hide rows in the view.
    const dayRates = useMemo(() => _hitRates(result?.data ?? []), [result]);
    // Enabled providers in priority order (null persisted keys = all enabled).
    const selectedProviders = useMemo(() => {
        if (!providerKeys) return orderedProviders;
        const enabled = new Set(providerKeys);
        return orderedProviders.filter(p => enabled.has(p));
    }, [providerKeys, orderedProviders]);
    // Rows for the provider control: ordered, each flagged enabled.
    const providerItems = useMemo(
        () => orderedProviders.map(p => ({ key: p, label: p, enabled: providerKeys ? providerKeys.includes(p) : true })),
        [orderedProviders, providerKeys],
    );

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
    // Enable/disable a provider; persist the enabled set in priority order.
    const toggleProvider = key => {
        const enabled = new Set(providerKeys ?? providers); // null persisted = all on
        enabled.has(key) ? enabled.delete(key) : enabled.add(key);
        const next = orderedProviders.filter(p => enabled.has(p));
        setProviderKeys(next);
        localStorage.setItem(LS_PROVIDERS, JSON.stringify(next));
    };
    // Move a provider up/down the priority order; persist the full order.
    const moveProvider = (key, dir) => {
        const arr = [...orderedProviders];
        const i = arr.indexOf(key);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= arr.length) return;
        [arr[i], arr[j]] = [arr[j], arr[i]];
        setProviderOrder(arr);
        localStorage.setItem(LS_PROVIDER_ORDER, JSON.stringify(arr));
    };
    const saveOneEach = value => {
        setOneEach(value);
        localStorage.setItem(LS_ONE_EACH, value ? '1' : '0');
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
    const saveSafeOnly = value => {
        setSafeOnly(value);
        localStorage.setItem(LS_SAFE_ONLY, value ? '1' : '0');
    };
    const changeTheme = value => setThemeState(setTheme(value));
    // Safe-limit overrides: set one key, or reset to the server policy.
    const saveSafeOverride = (key, value) => setSafeOverrides(prev => {
        const next = { ...prev, [key]: value };
        localStorage.setItem(LS_SAFE_OVERRIDES, JSON.stringify(next));
        return next;
    });
    const resetSafeOverrides = () => {
        setSafeOverrides({});
        localStorage.removeItem(LS_SAFE_OVERRIDES);
    };

    const TODAY = _today();
    const DAY_MS = 86400000;
    const MIN_DATE = '2026-07-02';
    const MAX_DATE = new Date(new Date().setHours(13) + DAY_MS * 7).toISOString().substring(0,10);
    const PREV_DATE = new Date(new Date(date).setHours(13) - DAY_MS).toISOString().substring(0,10);
    const NEXT_DATE = new Date(new Date(date).setHours(13) + DAY_MS).toISOString().substring(0,10);

    const navBtn = 'cursor-pointer h-10 w-10 inline-flex items-center justify-center rounded-[10px] text-label hover:bg-accent-soft disabled:opacity-40 disabled:hover:bg-transparent';
    const navBtnActive = 'cursor-pointer h-10 w-10 inline-flex items-center justify-center rounded-[10px] text-accent bg-accent-soft';

    return (
        <div className="h-[100dvh] flex flex-col bg-app text-label overflow-hidden">
            {/* iPadOS nav bar: a distinct surface (own bg + hairline + shadow +
                blur) so it reads as its own bar, separated from the content.
                3 zones: logo (home->today) · date nav+calendar · actions
                (collapse into a ⋯ menu below sm). */}
            <header className="shrink-0 grid grid-cols-[auto_1fr_auto] sm:grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-3 px-2.5 py-1.5 bg-nav/95 [backdrop-filter:blur(25px)_saturate(180%)] border-b border-separator shadow-sm relative z-40">
                <div className="flex items-center min-w-0">
                    <Logo onHome={() => changeDate(TODAY)} />
                </div>
                {/* Centre: chevrons + calendar-popover trigger */}
                <div className="relative flex items-center gap-0.5 justify-self-center">
                    <button onClick={() => changeDate(PREV_DATE)} disabled={date <= MIN_DATE}
                        title={`Previous (${PREV_DATE})`} aria-label="Previous day" className={navBtn}>
                        <IconChevronLeft />
                    </button>
                    <button onClick={() => setShowCal(v => !v)} title={date ? _fullDate(date) : 'All dates'}
                        aria-label="Pick a date"
                        className="cursor-pointer h-10 min-w-[7rem] sm:min-w-[9.5rem] px-2 sm:px-3 inline-flex items-center justify-center gap-1.5 rounded-[10px] text-[15px] sm:text-[17px] font-semibold hover:bg-accent-soft">
                        <span>{date ? _human(date) : 'All dates'}</span>
                        <IconChevronDown className="text-accent" />
                    </button>
                    <button onClick={() => changeDate(NEXT_DATE)} disabled={date >= MAX_DATE}
                        title={`Next (${NEXT_DATE})`} aria-label="Next day" className={navBtn}>
                        <IconChevronRight />
                    </button>
                    {showCal && (
                        <CalendarPopover date={date} today={TODAY} min={MIN_DATE} max={MAX_DATE}
                            onPick={d => changeDate(d)} onClose={() => setShowCal(false)} />
                    )}
                </div>
                {/* Right: full action row (>=sm) or ⋯ overflow (<sm) */}
                <div className="flex items-center justify-self-end">
                    <div className="hidden sm:flex items-center gap-0.5">
                        <button onClick={onRefresh} disabled={!date || refresh?.running}
                            aria-label={refresh?.running ? 'Refreshing' : 'Refresh this date'}
                            title={refresh?.running
                                ? `Refreshing ${refresh.date}${refresh.step ? ` — ${refresh.step}` : ''}…`
                                : date
                                    ? `Refresh fixtures, results & odds${refresh?.last_success ? ` — last ${_hm(refresh.last_success.at)}` : ''}`
                                    : 'Pick a date to refresh'}
                            className={navBtn + (refresh?.running ? ' text-accent cursor-wait' : '')}>
                            {refresh?.running
                                ? <IconSpinner className="[animation:op-spin_0.8s_linear_infinite]" />
                                : <IconRefresh />}
                        </button>
                        <button onClick={() => setShowMagic(true)} aria-label="Magic sort"
                            title="Sort tips most-likely-to-win first (backtested ranking strategies)"
                            className={activeMagicIds.length ? navBtnActive : navBtn}>
                            <IconMagic />{activeMagicIds.length > 1 ? <span className="text-[11px] tabular-nums ml-0.5">{activeMagicIds.length}</span> : null}
                        </button>
                        <button onClick={() => setShowSlips(true)} aria-label="Betslip playground" title="Betslip playground - build virtual multi-bet slips from the day's tips" className={navBtn}><IconSlips /></button>
                        <button onClick={() => setShowFilters(v => !v)} aria-label={`Filters${filters.length ? ` (${filters.length} active)` : ''}`} title="Filter the table rows"
                            className={(showFilters || filters.length) ? navBtnActive : navBtn}>
                            <IconFilter />{filters.length ? <span className="text-[11px] tabular-nums ml-0.5">{filters.length}</span> : null}
                        </button>
                        <div className="w-px h-5 bg-separator mx-1.5" />
                        <button onClick={() => setShowHelp(true)} aria-label="Help" title="Help - what Odds Pro does + demo video" className={navBtn}><IconHelp /></button>
                        <button onClick={() => setShowSettings(true)} aria-label="Display settings" title="Display settings" className={navBtn}><IconGear /></button>
                    </div>
                    <div className="relative sm:hidden">
                        <button onClick={() => setShowOverflow(v => !v)} aria-label="More actions" title="More"
                            className={showOverflow ? navBtnActive : navBtn}><span className="text-xl leading-none">⋯</span></button>
                        {showOverflow && (
                            <OverflowMenu
                                refreshing={refresh?.running} canRefresh={!!date && !refresh?.running}
                                filterCount={filters.length} magicActive={activeMagicIds.length > 0}
                                onRefresh={() => { onRefresh(); setShowOverflow(false); }}
                                onMagic={() => { setShowMagic(true); setShowOverflow(false); }}
                                onSlips={() => { setShowSlips(true); setShowOverflow(false); }}
                                onFilters={() => { setShowFilters(v => !v); setShowOverflow(false); }}
                                onHelp={() => { setShowHelp(true); setShowOverflow(false); }}
                                onSettings={() => { setShowSettings(true); setShowOverflow(false); }}
                                onClose={() => setShowOverflow(false)} />
                        )}
                    </div>
                </div>
            </header>

            <main className="flex-1 min-h-0 flex flex-col px-3.5 pt-2 pb-2 gap-2 overflow-hidden">
                {error && (
                    <div className="shrink-0 px-4 py-2 rounded-2xl border border-miss/40 bg-miss/10 text-miss text-sm flex items-start gap-2" role="alert">
                        <span className="grow">{error}</span>
                        <button onClick={() => setError(null)} aria-label="Dismiss error" title="Dismiss" className="cursor-pointer shrink-0 text-miss/70 hover:text-miss text-lg leading-none">&times;</button>
                    </div>
                )}
                {notice && (
                    <div className="shrink-0 px-4 py-2 rounded-2xl border border-accent/40 bg-accent-soft text-accent text-sm flex items-start gap-2" role="status">
                        <span className="grow">{notice}</span>
                        <button onClick={() => setNotice(null)} aria-label="Dismiss notice" title="Dismiss" className="cursor-pointer shrink-0 text-accent/70 hover:text-accent text-lg leading-none">&times;</button>
                    </div>
                )}
                <SortPills chain={activeChain} entryLabel={entryLabel} onRemove={onRemoveEntry} onClear={() => onReorderChain([])} />
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

            {/* Status bar: a normal flex child of the app shell (no longer fixed).
                Whole items wrap to more rows on narrow widths; refresh/last-refresh
                state now lives on the toolbar sync button, not here. */}
            {(() => {
                const total = result?.data?.length ?? 0;
                const filtered = rows.length !== total;
                return (
                    <footer className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2 bg-nav/95 [backdrop-filter:blur(25px)_saturate(180%)] border-t border-separator text-xs text-label-2 z-20">
                        <span className="whitespace-nowrap">
                            {filtered ? `${rows.length}/${total}` : total}
                            {' '}record{total === 1 && !filtered ? '' : 's'}
                        </span>
                        <span className="text-label-3">·</span>
                        <Tooltip content="Over 2.5 hot picks for the day: settled hits / settled picks (unique fixtures; pending excluded). Day-level - unaffected by view filters.">
                            <span className="whitespace-nowrap"><span className="text-hot">🔥</span> O2.5: {_rate(dayRates.hot)}</span>
                        </Tooltip>
                        <span className="text-label-3">·</span>
                        <Tooltip content="Tips for the day: settled hits / settled tips (unique fixtures; pending excluded, AI-vetoed included). Day-level - unaffected by view filters.">
                            <span className="whitespace-nowrap">Tips: {_rate(dayRates.tips)}</span>
                        </Tooltip>
                        <span className="text-label-3">·</span>
                        <Tooltip content={`Games that pass the safety checks for multi-bet slips: the signals (bookmaker odds, team form, expert data) agree with none weak, short odds, best ${safeCap} per day by market probability. Day-level - unaffected by view filters. Turn on 'Safe only' in Settings to show just these.`}>
                            <span className={`whitespace-nowrap ${safeOnly ? 'text-accent' : ''}`}>🛡 Safe: {safePicks.length}</span>
                        </Tooltip>
                    </footer>
                );
            })()}

            {showMagic && (
                <Sheet onClose={() => setShowMagic(false)} className="max-w-md">
                    <MagicMenu data={magicData} error={magicError} activeIds={activeMagicIds}
                        onToggle={onToggleMagic} onClearMagic={onClearMagic} onClose={() => setShowMagic(false)} />
                </Sheet>
            )}

            {showFilters && catalog && (
                <Sheet onClose={() => setShowFilters(false)} className="max-w-2xl">
                    <FilterBuilder
                        catalog={catalog}
                        available={available}
                        rows={result?.data ?? []}
                        filterColumns={filterColumns}
                        filters={filters}
                        onApply={setFilters}
                        onClose={() => setShowFilters(false)}
                    />
                </Sheet>
            )}

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
                    theme={theme}
                    onTheme={changeTheme}
                    availableMarkets={available.markets}
                    availableStats={available.stats}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    columnOrder={columnOrder}
                    providers={providers}
                    providerItems={providerItems}
                    linkProviders={linkProviders}
                    showCompleted={showCompleted}
                    hideHits={hideHits}
                    hideMiss={hideMiss}
                    noMiss={noMiss}
                    oneEach={oneEach}
                    safeOnly={safeOnly}
                    safeMaxPerDay={safeCap}
                    safe={effectiveSafe}
                    safeDefaults={safeCfg}
                    safeOverridden={Object.keys(safeOverrides).length > 0}
                    onSafeSet={saveSafeOverride}
                    onSafeReset={resetSafeOverrides}
                    sortChain={activeChain}
                    entryLabel={entryLabel}
                    onReorderSort={onReorderChain}
                    onRemoveSort={onRemoveEntry}
                    onMarkets={saveMarkets}
                    onStats={saveStats}
                    onOrder={saveOrder}
                    onToggleProvider={toggleProvider}
                    onMoveProvider={moveProvider}
                    onLinkProviders={saveLinkProviders}
                    onShowCompleted={saveShowCompleted}
                    onHideHits={saveHideHits}
                    onHideMiss={saveHideMiss}
                    onNoMiss={saveNoMiss}
                    onOneEach={saveOneEach}
                    onSafeOnly={saveSafeOnly}
                    onClose={() => setShowSettings(false)}
                />
            )}
        </div>
    );
}
