import { db } from './db/connection.js';
import { simulateStrategies } from './db/magic-rules.js';
import { effective } from './settings.js';

// The Safe-only policy (DEFAULT_SAFE overridden by SAFE_* env, then by any admin
// override via the dynamic-settings service), shipped to the client so the
// browser's 🛡 toggle uses the SAME gates/cap as the server. Late-read via
// settings.effective, so an admin edit takes effect on the next request.
const safePolicy = () => ({
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
            db.raw('COALESCE(f.ft_home, f.goals_home) as fh'),
            db.raw('COALESCE(f.ft_away, f.goals_away) as fa'),
        );
}

// Uncached compute over the settled-tip ledger. Deliberately does NOT carry
// the safe policy - that is attached fresh per response (magicSortCached) so
// a live admin SAFE_* edit reaches browsers immediately instead of hiding in
// the per-day cache until the next day / ?refresh=1 (M6).
export async function magicSortSummary() {
    const rows = await settledTipRows();
    // tipView (magic-rules) coerces DECIMAL strings and parses breakdown JSON
    return { generated_at: new Date().toISOString(), ...simulateStrategies(rows) };
}

// Per-day in-memory cache: the settled ledger only grows when the hotpicks
// settle pass runs, so recomputing once per EAT day (or on ?refresh=1 /
// server restart) is plenty. Concurrent callers share one in-flight promise;
// a failed compute clears the slot so the next request retries.
const _cache = { day: null, promise: null };

export async function magicSortCached(refresh = false) {
    const today = new Date().toDateString(); // server-local day key
    if (refresh || !_cache.promise || _cache.day !== today) {
        _cache.day = today;
        _cache.promise = magicSortSummary().catch(e => {
            _cache.promise = null;
            throw e;
        });
    }
    // safe policy late-read PER RESPONSE, never cached (M6): the browser's 🛡
    // toggle must see an admin SAFE_* edit on its next fetch.
    return { ...(await _cache.promise), safe: safePolicy() };
}
