import { db } from './db/connection.js';
import { simulateStrategies } from './db/magic-rules.js';
import { loadCalibrator } from './daily-slip.js';
import { effective } from './settings.js';
import { getMeta, setMeta } from './meta.js';
import { debugLog } from './utils.js';
import { queryCacheKey } from './db/cache-rules.js';

// The Safe-only policy (DEFAULT_SAFE overridden by SAFE_* env, then by any admin
// override via the dynamic-settings service), shipped to the client so the
// browser's 🛡 toggle uses the SAME gates/cap as the server. Late-read via
// settings.effective, so an admin edit takes effect on the next request.
export const safePolicy = () => ({
    strategy: effective('SAFE_STRATEGY'),
    minParts: effective('SAFE_MIN_PARTS'),
    minAgreement: effective('SAFE_MIN_AGREEMENT'),
    maxPrice: effective('SAFE_MAX_PRICE'),
    maxPerDay: effective('SAFE_MAX_PER_DAY'),
    minSamples: effective('SAFE_MIN_SAMPLES'),   // sufficiency ("exclude risky") gate
    minH2H: effective('SAFE_MIN_H2H'),
    minMarketSettled: effective('SAFE_MIN_MARKET_SETTLED'), // per-market maturity floor (spec §5)
});

// Magic-sort loader: replay the candidate tip-ranking strategies against
// every settled tip (src/db/magic-rules.js) and serve the top strategies +
// the live calibration the web table scores today's rows with. Thin loader
// over the pure module, same idiom as performanceSummary().

// The settled-tip ledger, shared by the loader and the analysis script
// (scripts/analyze-safe-tips.js) so the two can never drift. DATE_FORMAT
// keeps the day-grouping inside MySQL's pinned +03:00 session (EAT wall-clock
// days) - a JS Date round-trip would re-interpret midnight kickoffs. The
// final score pair (fh/fa) rides along for the script's runner-up re-tests;
// simulateStrategies ignores it.
export async function settledTipRows() {
    return db('fixture_predictions as p')
        .join('fixtures as f', 'f.id', 'p.fixture_id')
        .whereNotNull('p.tip_outcome')
        .select(
            db.raw("DATE_FORMAT(f.kickoff, '%Y-%m-%d') as day"),
            'p.tip_market', 'p.tip_price', 'p.tip_confidence', 'p.tip_outcome',
            'p.tip_breakdown', 'p.tip_ai_verdict',
            // Banker columns (Phase 3): the v2 strategies and analysis
            // scripts read them off the same ledger rows.
            'p.tip_banker_market', 'p.tip_banker_price', 'p.tip_banker_prob', 'p.tip_banker_cal', 'p.tip_banker_outcome',
            db.raw('COALESCE(f.ft_home, f.goals_home) as fh'),
            db.raw('COALESCE(f.ft_away, f.goals_away) as fa'),
        );
}

// Uncached compute over the settled-tip ledger. Deliberately does NOT carry
// the safe policy - that is attached fresh per response (magicSortCached) so
// a live admin SAFE_* edit reaches browsers immediately instead of hiding in
// the per-day cache until the next day / ?refresh=1 (M6).
// The v2 menu (Phase 3, owner decision 4): the payload's strategy list is the
// calibration trio, ranked among themselves by the replay stats. Legacy
// scorers stay in STRATEGIES (replay/analysis + still callable on /api/view).
const V2_MENU = ['banker', 'target', 'value'];

export async function magicSortSummary({ rebuildCells = false } = {}) {
    const rows = await settledTipRows();
    // tipView (magic-rules) coerces DECIMAL strings and parses breakdown JSON
    // topN 99 = the FULL ranked list, so the trio is always present to filter.
    const summary = simulateStrategies(rows, { topN: 99 });
    summary.strategies = summary.strategies.filter(s => V2_MENU.includes(s.id));
    // The leg-cell layer (Phase 3): walk-forward menu-leg calibration cells,
    // attached so client and server score with ONE layer (estimateLegProb,
    // bankerProb, the v2 strategies). ~80 cells, a few KB.
    summary.calibration.leg_cells = await todaysLegCells({ rebuild: rebuildCells });
    return { generated_at: new Date().toISOString(), ...summary };
}

// The leg cells, built once per EAT day and kept in `meta` (the pick_cells
// idiom, src/picks.js). Measured 2026-10-18 on the local warehouse: the cold
// /api/magic-sort compute was 266 s, of which loadCalibrator's 90-day
// odds_markets window was 261 s (settled ledger 3.5 s, replay 1.1 s). The
// cells only depend on settled data before today, so a restart, a second
// instance or the next day-memo miss rehydrates ~80 cells from one meta row
// instead of re-reading millions of odds rows. ?refresh=1 rebuilds them.
export const LEG_CELLS_KEY = 'leg_cells';

async function todaysLegCells({ rebuild = false } = {}) {
    const today = (await db.raw("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as d"))[0][0].d;
    if (!rebuild) {
        const memo = await getMeta(LEG_CELLS_KEY).catch(() => null);
        if (memo?.day === today && memo.cells) return memo.cells;
    }
    const t0 = Date.now();
    const cells = (await loadCalibrator(today)).export();
    await setMeta(LEG_CELLS_KEY, { day: today, cells });
    debugLog(`magic-sort: leg cells for ${today} built in ${Date.now() - t0}ms`);
    return cells;
}

// Per-day in-memory cache: the settled ledger only grows when the hotpicks
// settle pass runs, so recomputing once per EAT day (or on ?refresh=1 /
// server restart) is plenty. Concurrent callers share one in-flight promise;
// a failed compute clears the slot so the next request retries.
// Stale-while-revalidate across the day rollover: the first call of a new
// day starts that day's compute and answers with the previous day's summary
// (`stale`) until it resolves, so the visitor who arrives just after
// midnight never waits on a cold build. A cold boot has nothing stale and
// waits; ?refresh=1 always waits for the fresh result.
const _cache = { day: null, promise: null, value: null, stale: null };

export async function magicSortCached(refresh = false) {
    const today = new Date().toDateString(); // server-local day key
    if (refresh || !_cache.promise || _cache.day !== today) {
        if (_cache.day !== today) { _cache.stale = _cache.value; _cache.value = null; }
        _cache.day = today;
        const promise = magicSortSummary({ rebuildCells: refresh });
        _cache.promise = promise;
        promise.then(
            v => { if (_cache.promise === promise) { _cache.value = v; _cache.stale = null; } },
            () => { if (_cache.promise === promise) _cache.promise = null; },
        );
    }
    const summary = !refresh && !_cache.value && _cache.stale ? _cache.stale : await _cache.promise;
    // safe policy late-read PER RESPONSE, never cached (M6): the browser's 🛡
    // toggle must see an admin SAFE_* edit on its next fetch.
    return { ...summary, safe: safePolicy() };
}

// Non-blocking read for payloads that embed a ranking (the lean
// /api/records body): today's resolved summary plus the late-read safe
// policy, or null while it is still computing - the caller ships no ranking
// rather than stalling the table behind the calibration. Never triggers a
// compute; the warm keeper and /api/magic-sort do that.
// The /api/magic-sort response memo key (route + warm keeper). The body is
// public and identical for every caller - no access tier shapes it (the
// methodology gate is the browser's own render choice), so the key carries
// no tier and every visitor shares one warmed slot. It carries what the body
// does depend on: the day, the summary's generation stamp (so the fresh
// summary replaces a stale-while-revalidate one at once) and the late-read
// safe policy (M6: an admin SAFE_* edit is a new slot on the next request,
// never a cached old policy). The memo itself is warehouse_version-keyed.
export function magicSortKey() {
    return queryCacheKey('/api/magic-sort', {
        day: new Date().toDateString(),
        gen: magicSortReady()?.generated_at ?? 'pending',
        safe: JSON.stringify(safePolicy()),
    });
}

export function magicSortReady() {
    const summary = _cache.day === new Date().toDateString() ? (_cache.value ?? _cache.stale) : null;
    return summary ? { ...summary, safe: safePolicy() } : null;
}
