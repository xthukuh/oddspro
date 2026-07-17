import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { fetchColumns, fetchMagicSort, fetchRecords, fetchRefreshStatus, startRefresh, fetchDailyVisitors } from './api.js';
import { shouldReloadForJob } from './freshness.js';
import useOutsideDismiss from './useOutsideDismiss.js';
import { getTheme, setTheme } from './theme.js';
import { availableColumnKeys } from './columns.js';
import { applyClientFilters, applyOneOfEach, applyOutcomeToggles, applyRiskGate, splitFilters, conditionCount, stampSelection, applySelectionHide, applySelectionKeep, displayedSummary, unionSelectionIds, invertSelectionIds, selectSimilarIds, keepOneProviderIds } from './filterValues.js';
import { safeSelection, sureBetsSelection, DEFAULT_SURE_BETS } from '../../src/db/magic-rules.js';
import { tipHitSafe } from '../../src/db/tip-rules.js';
import { buildRecordCsv } from './exportCsv.js';
import BetslipPlayground, { seedSlip } from './components/BetslipPlayground.jsx';
import CalendarPopover from './components/CalendarPopover.jsx';
import DataTable, { BASE_COLUMNS } from './components/DataTable.jsx';
import FilterBuilder from './components/FilterBuilder.jsx';
import HelpModal from './components/HelpModal.jsx';
import Logo from './components/Logo.jsx';
import MagicMenu from './components/MagicMenu.jsx';
import OverflowMenu from './components/OverflowMenu.jsx';
import AvatarMenu from './components/AvatarMenu.jsx';
import { useSession } from './auth/SessionProvider.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import Sheet from './components/Sheet.jsx';
import SortPills from './components/SortPills.jsx';
import ViewPills from './components/ViewPills.jsx';
import Tooltip from './components/Tooltip.jsx';
import { IconRefresh, IconSpinner, IconMagic, IconSlips, IconFilter, IconHelp, IconGear, IconMenu, IconChevronLeft, IconChevronRight, IconChevronDown, IconUser } from './components/icons.jsx';

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
// Sure-bets toggle (magic sheet; default off): keep only the day's top-10
// safest tips ranked by calibrated win probability (magic-rules
// sureBetsSelection). Signed-in only - guest rows are redacted server-side
// (no tip_breakdown), so the gates cannot evaluate.
const LS_SURE_BETS = 'oddspro.show.sureBets';
// Risk gate (settings; default ON): when a magic sort or Safe-only is active,
// hide games without sufficient stats (thin rolling sample / H2H / no tip) -
// the "exclude risky bets" filter. Uses the shared hasSufficientStats gate.
const LS_RISK_GATE = 'oddspro.show.riskGate';
// Legacy single magic-strategy id (superseded by the unified sort chain below;
// still read once for a one-time migration).
const LS_MAGIC = 'oddspro.magic.strategy';
// Unified sort chain: column sorts AND magic strategies in one prioritized
// list (index 0 = highest priority). Entries are { type:'column', key, dir }
// or { type:'magic', id }.
const LS_SORT = 'oddspro.sort';
// Visible base/synthetic columns (R27b/R28a; null = all shown). "Pin position"
// freezes the No column's numbers. Row selection persists PER DISPLAY DATE
// (keyed by match_id) under the `.d.` prefix so "Clear all selections" can wipe
// every date without touching the hide toggle.
const LS_COLS_BASE = 'oddspro.cols.base';
const LS_NO_PIN = 'oddspro.cols.noPin';
const LS_SELECT_PREFIX = 'oddspro.select.d.';
const LS_SELECT_HIDE = 'oddspro.select.hide';
// "Keep selection" - inverse of Hide selection (show only checked rows). The two
// are mutually exclusive (enabling one clears the other in the setters below).
const LS_SELECT_KEEP = 'oddspro.select.keep';
// "Prioritize Selected" (bulk menu) - float checked rows to the top of the table
// regardless of the active sort. Reorders only (no rows hidden), so no ViewPill.
const LS_PRIORITIZE_SEL = 'oddspro.show.prioritizeSel';

// A client re-order/re-filter transition only shows the spinner once it outlasts
// this (ms); quicker work commits before the timer, so it never flashes.
const PENDING_SPINNER_MS = 300;

// The base + synthetic columns a user can show/hide (Select omitted from sort).
const BASE_COL_OPTIONS = [
    { key: 'select', label: 'Select' },
    { key: 'no', label: 'No' },
    ...BASE_COLUMNS,
];
const _selectKey = date => LS_SELECT_PREFIX + (date || 'all');

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
    // Default sort for a fresh user: the 'sure' magic strategy (most-likely-to-
    // win). NOT persisted, so clearing the sort (writes '[]') stays cleared.
    return [{ type: 'magic', id: 'sure' }];
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
    // Runner-up scoreboards (R26c): "what if we'd bet the 2nd / 3rd pick".
    // Only the chosen tip stores an outcome, so the runners-up are graded from
    // the final score via tipHitSafe (never throws on an unrecognized market
    // key - settled iff the graded outcome is hit/miss; a 'void' (DNB push) or
    // an unknown key never counts toward settled, exactly like the chosen-tip
    // count above already excludes them).
    const up2 = { hits: 0, settled: 0 }, up3 = { hits: 0, settled: 0 };
    for (const r of rows) {
        if (seen.has(r.api_id)) continue;
        seen.add(r.api_id);
        if (r.hot && (r.hot_outcome === 'hit' || r.hot_outcome === 'miss')) {
            hot.settled += 1;
            if (r.hot_outcome === 'hit') hot.hits += 1;
        }
        // Chosen tip settled? Then grade the runners-up over the SAME fixtures
        // (same denominator basis) so "2nd / 3rd" is comparable to "Tips".
        if (r.tip_market && (r.tip_outcome === 'hit' || r.tip_outcome === 'miss')) {
            tips.settled += 1;
            if (r.tip_outcome === 'hit') tips.hits += 1;
            const [hs, as] = String(r.score ?? '').split('-').map(Number);
            const ups = Array.isArray(r.tip_breakdown?.runners_up) ? r.tip_breakdown.runners_up : [];
            if (Number.isFinite(hs) && Number.isFinite(as)) {
                for (const [i, bucket] of [[0, up2], [1, up3]]) {
                    const market = ups[i]?.market;
                    if (!market) continue;
                    bucket.settled += 1;
                    const out = tipHitSafe(market, hs, as);
                    if (out === 'hit') bucket.hits += 1;
                    if (out !== 'hit' && out !== 'miss') bucket.settled -= 1;
                }
            }
        }
    }
    return { hot, tips, up2, up3 };
}

const _rate = ({ hits, settled }) => (settled
    ? `${hits}/${settled} (${(hits / settled * 100).toFixed(1)}%)`
    : '-');
// Compact footer form: integer percent only (the full fraction lives in the
// tooltip). Keeps the status bar short + uniform.
const _ratePct = ({ hits, settled }) => (settled ? `${Math.round(hits / settled * 100)}%` : '-');

// 'HH:MM' local wall-clock for the status bar's last-refresh stamp
const _hm = iso => {
    const d = new Date(iso);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Grouped number for the footer betting ledger (odds / value / P-L).
const _money = v => (v == null ? '-' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));

// The betslip playground persists its whole config (incl. the per-pick stake)
// under this key. The footer ledger reuses that stake, so the two never diverge.
const LS_BETSLIPS = 'oddspro.betslips';
const _loadBetslipStake = () => {
    try {
        const s = Number(JSON.parse(localStorage.getItem(LS_BETSLIPS))?.config?.stake);
        return Number.isFinite(s) && s > 0 ? s : 100; // 100 = betslip DEFAULT_CONFIG.stake
    } catch {
        return 100;
    }
};

// Selected date round-trips through the URL (?date=YYYY-MM-DD; ?date=all is
// the cleared all-dates view) so reload / back / forward keep the navigation.
const _dateFromUrl = () => {
    const v = new URLSearchParams(location.search).get('date');
    if (v === 'all') return '';
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
};

export default function App() {
    const session = useSession(); // null-safe: App renders identically for guests
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
    const [sureBets, setSureBets] = useState(() => localStorage.getItem(LS_SURE_BETS) === '1');
    // Risk gate defaults ON (absent key = on); only an explicit '0' disables it.
    const [riskGate, setRiskGate] = useState(() => localStorage.getItem(LS_RISK_GATE) !== '0');
    // Base/synthetic column visibility (null = all shown), No pin, and the
    // "Hide selection" cut. Row selection (per display date) is loaded below.
    const [visibleBaseKeys, setVisibleBaseKeys] = useState(() => _load(LS_COLS_BASE));
    const [noPin, setNoPin] = useState(() => localStorage.getItem(LS_NO_PIN) === '1');
    const [hideSelected, setHideSelected] = useState(() => localStorage.getItem(LS_SELECT_HIDE) === '1');
    const [keepSelected, setKeepSelected] = useState(() => localStorage.getItem(LS_SELECT_KEEP) === '1');
    const [prioritizeSelected, setPrioritizeSelected] = useState(() => localStorage.getItem(LS_PRIORITIZE_SEL) === '1');
    const [visitors, setVisitors] = useState(null); // { unique, total } for today (status-bar badge)
    // Appearance: 'system' (default) | 'light' | 'dark'. The FOUC script already
    // applied the saved value pre-paint; this just mirrors it into React state.
    const [theme, setThemeState] = useState(getTheme);
    const [date, setDate] = useState(() => _dateFromUrl() ?? _today());
    // Row selection for the loaded date (Set<match_id>); reloaded on date change.
    const [selection, setSelection] = useState(() => new Set(_load(_selectKey(_dateFromUrl() ?? _today())) ?? []));
    const [sortChain, setSortChain] = useState(_loadSort);
    const [magicData, setMagicData] = useState(null); // /api/magic-sort payload
    const [magicError, setMagicError] = useState(null);
    const [filters, setFilters] = useState([]);
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    // Guest asked for a future date (server 403 auth_required, Phase 8) -
    // renders the "Sign in to see upcoming games" panel instead of the table.
    const [signInNeeded, setSignInNeeded] = useState(false);
    const [loading, setLoading] = useState(false);
    // Heavy client re-orders (magic sort, bulk filter apply on a big day) run as
    // a React transition so the UI never freezes and input spam is coalesced.
    // isPending drives a DELAYED spinner (below) - only if the work outlasts the
    // threshold, so quick changes never flash.
    const [isPending, startTransition] = useTransition();
    const [showPending, setShowPending] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [showSlips, setShowSlips] = useState(false);
    // Per-pick stake mirrored from the betslip playground's persisted config, so
    // the footer P/L ledger uses the same number. Re-read when the slips modal
    // closes (that's where it's edited) - see the effect below.
    const [betslipStake, setBetslipStake] = useState(_loadBetslipStake);
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
    // Last serialized records query actually fetched - the records effect skips a
    // re-run whose query is byte-identical (an unstable-reference dep would
    // otherwise refetch every render; see the effect's note).
    const lastQueryRef = useRef(null);
    const dateRef = useRef(date);
    useEffect(() => { dateRef.current = date; }, [date]);
    // Wrappers (trigger + panel) for the header popups' tap-away dismissal - a
    // backdrop <div> can't cover the page from inside the backdrop-filtered nav.
    const calWrapRef = useRef(null);
    const overflowWrapRef = useRef(null);
    useOutsideDismiss(calWrapRef, showCal, () => setShowCal(false));
    useOutsideDismiss(overflowWrapRef, showOverflow, () => setShowOverflow(false));

    // Column catalog once; default selections when nothing persisted yet
    useEffect(() => {
        fetchColumns().then(setCatalog).catch(e => setError(String(e.message ?? e)));
    }, []);
    // Magic-sort strategies once (server caches per day). A failure only
    // degrades the ✨ menu - the table itself is unaffected.
    useEffect(() => {
        fetchMagicSort().then(setMagicData).catch(e => setMagicError(String(e.message ?? e)));
    }, []);
    // Today's unique-visitor count for the status bar (public endpoint). Polled
    // lightly (every 2 min) so it stays current; failures are silent - the badge
    // just doesn't render.
    useEffect(() => {
        let alive = true;
        const load = () => fetchDailyVisitors().then(v => { if (alive) setVisitors(v); }).catch(() => {});
        load();
        const id = setInterval(load, 120000);
        return () => { alive = false; clearInterval(id); };
    }, []);
    // Persisted magic entries revalidate against the fetched strategy list
    // (catalog-sanitizer idiom): a renamed/retired strategy drops out of the
    // chain. Column entries pass through - orderRows tolerates unknown keys.
    const activeChain = useMemo(() => {
        if (!magicData) return sortChain;
        const ids = new Set(magicData.strategies.map(s => s.id));
        // 'sure' is the built-in default sort and is always scoreable client-side
        // (it lives in the imported STRATEGIES), so never prune it even if a stale
        // payload omits it - otherwise the default sort would silently vanish.
        return sortChain.filter(e => e.type !== 'magic' || ids.has(e.id) || e.id === 'sure');
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
    // Leaf-condition count (filters can be a flat array or a nested group).
    const filterCount = conditionCount(filters);
    // Column descriptors for the client engine: the FULL catalog (plus the
    // table-only score column), independent of visible-column selections -
    // hidden columns still filter because rows carry every field.
    const filterColumns = useMemo(() => (catalog ? [
        ...catalog.base.map(c => ({ key: c.key, group: 'base' })),
        { key: 'score', group: 'base' },
        { key: 'no', group: 'base' }, // synthetic row-number (R27d), filterable via _no
        ...catalog.markets.map(c => ({ key: c.key, group: 'market' })),
        ...catalog.stats.map(c => ({ key: c.key, group: 'stat' })),
    ] : []), [catalog]);
    // Selection-stamped + hide-cut data: the single upstream source every record
    // view derives from, so "Hide selection" removes checked rows from the table,
    // the filter option lists, the day calcs AND the betslip pool at once. Each
    // row gains a `select` boolean (identity = match_id), which also powers the
    // Select column and the Select filter field.
    const stampedData = useMemo(() => stampSelection(result?.data ?? [], selection), [result, selection]);
    // Load-order anchor for the synthetic "No" column (R27): each loaded row's
    // 1-based position in the fetched set, rebuilt only when a new fetch lands
    // (result reference) - client-filter edits and selection changes never touch
    // `result`, so the numbering stays put. Stamping `_no` HERE (upstream of the
    // client filters, R27d) is what lets `no` be a FILTERABLE field, not just a
    // sortable/display column; the DataTable reads the same `_no`.
    const noAnchor = useMemo(() => {
        const m = new Map();
        let i = 0;
        for (const r of result?.data ?? []) if (!m.has(r.match_id)) m.set(r.match_id, ++i);
        return m;
    }, [result]);
    const numberedData = useMemo(() => {
        for (const r of stampedData) r._no = noAnchor.get(r.match_id) ?? null;
        return stampedData;
    }, [stampedData, noAnchor]);
    // Selection view cut: Hide selection drops checked rows, Keep selection drops
    // UNCHECKED rows (inverse). Applied here so it flows into the table, filter
    // options, day calcs AND the betslip pool at once. The two are mutually
    // exclusive in the UI, so at most one ever narrows the set.
    const visibleData = useMemo(
        () => applySelectionKeep(applySelectionHide(numberedData, hideSelected), keepSelected),
        [numberedData, hideSelected, keepSelected],
    );
    const visibleBaseSet = useMemo(() => (visibleBaseKeys ? new Set(visibleBaseKeys) : null), [visibleBaseKeys]);
    // Market/stat keys present in the loaded day - drives date-dynamic option
    // lists in the settings selectors and the filter builder (absent columns
    // are omitted so the controls honestly reflect the day). Recomputes on
    // date/refresh via `result`.
    const available = useMemo(
        () => availableColumnKeys(visibleData, catalog),
        [visibleData, catalog],
    );
    // Safe picks are day-level over the whole loaded selection (result.data),
    // NOT the filtered rows - other toggles/filters must not change who wins
    // the per-day cap, and the footer count stays honest. One representative
    // row per fixture; the table filters by api_id membership.
    const safePicks = useMemo(
        () => safeSelection(visibleData, cal, effectiveSafe),
        [visibleData, cal, effectiveSafe],
    );
    // Sure-bets picks: the day's top-10 by calibrated leg prob over the WHOLE
    // loaded selection - same day-level scope as safePicks, so other toggles/
    // filters never change who makes the list. Gates = the spec-PINNED
    // DEFAULT_SAFE literals (safeQualifies' fallback), deliberately NOT
    // effectiveSafe: the design evidence (~8-9 legs/day) holds only for those
    // values, v1 ships no env/user tunability (spec §5), and a host whose
    // SAFE_* env tightens the gates (e.g. minParts 3) would starve Sure bets
    // to permanent zero-days ("tighter starves", spec §2 - live-verified on
    // this host). Cap/slip size pinned by DEFAULT_SURE_BETS. Empty for guests
    // (their rows lack tip_breakdown; the magic sheet shows a sign-in nudge).
    const signedIn = !!session?.user;
    const surePicks = useMemo(
        () => (signedIn ? sureBetsSelection(visibleData, cal, DEFAULT_SURE_BETS) : []),
        [signedIn, visibleData, cal],
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
            applyClientFilters(visibleData, clientFilters, filterColumns),
            { hideHits, hideMiss, noMiss },
        );
        // Risk gate: when a magic sort or Safe-only is active, drop thin-evidence
        // (risky) games using the same sufficiency gate as the server safe pool.
        if (riskGate && (activeMagicIds.length > 0 || safeOnly)) {
            out = applyRiskGate(out, effectiveSafe);
        }
        if (safeOnly) {
            const ids = new Set(safePicks.map(r => r.api_id));
            out = out.filter(r => ids.has(r.api_id));
        }
        // Sure bets: same membership idiom as Safe-only - all provider rows of
        // a listed fixture survive; independent of the Safe-only toggle (both
        // on = AND; Sure bets ⊆ safe pool, so Sure bets effectively wins).
        if (sureBets && signedIn) {
            const ids = new Set(surePicks.map(e => e.row.api_id));
            out = out.filter(r => ids.has(r.api_id));
        }
        // One-of-each collapses to a single row per game (highest-priority
        // enabled provider); loaded rows are already the enabled providers.
        if (oneEach) out = applyOneOfEach(out, orderedProviders);
        return out;
    }, [visibleData, clientFilters, filterColumns, hideHits, hideMiss, noMiss, riskGate, activeMagicIds, effectiveSafe, safeOnly, safePicks, sureBets, signedIn, surePicks, oneEach, orderedProviders]);
    // Day-level hit-rate scoreboard: computed over the whole loaded selection
    // (result.data), NOT the client-filtered rows - the KPI reflects the day's
    // picks and stays stable when you filter or hide rows in the view.
    const dayRates = useMemo(() => _hitRates(visibleData), [visibleData]);
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
        // Only constrain providers when a strict subset is chosen
        const reqProviders = providerKeys && selectedProviders.length < providers.length ? selectedProviders : null;
        // The exact query this fetch represents. `lastQueryRef` doubles as the
        // "current query" marker: a response is applied only while it still holds
        // this key, so a superseded (stale) response is ignored WITHOUT a per-run
        // cleanup flag. That also lets us skip a re-run whose query is
        // byte-identical (defense-in-depth: an unstable-reference dep would
        // otherwise refetch every render) - safe precisely because an unchanged
        // query leaves any in-flight fetch valid. A zero-record result never
        // mutates these inputs, so it can never re-trigger the effect.
        // The session token is part of the query identity (Phase 8): the same
        // date returns a different tier (guest redacted vs full) depending on
        // the bearer, so login/logout/session-expiry must refetch.
        const queryKey = `${date || 'all'}|${serverFiltersKey}|${showCompleted}|${JSON.stringify(reqProviders)}|${refreshTick}|${session?.token ?? ''}`;
        if (lastQueryRef.current === queryKey) return;
        lastQueryRef.current = queryKey;
        const current = () => lastQueryRef.current === queryKey;
        // Silent background reloads (auto-refresh landed new data) skip the
        // loading dim - the table just updates in place.
        if (!silentRef.current) setLoading(true);
        fetchRecords({ date: date || 'all', filters: serverFilters, completed: showCompleted, providers: reqProviders })
            .then(res => { if (current()) { setResult(res); setError(null); setSignInNeeded(false); } })
            .catch(e => {
                if (!current()) return;
                // Guest hit the future-date ceiling: swap the table for the
                // sign-in panel, not the transient error banner.
                if (e?.status === 403 && e?.body?.auth_required) { setResult(null); setSignInNeeded(true); }
                else setError(String(e.message ?? e));
            })
            .finally(() => { if (current()) { silentRef.current = false; setLoading(false); } });
    }, [date, serverFiltersKey, refreshTick, showCompleted, providerKeys, selectedProviders, providers.length, session?.token]);

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

    // Re-read the betslip stake whenever the slips modal closes (that's the only
    // place it's edited), so the footer ledger reflects the latest value.
    useEffect(() => {
        if (!showSlips) setBetslipStake(_loadBetslipStake());
    }, [showSlips]);

    // Back/forward restore the date encoded in the URL
    useEffect(() => {
        const onPop = () => setDate(_dateFromUrl() ?? _today());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    // Load the persisted row selection for the newly-shown date (selections are
    // per-date, keyed by match_id, so they survive filtering AND reload).
    useEffect(() => {
        setSelection(new Set(_load(_selectKey(date)) ?? []));
    }, [date]);

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
                        // Never surface the raw job error (it can be a ~2 KB SQL
                        // dump, e.g. a transient deadlock). The full detail lives
                        // in console.error + logs/auto-refresh.log server-side.
                        if (st.error) setError('Refresh failed - please try again in a moment.');
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
                setNotice(`Already fresh${mins ? ` - refreshed ${mins}m ago` : ''}. Reloading the view.`);
                setRefreshTick(t => t + 1);
                return;
            }
            setRefresh(body);
        } catch (e) {
            setError(String(e.message ?? e));
        }
    };

    // Every chain mutation persists (paired-save idiom). Wrapped in a transition
    // so re-sorting a big day (magic sort included) stays interruptible and
    // never blocks the click - the sheet closes instantly, the table catches up.
    const setSortChainPersist = useCallback(updater => {
        startTransition(() => {
            setSortChain(prev => {
                const next = typeof updater === 'function' ? updater(prev) : updater;
                localStorage.setItem(LS_SORT, JSON.stringify(next));
                return next;
            });
        });
    }, [startTransition]);

    // Filter apply/clear is a heavy re-filter+re-sort too - same transition.
    const applyFilters = useCallback(f => startTransition(() => setFilters(f)), [startTransition]);

    // Delayed spinner: show the table's loading overlay only if a transition
    // outlasts the threshold, so fast changes never flash a spinner.
    useEffect(() => {
        if (!isPending) { setShowPending(false); return; }
        const t = setTimeout(() => setShowPending(true), PENDING_SPINNER_MS);
        return () => clearTimeout(t);
    }, [isPending]);

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
    // Persist a full provider priority order (ReorderList "move to position #").
    const reorderProviders = keys => {
        setProviderOrder(keys);
        localStorage.setItem(LS_PROVIDER_ORDER, JSON.stringify(keys));
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
    const saveSureBets = value => {
        setSureBets(value);
        localStorage.setItem(LS_SURE_BETS, value ? '1' : '0');
    };
    // "Top-3 slip" (magic sheet): seed a slip from the top sure-bets legs into
    // the persisted book, then open the playground (it reads storage on mount).
    const seedTopSlip = () => {
        if (!surePicks.length) return;
        seedSlip(surePicks.slice(0, DEFAULT_SURE_BETS.slipSize), date || 'all', 'Sure top-3');
        setShowMagic(false);
        setShowSlips(true);
    };
    const saveRiskGate = value => {
        setRiskGate(value);
        localStorage.setItem(LS_RISK_GATE, value ? '1' : '0');
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
    // Row selection (persist per current date).
    const saveSelection = next => {
        setSelection(next);
        const key = _selectKey(date);
        if (next.size) localStorage.setItem(key, JSON.stringify([...next]));
        else localStorage.removeItem(key);
    };
    const toggleSelect = id => {
        const next = new Set(selection);
        next.has(id) ? next.delete(id) : next.add(id);
        saveSelection(next);
    };
    // Bulk selection actions (the Select-column header menu). Select All /
    // Invert act on the VISIBLE rows (`rows`) - WYSIWYG; Select Similar / Keep
    // One Provider reach the whole loaded day (`stampedData`) so they find api_id
    // siblings / lower-priority provider peers even when a filter hid them.
    const selectAllShown = () => saveSelection(unionSelectionIds(rows, selection));
    const deselectAll = () => saveSelection(new Set());
    const invertShown = () => saveSelection(invertSelectionIds(rows, selection));
    const selectSimilar = () => saveSelection(selectSimilarIds(stampedData, selection));
    const keepOneProvider = () => saveSelection(keepOneProviderIds(stampedData, selection, orderedProviders));
    // Export the selected rows as a full-record CSV (all fields incl. the ones
    // hidden from the table + every market/stat). Acts on the SELECTION, so it
    // ignores the Hide-selection cut (stampedData, not visibleData).
    const exportSelection = () => {
        const records = stampedData.filter(r => r.select);
        if (!records.length) return;
        const csv = buildRecordCsv(records, catalog);
        const blob = new Blob([String.fromCharCode(0xFEFF) + csv], { type: 'text/csv;charset=utf-8' }); // BOM helps Excel detect UTF-8
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `oddspro-selection-${date || 'all'}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };
    // Base/synthetic column visibility. Hiding the Select column clears the
    // current date's selection (R28a).
    const saveVisibleBase = keys => {
        setVisibleBaseKeys(keys);
        localStorage.setItem(LS_COLS_BASE, JSON.stringify(keys));
        if (!keys.includes('select')) saveSelection(new Set());
    };
    const saveNoPin = value => {
        setNoPin(value);
        localStorage.setItem(LS_NO_PIN, value ? '1' : '0');
    };
    const savePrioritizeSelected = value => {
        setPrioritizeSelected(value);
        localStorage.setItem(LS_PRIORITIZE_SEL, value ? '1' : '0');
    };
    // Hide / Keep selection are opposites - turning one on clears the other so
    // the view can never be emptied by both narrowing at once.
    const saveHideSelected = value => {
        setHideSelected(value);
        localStorage.setItem(LS_SELECT_HIDE, value ? '1' : '0');
        if (value && keepSelected) {
            setKeepSelected(false);
            localStorage.setItem(LS_SELECT_KEEP, '0');
        }
    };
    const saveKeepSelected = value => {
        setKeepSelected(value);
        localStorage.setItem(LS_SELECT_KEEP, value ? '1' : '0');
        if (value && hideSelected) {
            setHideSelected(false);
            localStorage.setItem(LS_SELECT_HIDE, '0');
        }
    };
    // Props for the Select-header bulk-actions menu: the tri-state indicator
    // state, the toggle flags (Hide/Keep selection + Prioritize) and every
    // action handler, bundled so DataTable can forward them verbatim.
    const bulk = {
        selectionCount: selection.size,
        hideSelected, hideUnselected: keepSelected, prioritizeSelected,
        onSelectAll: selectAllShown,
        onDeselectAll: deselectAll,
        onInvert: invertShown,
        onSelectSimilar: selectSimilar,
        onKeepOneProvider: keepOneProvider,
        onToggleHideSelected: () => saveHideSelected(!hideSelected),
        onToggleHideUnselected: () => saveKeepSelected(!keepSelected),
        onTogglePrioritize: () => savePrioritizeSelected(!prioritizeSelected),
        onExportCsv: exportSelection,
    };

    const TODAY = _today();
    const DAY_MS = 86400000;
    const MIN_DATE = '2026-07-05';
    // Guests browse up to today only (Phase 8) - the server enforces the same
    // ceiling (403 on future dates), this clamp is just the honest UI. Only
    // once session hydration settled: a stored sign-in must not flash a
    // clamped calendar at mount.
    const guestClamp = !!session?.isGuest && session?.status === 'ready';
    const MAX_DATE = guestClamp ? TODAY : new Date(new Date().setHours(13) + DAY_MS * 7).toISOString().substring(0,10);
    // date can be '' (All dates) - anchor the chevrons on today then.
    const PREV_DATE = new Date(new Date(date || TODAY).setHours(13) - DAY_MS).toISOString().substring(0,10);
    const NEXT_DATE = new Date(new Date(date || TODAY).setHours(13) + DAY_MS).toISOString().substring(0,10);

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
                <div ref={calWrapRef} className="relative flex items-center gap-0.5 justify-self-center">
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
                        title={guestClamp && date >= MAX_DATE ? 'Sign in to see upcoming games' : `Next (${NEXT_DATE})`}
                        aria-label="Next day" className={navBtn}>
                        <IconChevronRight />
                    </button>
                    {showCal && (
                        <CalendarPopover date={date} today={TODAY} min={MIN_DATE} max={MAX_DATE}
                            onPick={d => changeDate(d)} onClose={() => setShowCal(false)} />
                    )}
                </div>
                {/* Right: full action row (>=sm) or ⋯ overflow (<sm) */}
                <div className="relative flex items-center justify-self-end">
                    {/* Tiny greyed build version, tucked under the right icons (E4) -
                        absolute + pointer-events-none so it never shifts or blocks them. */}
                    <span className="hidden sm:block absolute right-1 -bottom-1 text-[9px] leading-none text-label-3 tabular-nums pointer-events-none">
                        v{__APP_VERSION__}
                    </span>
                    <div className="hidden sm:flex items-center gap-0.5">
                        <button onClick={onRefresh} disabled={!date || refresh?.running}
                            aria-label={refresh?.running ? 'Refreshing' : 'Refresh this date'}
                            title={refresh?.running
                                ? `Refreshing ${refresh.date}${refresh.step ? ` - ${refresh.step}` : ''}…`
                                : date
                                    ? `Refresh fixtures, results & odds${refresh?.last_success ? ` - last ${_hm(refresh.last_success.at)}` : ''}`
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
                        <button onClick={() => setShowFilters(v => !v)} aria-label={`Filters${filterCount ? ` (${filterCount} active)` : ''}`} title="Filter the table rows"
                            className={(showFilters || filterCount) ? navBtnActive : navBtn}>
                            <IconFilter />{filterCount ? <span className="text-[11px] tabular-nums ml-0.5">{filterCount}</span> : null}
                        </button>
                        <div className="w-px h-5 bg-separator mx-1.5" />
                        <button onClick={() => setShowHelp(true)} aria-label="Help" title="Help - what Odds Pro does + demo video" className={navBtn}><IconHelp /></button>
                        <button onClick={() => setShowSettings(true)} aria-label="Display settings" title="Display settings" className={navBtn}><IconGear /></button>
                        <AvatarMenu btnCls={navBtn} activeCls={navBtnActive} />
                    </div>
                    <div ref={overflowWrapRef} className="relative sm:hidden">
                        <button onClick={() => setShowOverflow(v => !v)} aria-label="More actions" title="More"
                            className={showOverflow ? navBtnActive : navBtn}><IconMenu /></button>
                        {showOverflow && (
                            <OverflowMenu
                                refreshing={refresh?.running} canRefresh={!!date && !refresh?.running}
                                filterCount={filterCount} magicActive={activeMagicIds.length > 0}
                                onRefresh={() => { onRefresh(); setShowOverflow(false); }}
                                onMagic={() => { setShowMagic(true); setShowOverflow(false); }}
                                onSlips={() => { setShowSlips(true); setShowOverflow(false); }}
                                onFilters={() => { setShowFilters(v => !v); setShowOverflow(false); }}
                                onHelp={() => { setShowHelp(true); setShowOverflow(false); }}
                                onSettings={() => { setShowSettings(true); setShowOverflow(false); }}
                                user={session?.user}
                                onSignIn={() => { session?.openAuth('signin'); setShowOverflow(false); }}
                                onSignUp={() => { session?.openAuth('signup'); setShowOverflow(false); }}
                                onProfile={() => { session?.openAuth('profile'); setShowOverflow(false); }}
                                onAdmin={() => { session?.openAuth('admin'); setShowOverflow(false); }}
                                onSyncPrefs={() => { session?.syncPrefs(); setShowOverflow(false); }}
                                onLogout={() => { session?.logout(); setShowOverflow(false); }}
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
                <ViewPills
                    showCompleted={showCompleted} hideHits={hideHits} hideMiss={hideMiss}
                    noMiss={noMiss} safeOnly={safeOnly} oneEach={oneEach} filterCount={filterCount}
                    sureBets={sureBets && signedIn} sureCount={surePicks.length}
                    sureCap={DEFAULT_SURE_BETS.maxPerDay} onSureBets={saveSureBets}
                    hideSelected={hideSelected} hideUnselected={keepSelected}
                    riskGate={riskGate} riskGateActive={activeMagicIds.length > 0 || safeOnly}
                    onShowCompleted={saveShowCompleted} onHideHits={saveHideHits} onHideMiss={saveHideMiss}
                    onNoMiss={saveNoMiss} onSafeOnly={saveSafeOnly} onOneEach={saveOneEach}
                    onHideSelected={saveHideSelected} onHideUnselected={saveKeepSelected} onRiskGate={saveRiskGate}
                    onOpenFilters={() => setShowFilters(true)} onClearFilters={() => applyFilters([])}
                />
                {signInNeeded ? (
                    /* Guest asked for a future date: the server answered 403
                       auth_required (Phase 8). A calm sign-in invitation in
                       place of the table - signing in refetches by itself
                       (the session token is part of the fetch query key). */
                    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center px-6">
                        <IconUser className="w-9 h-9 text-label-3" />
                        <div className="text-[17px] font-semibold text-label">Sign in to see upcoming games</div>
                        <div className="text-[13px] text-label-2 max-w-sm">
                            Games after today - with their odds and tips - are for signed-in members.
                        </div>
                        <button onClick={() => session?.openAuth('signin')}
                            className="cursor-pointer mt-2 h-10 px-5 rounded-[10px] bg-accent text-white text-[15px] font-semibold hover:opacity-90">
                            Sign in
                        </button>
                        <button onClick={() => changeDate(TODAY)}
                            className="cursor-pointer text-[13px] text-accent hover:underline">
                            Back to today
                        </button>
                    </div>
                ) : (
                <DataTable
                    catalog={catalog}
                    rows={rows}
                    marketKeys={selectedMarkets}
                    statKeys={selectedStats}
                    columnOrder={columnOrder}
                    chain={activeChain}
                    cal={cal}
                    onSort={onSort}
                    loading={loading || showPending}
                    linkProviders={linkProviders}
                    visibleBase={visibleBaseSet}
                    selection={selection}
                    onToggleSelect={toggleSelect}
                    bulk={bulk}
                    noPin={noPin}
                    filterCount={filterCount}
                    onClearFilters={() => applyFilters([])}
                    scrollKey={`${date || 'all'}|${serverFiltersKey}|${showCompleted}`}
                />
                )}
            </main>

            {/* Status bar: a normal flex child of the app shell (no longer fixed).
                Whole items wrap to more rows on narrow widths; refresh/last-refresh
                state now lives on the toolbar sync button, not here. */}
            {(() => {
                const total = result?.data?.length ?? 0;
                const filtered = rows.length !== total;
                // Betting ledger over the rows CURRENTLY SHOWN (recomputes as the
                // table re-renders): each displayed pick = one flat betslip-stake
                // bet, one per fixture. Count, total odds, potential value, and the
                // settled wins/losses/P-L.
                const bet = displayedSummary(rows, betslipStake);
                return (
                    <footer className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 bg-nav/95 [backdrop-filter:blur(25px)_saturate(180%)] border-t border-separator text-[11px] text-label-2 tabular-nums z-20">
                        {/* Day KPIs - compact (percent only; fractions in tooltips).
                            One flex row, gap-spaced (no ragged "·" separators). */}
                        <div className="flex items-center gap-x-3">
                            <Tooltip content={`${filtered ? `${rows.length} of ${total}` : total} record${total === 1 && !filtered ? '' : 's'} for this view.`}>
                                <span className="whitespace-nowrap font-medium text-label">{filtered ? `${rows.length}/${total}` : total}</span>
                            </Tooltip>
                            <Tooltip content={`Over 2.5 hot picks: ${_rate(dayRates.hot)} settled. Day-level - unaffected by view filters.`}>
                                <span className="whitespace-nowrap"><span className="text-hot">🔥</span> {_ratePct(dayRates.hot)}</span>
                            </Tooltip>
                            <Tooltip content={`Tips: ${_rate(dayRates.tips)} settled (AI-vetoed included). Day-level - unaffected by view filters.`}>
                                <span className="whitespace-nowrap">Tips {_ratePct(dayRates.tips)}</span>
                            </Tooltip>
                            {/* R26c: 2nd/3rd-choice hit-rates, muted, only when present */}
                            {dayRates.up2.settled > 0 && (
                                <Tooltip content={`If you'd taken the 2nd / 3rd-choice tip instead: 2nd ${_rate(dayRates.up2)}, 3rd ${_rate(dayRates.up3)} (graded from the final score).`}>
                                    <span className="whitespace-nowrap text-label-3">2·{_ratePct(dayRates.up2)} 3·{_ratePct(dayRates.up3)}</span>
                                </Tooltip>
                            )}
                            <Tooltip content={`Games passing the safety checks for multi-bet slips (signals agree, none weak, short odds, best ${safeCap}/day). Turn on 'Safe only' in Settings to show just these.`}>
                                <span className={`whitespace-nowrap ${safeOnly ? 'text-accent' : ''}`}>🛡 {safePicks.length}</span>
                            </Tooltip>
                        </div>
                        {/* Ledger over the rows shown - each pick a flat-stake bet */}
                        {bet.picks > 0 && (
                            <div className="flex items-center gap-x-3 sm:border-l sm:border-separator sm:pl-4">
                                <Tooltip content={`The rows shown as flat ${_money(betslipStake)}-unit bets, one per fixture: ${bet.picks} pick${bet.picks === 1 ? '' : 's'} staking ${_money(betslipStake * bet.picks)}. Stake comes from the betslip playground.`}>
                                    <span className="whitespace-nowrap">💰 {bet.picks}</span>
                                </Tooltip>
                                <Tooltip content={`Sum of the ${bet.picks} picks' odds (total odds).`}>
                                    <span className="whitespace-nowrap">Σ{_money(bet.totalOdds)}</span>
                                </Tooltip>
                                <Tooltip content={`Potential return if every shown pick won: stake × total odds = ${_money(bet.value)}. A ceiling, not a forecast.`}>
                                    <span className="whitespace-nowrap text-label-3">≈{_money(bet.value)}</span>
                                </Tooltip>
                                {bet.settled > 0 && (
                                    <>
                                        <Tooltip content={`Settled shown picks at ${_money(betslipStake)}/pick: ${bet.won} won, ${bet.lost} lost.`}>
                                            <span className="whitespace-nowrap"><span className="text-hit">{bet.won}✓</span> <span className="text-miss">{bet.lost}✗</span></span>
                                        </Tooltip>
                                        <Tooltip content={`P/L over settled shown picks: staked ${_money(bet.staked)}, returned ${_money(bet.returned)}, P/L = returned − staked (pending not counted).`}>
                                            <span className={`whitespace-nowrap font-semibold ${bet.profit >= 0 ? 'text-hit' : 'text-miss'}`}>
                                                {bet.profit >= 0 ? '+' : ''}{_money(bet.profit)}
                                            </span>
                                        </Tooltip>
                                    </>
                                )}
                            </div>
                        )}
                        {/* Daily unique visitors, right-justified (ml-auto pushes it to
                            the far end on one line, wraps under on narrow widths). */}
                        {visitors && (
                            <Tooltip content={`${visitors.unique} unique visitor${visitors.unique === 1 ? '' : 's'} today (${visitors.total} page view${visitors.total === 1 ? '' : 's'}), by IP in East Africa Time.`}>
                                <span className="ml-auto whitespace-nowrap text-label-3">👤 {visitors.unique}</span>
                            </Tooltip>
                        )}
                    </footer>
                );
            })()}

            {showMagic && (
                <MagicMenu data={magicData} error={magicError} activeIds={activeMagicIds}
                    onToggle={id => { onToggleMagic(id); setShowMagic(false); }}
                    onClearMagic={onClearMagic} onClose={() => setShowMagic(false)}
                    signedIn={signedIn} sureBets={sureBets} sureCount={surePicks.length}
                    sureCap={DEFAULT_SURE_BETS.maxPerDay} slipSize={DEFAULT_SURE_BETS.slipSize}
                    onSureBets={saveSureBets} onTopSlip={seedTopSlip} />
            )}

            {showFilters && catalog && (
                <Sheet onClose={() => setShowFilters(false)} className="max-w-2xl">
                    <FilterBuilder
                        catalog={catalog}
                        available={available}
                        rows={visibleData}
                        filterColumns={filterColumns}
                        filters={filters}
                        onApply={applyFilters}
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
                    baseColOptions={BASE_COL_OPTIONS}
                    visibleBaseKeys={visibleBaseKeys}
                    onVisibleBase={saveVisibleBase}
                    noPin={noPin}
                    onNoPin={saveNoPin}
                    onToggleProvider={toggleProvider}
                    onMoveProvider={moveProvider}
                    onReorderProviders={reorderProviders}
                    onLinkProviders={saveLinkProviders}
                    onShowCompleted={saveShowCompleted}
                    onHideHits={saveHideHits}
                    onHideMiss={saveHideMiss}
                    onNoMiss={saveNoMiss}
                    onOneEach={saveOneEach}
                    onSafeOnly={saveSafeOnly}
                    riskGate={riskGate}
                    onRiskGate={saveRiskGate}
                    onClose={() => setShowSettings(false)}
                />
            )}
        </div>
    );
}
