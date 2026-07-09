import { db } from './db/connection.js';
import { simulateStrategies } from './db/magic-rules.js';

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

// Uncached compute over the settled-tip ledger.
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
    return _cache.promise;
}
