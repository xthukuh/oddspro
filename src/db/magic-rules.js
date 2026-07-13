// Magic sort: rank a day's tips most-likely-to-win first so the top of the
// table is safe multi-bet material. Pure module (only imports the equally
// pure perf-rules bucket labelers) so tests run without .env/DB and the web
// app can import the SAME code - one scorer, no client/server drift.
//
// Two halves:
//  - calibration + strategies: computeCalibration() digests every settled
//    tip into empirical hit-rate buckets; each STRATEGIES entry scores a tip
//    from its fields and/or those buckets. Calibrated strategies are the
//    "gets better as data grows" part - live data already shows raw
//    confidence is NOT monotonic with winning (0.60-0.69 band beats 0.80+).
//  - simulation: simulateStrategies() replays every strategy against the
//    settled ledger day by day - take the top `legs` tips it would have
//    ranked, settle that virtual slip at real prices - and ranks strategies
//    by slip survival. Leave-one-day-out calibration keeps a calibrated
//    strategy from grading its own answers. Backtests, not forecasts.
// Plus the safe-only selection (safeQualifies/safeSelection): strict gates +
// per-day cap that cherry-pick multi-bet slip legs for the web's Safe-only
// toggle. Thresholds in DEFAULT_SAFE, re-tuned via scripts/analyze-safe-tips.js.
import { confidenceBand, marketGroup } from './perf-rules.js';

const _round = v => Math.round(v * 10000) / 10000 + 0; // + 0 normalizes -0

// Number or null - never NaN, never Number(null) === 0
const _num = v => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};

const _clamp01 = v => Math.min(1, Math.max(0, v));

// Normalized tip view over a fixture_predictions row - accepts both loader
// rows and web record rows (same tip_* field names; DECIMALs may be strings,
// tip_breakdown may be a JSON string, an object, or absent on pre-2026-07-04
// rows). Null when the row carries no tip.
export function tipView(r) {
    if (r == null || r.tip_market == null) return null;
    let breakdown = r.tip_breakdown ?? null;
    if (typeof breakdown === 'string') {
        try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; }
    }
    return {
        market: r.tip_market,
        price: _num(r.tip_price),
        confidence: _num(r.tip_confidence),
        outcome: r.tip_outcome ?? null,
        vetoed: r.tip_ai_verdict === 'veto',
        breakdown,
    };
}

// Price band label - boundaries bracket the observed tip price distribution
// (avg ~1.27) so each band actually accumulates samples.
export function priceBand(price) {
    if (price == null) return 'unknown';
    if (price < 1.2) return '1.00-1.19';
    if (price < 1.35) return '1.20-1.34';
    if (price < 1.55) return '1.35-1.54';
    return '1.55+';
}

const _tally = (buckets, label, hit) => {
    const b = buckets[label] ?? (buckets[label] = { n: 0, hits: 0 });
    b.n++;
    if (hit) b.hits++;
};

// Digest settled tips (tipViews) into empirical hit-rate buckets. Vetoed
// tips are included - they settle honestly and are evidence like any other.
// shrink_k travels with the object so client-side scoring shrinks the same.
export function computeCalibration(tips, shrinkK = 10) {
    const cal = {
        settled: 0, global_rate: null, shrink_k: shrinkK,
        bands: {}, groups: {}, cells: {}, lines: {}, prices: {}, markets: {},
    };
    let hits = 0;
    for (const t of tips) {
        if (!t || (t.outcome !== 'hit' && t.outcome !== 'miss')) continue;
        const hit = t.outcome === 'hit';
        cal.settled++;
        if (hit) hits++;
        const band = confidenceBand(t.confidence);
        const group = marketGroup(t.market);
        _tally(cal.bands, band, hit);
        _tally(cal.groups, group, hit);
        _tally(cal.cells, `${band}|${group}`, hit);
        if (/^[OU] /.test(String(t.market))) _tally(cal.lines, t.market, hit);
        _tally(cal.prices, priceBand(t.price), hit);
        _tally(cal.markets, String(t.market), hit);   // per-exact-market (safePrior)
    }
    cal.global_rate = cal.settled ? _round(hits / cal.settled) : null;
    return cal;
}

// Beta-style shrinkage: k pseudo-counts at the global rate pull thin buckets
// toward it, so a 2-sample 100% cell can't top a 60-sample 84% one.
export function shrunkRate(bucket, globalRate, k = 10) {
    const g = Number.isFinite(globalRate) ? globalRate : 0.5;
    if (!bucket || !Number.isFinite(bucket.n) || bucket.n <= 0) return g;
    return (bucket.hits + k * g) / (bucket.n + k);
}

// Empirical posterior for a tip: band x group cell, falling back to the
// band, then the global rate. Null when there is no calibration data.
function _bucketPosterior(tip, cal) {
    if (!cal || !cal.settled || cal.global_rate == null) return null;
    const g = cal.global_rate;
    const k = cal.shrink_k ?? 10;
    const band = confidenceBand(tip.confidence);
    const cell = cal.cells?.[`${band}|${marketGroup(tip.market)}`];
    if (cell?.n) return shrunkRate(cell, g, k);
    const bandBucket = cal.bands?.[band];
    if (bandBucket?.n) return shrunkRate(bandBucket, g, k);
    return g;
}

// Betslip-playground survival input: the tip's calibrated win probability,
// falling back to blend confidence before any data exists. Clamped away
// from 0/1 - no leg is ever certain.
export function estimateLegProb(tip, cal) {
    if (!tip) return null;
    const p = _bucketPosterior(tip, cal) ?? tip.confidence;
    return p == null ? null : _round(Math.min(0.98, Math.max(0.05, p)));
}

// Betslip per-leg market options (R26d): the chosen tip plus its stored
// runners-up (up to two), each as { market, price, prob } with the win estimate
// re-scored through the calibration for THAT market/price - so switching a leg
// to a runner-up updates its odds AND its survival honestly. Outcome grading is
// left to the caller (it needs the fixture's final score). Pure/testable:
// reuses tipView (chosen) + the runners_up carried in tip_breakdown.
export function legPicks(r, cal) {
    const chosen = tipView(r);
    if (!chosen) return [];
    const picks = [{ market: chosen.market, price: chosen.price, prob: estimateLegProb(chosen, cal) }];
    const ups = Array.isArray(chosen.breakdown?.runners_up) ? chosen.breakdown.runners_up : [];
    for (const ru of ups.slice(0, 2)) {
        if (!ru || ru.market == null) continue;
        // A runner-up carries its own blend components - wrap them as a tipView
        // so estimateLegProb buckets it exactly like the chosen tip.
        const view = { market: ru.market, price: _num(ru.price), confidence: _num(ru.confidence), breakdown: ru };
        picks.push({ market: ru.market, price: _num(ru.price), prob: estimateLegProb(view, cal) });
    }
    return picks;
}

// Warehouse out-of-sample precision anchors (scripts/backtest-sure-tips.js,
// 15k+ fixtures). Used ONLY as the beta-shrink ANCHOR for the live per-market
// hit rate - NEVER as the returned prior on their own. Stats-only precision is
// price-blind and, for goal markets, anti-correlated with live ROI (the
// adversarial review's central finding: an 87% "precise" Under is priced below
// the 1.2 floor - the bettable slice has zero edge). So the live term must
// dominate; the anchor only fills markets the live sample hasn't covered yet.
// Markets absent here fall back to the live global rate, never a hardcoded
// constant. Deliberately NO team-total / BTTS anchors - those markets are not
// tipped (their warehouse precision is a sub-1.2 price mirage) and a primed
// prior would mis-rank them if ever surfaced.
export const WAREHOUSE_WLO = {
    '1X': 0.807, 'X2': 0.669, '12': 0.777,
    'O 0.5': 0.90, 'O 1.5': 0.811, 'O 2.5': 0.683, 'O 3.5': 0.60,
    'U 3.5': 0.760, 'U 4.5': 0.868, 'U 5.5': 0.90, 'U 6.5': 0.94,
    '1': 0.58, '2': 0.50,
};

// Live-shrunk market-safety prior: the market's LIVE hit rate (cal.markets)
// beta-shrunk (k=20, warehouse-dominant until the live sample is deep) toward
// its warehouse anchor (or the live global rate when no anchor exists). This
// RESOLVES the warehouse<->live reversal the review flagged: X2's weak
// warehouse 0.669 shrinks UP toward its strong live 83.6% (~0.80), U4.5's
// strong 0.868 shrinks DOWN toward its weak live 69.3% (~0.72). So the sort
// favours what actually WINS on real odds, not price-blind stats precision,
// and self-corrects as data grows. Falls back to the anchor with no live data.
export function safePrior(market, cal, k = 20) {
    const anchor = WAREHOUSE_WLO[market] ?? (cal?.global_rate ?? 0.6);
    const bucket = cal?.markets?.[market];
    if (!bucket || !bucket.n) return _round(anchor);
    return _round((bucket.hits + k * anchor) / (bucket.n + k));
}

const _bd = tip => tip.breakdown ?? {};

const _agreementParts = tip => [_bd(tip).market_prob, _bd(tip).stats_prob, _bd(tip).api_prob]
    .map(_num).filter(v => v != null);

// Consensus worst case: the weakest of the blend components that exist -
// a tip everything likes beats a tip one signal loves. Null when the
// breakdown carries no components (pre-2026-07-04 rows).
export function tipAgreement(tip) {
    if (!tip) return null;
    const parts = _agreementParts(tip);
    return parts.length ? Math.min(...parts) : null;
}

// Candidate ranking strategies. Every scorer is total: fallback chains end
// at blend confidence (always set on a tip), so missing tip_breakdown or an
// empty calibration degrades, never throws. score() may return null - the
// row then sinks like a tipless one.
export const STRATEGIES = [
    {
        id: 'sure',
        label: 'Most likely to win',
        // The default sort. Ranks a day's tips by market-safety x blend
        // confidence, where market-safety (safePrior) is the market's LIVE hit
        // rate shrunk toward its warehouse anchor. Favours the markets that
        // actually win on real odds (double-chance result markets) over
        // price-blind "high-precision" Unders, and sharpens as data grows. In
        // the LODO ranking bake-off, safePrior x confidence lifted top-3 daily
        // precision 76.7% -> 93.3% and slip survival 4/10 -> 8-9/10.
        // HONESTY: this maximizes win PROBABILITY (slip survival), NOT profit -
        // the book's vig keeps even the best selection ~-3% flat-stake EV.
        score: (tip, cal) => (tip.confidence == null
            ? null
            : _round(safePrior(tip.market, cal) * tip.confidence)),
    },
    {
        id: 'confidence',
        label: 'Blend confidence',
        // The baseline: today's Tip sort minus its hot-boost (hot picks run
        // 58.5% live - a negative signal the ranking must not inherit).
        score: tip => tip.confidence,
    },
    {
        id: 'market',
        label: 'Market probability',
        score: tip => _num(_bd(tip).market_prob) ?? tip.confidence,
    },
    {
        id: 'stats',
        label: 'Stats support',
        score: tip => _num(_bd(tip).stats_prob) ?? _num(_bd(tip).market_prob) ?? tip.confidence,
    },
    {
        id: 'agreement',
        label: 'Component agreement',
        score: tip => tipAgreement(tip) ?? tip.confidence,
    },
    {
        id: 'edge',
        label: 'Value edge',
        // EV proxy (confidence x price - 1): ordering-only, not a probability.
        score: tip => (tip.confidence == null || tip.price == null
            ? null
            : tip.confidence * tip.price - 1),
    },
    {
        id: 'price_band',
        label: 'Price sweet spot',
        score: (tip, cal) => (cal?.settled && cal.global_rate != null
            ? shrunkRate(cal.prices?.[priceBand(tip.price)], cal.global_rate, cal.shrink_k ?? 10)
            : tip.confidence),
    },
    {
        id: 'bucket',
        label: 'Empirical bucket',
        // Historical hit rate of the tip's confidence-band x market-group
        // cell - directly exploits the live 0.60-0.69 > 0.80+ inversion.
        score: (tip, cal) => _bucketPosterior(tip, cal) ?? tip.confidence,
    },
    {
        id: 'line',
        label: 'O/U line history',
        score: (tip, cal) => {
            if (!cal?.settled || cal.global_rate == null) return tip.confidence;
            const k = cal.shrink_k ?? 10;
            const bucket = /^[OU] /.test(String(tip.market))
                ? cal.lines?.[tip.market]
                : cal.groups?.[marketGroup(tip.market)];
            return shrunkRate(bucket, cal.global_rate, k);
        },
    },
    {
        id: 'cal_conf',
        label: 'Calibrated confidence',
        score: (tip, cal) => {
            const post = _bucketPosterior(tip, cal);
            if (post == null) return tip.confidence;
            return tip.confidence == null ? post : Math.sqrt(post * tip.confidence);
        },
    },
    {
        id: 'cal_market',
        label: 'Calibrated market',
        score: (tip, cal) => {
            const market = _num(_bd(tip).market_prob) ?? tip.confidence;
            const post = _bucketPosterior(tip, cal);
            if (market == null) return post;
            if (post == null || !cal?.global_rate) return market;
            return _clamp01(market * (post / cal.global_rate));
        },
    },
];

const _byId = new Map(STRATEGIES.map(s => [s.id, s]));

// Score one records/ledger row under a strategy. Null (= sink to the table
// bottom) for tipless / skip-reason / AI-vetoed rows and unknown strategies.
export function scoreTip(row, strategyId, cal) {
    const tip = tipView(row);
    if (!tip || tip.vetoed) return null;
    const strategy = _byId.get(strategyId);
    if (!strategy) return null;
    const v = strategy.score(tip, cal);
    return Number.isFinite(v) ? v : null;
}

// Sorted copy for the web table: score desc, null scores last. Native sort
// is spec-stable, so ties and the sunk tail keep the server's
// start_time/api_id/provider order (provider-duplicate rows share a
// fixture's score and stay adjacent - row tints keep pairing).
export function magicSortRows(rows, strategyId, cal) {
    const scores = new Map(rows.map(r => [r, scoreTip(r, strategyId, cal)]));
    return [...rows].sort((a, b) => {
        const va = scores.get(a), vb = scores.get(b);
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        return vb - va;
    });
}

// Safe-only selection gates (Safety Net Protocol). Tuned 2026-07-09 by the
// scripts/analyze-safe-tips.js leave-one-day-out grid over 547 settled tips
// (user decision): the per-day 'market' ranking + cap does the quality
// control, so looser floors that keep the pool fed beat strict ones that
// starve it - this combo replayed 94.4% legs at 2.6 picks/day (2-leg slips
// 6/6) vs 88.9% at 1.3/day for the all-3-signals variant. Literals on
// purpose - the web imports this module verbatim, env overrides would
// silently diverge client/server. Re-run the script weekly before touching.
export const DEFAULT_SAFE = {
    strategy: 'sure',     // ranking that decides who wins the per-day cap. Swapping
                          // 'market' -> 'sure' lifted the LODO replay leg-rate
                          // 81.5% -> 88.9% at the same volume (adversarial review).
    minParts: 2,          // at least two blend components present. PINNED at 2 -
                          // parts==3 is a double-chance-only confound (O/U tips
                          // carry no api part), which starves the pool.
    minAgreement: 0.65,   // floor on the weakest present component (live sweet spot 0.65-0.72)
    maxPrice: 1.6,        // short-priced legs only (1.2 floor set at generation)
    maxPerDay: 3,         // quality over quantity - zero qualifiers = no bet
    minSamples: 6,        // min rolling sample per side (excludes thin/risky bets;
                          // live: sufficient tips 74.8% vs thin 70.7%). ~no-op vs
                          // the generation minGames=5 floor (98.3% of tips pass).
    minH2H: 0,            // min head-to-head meetings. PINNED off - minH2H>=3
                          // starves the pool (helps only result markets; re-test
                          // on double-chance-only via analyze-safe-tips.js).
};

// Three risk tiers (Safety Net Protocol). Only minAgreement / maxPrice /
// maxPerDay vary - minParts, minSamples, minH2H are pinned floors (the review
// showed varying them either does nothing or is a confound). All ranked by the
// 'sure' sort. 'balanced' equals the shipped DEFAULT_SAFE (zero regression).
export const SAFE_TIERS = {
    'max-precision': { minAgreement: 0.72, maxPrice: 1.5, maxPerDay: 2 },
    balanced: { minAgreement: 0.65, maxPrice: 1.6, maxPerDay: 3 },
    volume: { minAgreement: 0.60, maxPrice: 2.0, maxPerDay: 5 },
};

// True when a row's tip has ENOUGH evidence to not be a "risky" bet: enough
// rolling sample on both sides and (optionally) enough H2H. Tolerant by design
// - a row that records no samples (pre-2026-07-04 rows, test rows) is NOT
// failed here; the minParts/agreement gates already screen those. Tipless rows
// ARE risky. Shared verbatim by safeQualifies AND the web risk-gate filter so
// "sufficient stats" means one thing everywhere.
export function hasSufficientStats(row, opts = DEFAULT_SAFE) {
    const o = { ...DEFAULT_SAFE, ...opts };
    const tip = tipView(row);
    if (!tip) return false;
    const s = tip.breakdown?.samples;
    if (!s) return true;
    const minN = Math.min(_num(s.home_n) ?? 0, _num(s.away_n) ?? 0);
    if ((o.minSamples ?? 0) > 0 && minN < o.minSamples) return false;
    if ((o.minH2H ?? 0) > 0 && (_num(s.h2h_n) ?? 0) < o.minH2H) return false;
    return true;
}

// One tip's pass/fail against the safe gates. Vetoed, tipless, thin-breakdown
// (no components recorded) and insufficient-sample rows always fail.
export function safeQualifies(row, opts = DEFAULT_SAFE) {
    const o = { ...DEFAULT_SAFE, ...opts };
    const tip = tipView(row);
    if (!tip || tip.vetoed) return false;
    if (_agreementParts(tip).length < o.minParts) return false;
    const agree = tipAgreement(tip);
    if (agree == null || agree < o.minAgreement) return false;
    if (tip.price == null || tip.price > o.maxPrice) return false;
    return hasSufficientStats(row, o);
}

// Grouping day for a row: the ledger's `day` is already the EAT day string
// (DATE_FORMAT in the pinned +03:00 SQL session); records rows carry
// `start_time`, which JSON-serializes as a UTC ISO instant - slicing THAT
// mis-buckets EAT evenings/midnights into the previous day (live bug:
// one date split into two groups, doubling the per-day cap). EAT is a
// fixed +03:00 with no DST (same assumption as auto-rules.js).
const _dayKey = r => {
    if (r.day != null) return String(r.day).slice(0, 10);
    const t = Date.parse(r.start_time ?? '');
    if (Number.isFinite(t)) return new Date(t + 3 * 3600000).toISOString().slice(0, 10);
    return String(r.start_time ?? '').slice(0, 10);
};

// The day's safe slip legs: one row per canonical fixture (provider rows
// share the fixture's tip - first row represents it), gate-filtered, ranked
// per day by the pinned strategy and capped at maxPerDay. Callers filter a
// table by membership (Set of api_id), never by the returned rows alone.
export function safeSelection(rows, cal, opts = DEFAULT_SAFE) {
    const o = { ...DEFAULT_SAFE, ...opts };
    const seen = new Set();
    const byDay = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
        const key = r?.api_id ?? r; // ledger rows are already one per fixture
        if (seen.has(key)) continue;
        seen.add(key);
        if (!safeQualifies(r, o)) continue;
        const day = _dayKey(r);
        let list = byDay.get(day);
        if (!list) byDay.set(day, list = []);
        list.push(r);
    }
    const out = [];
    for (const day of [...byDay.keys()].sort()) {
        const ranked = byDay.get(day)
            .map(row => ({ row, tip: tipView(row), score: scoreTip(row, o.strategy, cal) }))
            .filter(e => Number.isFinite(e.score))
            .sort(_rankCompare);
        out.push(...ranked.slice(0, Math.max(1, o.maxPerDay)).map(e => e.row));
    }
    return out;
}

// Virtual multi-bet math over legs [{ price, prob }]: combined odds, payout,
// survival (independence assumption) and EV. Empty slip = the identity bet.
export function slipSummary(legs, stake = 1) {
    let odds = 1, survival = 1;
    for (const leg of legs) {
        odds *= _num(leg.price) ?? 1;
        survival *= _num(leg.prob) ?? 1;
    }
    return {
        odds: _round(odds),
        payout: _round(odds * stake),
        survival: _round(survival),
        ev: _round(survival * odds - 1),
    };
}

// Grade a slip from its legs' settled tip outcomes (backtest mode): every
// leg hit -> won; any miss -> lost (a pending leg cannot save it); else
// open. Legacy stored legs without an `outcome` field count as pending.
export function slipOutcome(legs) {
    const list = Array.isArray(legs) ? legs : [];
    let settled = 0;
    const broken = [];
    for (const leg of list) {
        if (leg?.outcome === 'hit') settled++;
        else if (leg?.outcome === 'miss') { settled++; broken.push(leg.api_id); }
    }
    const state = broken.length ? 'lost' : (list.length && settled === list.length ? 'won' : 'open');
    return { state, settled, total: list.length, broken };
}

// Playground totals over a book of slips at flat stake: every non-empty slip
// stakes once (empty cards aren't bets), `returned` sums the WON slips'
// virtual payouts, `profit` covers settled slips only - an open slip's
// stake is not yet lost - and `potential` is what the OPEN slips would pay
// if every unsettled leg landed.
export function slipTotals(slips, stake = 1) {
    const t = { slips: 0, won: 0, lost: 0, open: 0, staked: 0, returned: 0, profit: 0, potential: 0 };
    for (const slip of Array.isArray(slips) ? slips : []) {
        const legs = Array.isArray(slip?.legs) ? slip.legs : [];
        if (!legs.length) continue;
        t.slips++;
        const { state } = slipOutcome(legs);
        if (state === 'won') {
            t.won++;
            t.returned += slipSummary(legs, stake).payout;
        } else if (state === 'lost') {
            t.lost++;
        } else {
            t.open++;
            t.potential += slipSummary(legs, stake).payout;
        }
    }
    t.staked = _round(t.slips * stake);
    t.returned = _round(t.returned);
    t.profit = _round(t.returned - (t.won + t.lost) * stake);
    t.potential = _round(t.potential);
    return t;
}

// Chunk an ordered candidate pool into slip leg-arrays for the playground's
// autogeneration. A slip closes as soon as its combined odds reach targetOdds
// (early), or it hits maxLegs (hard cap). maxSlips caps how many slips are
// created (leftover tips stay unused); maxSlips <= 0 means unlimited. A pool
// exhausted before targetOdds leaves the final slip under target (the caller
// still shows its below-target warning). Returns leg-arrays; the caller wraps
// each into a slip object (id/name).
export function buildSlips(pool, { maxLegs = 4, targetOdds = 0, maxSlips = 0 } = {}) {
    const list = Array.isArray(pool) ? pool : [];
    const legs = Math.max(1, Math.round(maxLegs) || 1);
    const cap = Math.round(maxSlips) || 0;
    const out = [];
    let i = 0;
    while (i < list.length && (cap <= 0 || out.length < cap)) {
        const slip = [];
        let odds = 1;
        while (i < list.length && slip.length < legs) {
            const leg = list[i++];
            slip.push(leg);
            odds *= _num(leg?.price) ?? 1;
            if (targetOdds > 0 && odds >= targetOdds) break; // target reached -> close slip
        }
        out.push(slip);
    }
    return out;
}

// Fully deterministic ranking tiebreak over { tip, score } entries: score
// desc, then confidence desc, price asc, market asc. Shared by the replay's
// day ranking and the safe selection so both order identically.
const _rankCompare = (a, b) => (b.score - a.score)
    || ((b.tip.confidence ?? 0) - (a.tip.confidence ?? 0))
    || ((a.tip.price ?? 0) - (b.tip.price ?? 0))
    || String(a.tip.market).localeCompare(String(b.tip.market));

// Rank one day's candidates under a strategy: score desc with the shared
// deterministic tiebreak.
function _rankDay(pool, strategy, cal) {
    return pool
        .map(tip => ({ tip, score: strategy.score(tip, cal) }))
        .filter(e => Number.isFinite(e.score))
        .sort(_rankCompare);
}

// Dropdown ranking policy (user decision, 2026-07-06): survival first -
// faithful to the headline metric - with quartile rate breaking the frequent
// survival ties while replay days are few, and roi (surviving at higher
// combined odds) as the last word. Null metrics lose; ties fall through to
// id order (determinism is handled by the caller).
function compareStrategies(a, b) {
    const s = (x, k) => x.stats[k] ?? -Infinity;
    const q = x => x.stats.quartile.rate ?? -Infinity;
    return (s(b, 'survival') - s(a, 'survival'))
        || (q(b) - q(a))
        || (s(b, 'roi') - s(a, 'roi'));
}

const _tierRank = (entries, minDays) => [...entries].sort((a, b) => {
    // Structural: strategies with enough replayed days always rank above
    // the rest; id order is the final determinism guard.
    const tier = (b.stats.days >= minDays) - (a.stats.days >= minDays);
    if (tier) return tier;
    return compareStrategies(a, b) || String(a.id).localeCompare(String(b.id));
});

// Replay every strategy against the settled ledger and rank by 4-leg slip
// survival. rows: [{ day: 'YYYY-MM-DD', tip_market, tip_price,
// tip_confidence, tip_outcome, tip_breakdown, tip_ai_verdict }].
export function simulateStrategies(rows, { legs = 4, minDays = 5, topN = 5, shrinkK = 10 } = {}) {
    // Settled tips only; vetoed ones feed calibration but never a slip -
    // the sorted table sinks them, so replayed slips must too.
    const settled = [];
    for (const r of rows) {
        const tip = tipView(r);
        if (tip && (tip.outcome === 'hit' || tip.outcome === 'miss')) {
            settled.push({ day: String(r.day), tip });
        }
    }
    const byDay = new Map();
    for (const e of settled) {
        let list = byDay.get(e.day);
        if (!list) byDay.set(e.day, list = []);
        list.push(e.tip);
    }
    const days = [...byDay.keys()].sort();

    // Leave-one-day-out calibrations: replaying day D scores with everything
    // EXCEPT D, so calibrated strategies never grade their own answers.
    const lodo = new Map(days.map(day => [
        day,
        computeCalibration(settled.filter(e => e.day !== day).map(e => e.tip), shrinkK),
    ]));

    let eligibleDays = 0;
    for (const tips of byDay.values()) {
        if (tips.filter(t => !t.vetoed).length >= legs) eligibleDays++;
    }

    const results = STRATEGIES.map(strategy => {
        let slipDays = 0, survived = 0, profit = 0, oddsSum = 0;
        const quartile = { n: 0, hits: 0 };
        const streak = { days: 0, sum: 0, best: 0 };
        for (const day of days) {
            const pool = byDay.get(day).filter(t => !t.vetoed);
            const ranked = _rankDay(pool, strategy, lodo.get(day));
            if (!ranked.length) continue;
            // Rank-quality tiebreak metric: the top quarter of every day's
            // ranking (all days, even those too small for a slip).
            const q = Math.ceil(ranked.length / 4);
            for (const e of ranked.slice(0, q)) {
                quartile.n++;
                if (e.tip.outcome === 'hit') quartile.hits++;
            }
            // Hit streak from the top of the day's ranking: how deep a
            // straight top-down slip could have gone before the first miss.
            // Display-only for now - fold into the ranking policy once the
            // replay covers >30 days.
            let run = 0;
            for (const e of ranked) {
                if (e.tip.outcome !== 'hit') break;
                run++;
            }
            streak.days++;
            streak.sum += run;
            if (run > streak.best) streak.best = run;
            if (ranked.length < legs) continue;
            const slip = ranked.slice(0, legs);
            const odds = slip.reduce((p, e) => p * (e.tip.price ?? 1), 1);
            const win = slip.every(e => e.tip.outcome === 'hit');
            slipDays++;
            oddsSum += odds;
            if (win) { survived++; profit += odds - 1; } else profit -= 1;
        }
        return {
            id: strategy.id,
            label: strategy.label,
            low_sample: slipDays < minDays,
            stats: {
                days: slipDays,
                survived,
                survival: slipDays ? _round(survived / slipDays) : null,
                profit: _round(profit),
                roi: slipDays ? _round(profit / slipDays) : null,
                avg_odds: slipDays ? _round(oddsSum / slipDays) : null,
                quartile: {
                    n: quartile.n,
                    hits: quartile.hits,
                    rate: quartile.n ? _round(quartile.hits / quartile.n) : null,
                },
                streak: {
                    days: streak.days,
                    avg: streak.days ? _round(streak.sum / streak.days) : null,
                    best: streak.best,
                },
            },
        };
    });

    // The `sure` strategy is the default table sort, so the client must always
    // receive it (activeChain prunes magic entries not in this list). Pin it in
    // even when its early-sample slip survival keeps it out of the raw top-N.
    const ranked = _tierRank(results, minDays);
    let strategies = ranked.slice(0, topN);
    if (!strategies.some(s => s.id === 'sure')) {
        const sure = ranked.find(s => s.id === 'sure');
        if (sure) strategies = [sure, ...strategies.slice(0, Math.max(0, topN - 1))];
    }

    return {
        sample: {
            settled: settled.length,
            days: days.length,
            eligible_days: eligibleDays,
            min_days: minDays,
            sufficient: eligibleDays >= minDays,
        },
        strategies,
        // Full-set calibration: what the client scores TODAY's rows with.
        calibration: computeCalibration(settled.map(e => e.tip), shrinkK),
    };
}
