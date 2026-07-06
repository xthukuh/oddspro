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
        bands: {}, groups: {}, cells: {}, lines: {}, prices: {},
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

const _bd = tip => tip.breakdown ?? {};

// Candidate ranking strategies. Every scorer is total: fallback chains end
// at blend confidence (always set on a tip), so missing tip_breakdown or an
// empty calibration degrades, never throws. score() may return null - the
// row then sinks like a tipless one.
export const STRATEGIES = [
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
        // Consensus worst case: the weakest of the blend components that
        // exist - a tip everything likes beats a tip one signal loves.
        score: tip => {
            const parts = [_bd(tip).market_prob, _bd(tip).stats_prob, _bd(tip).api_prob]
                .map(_num).filter(v => v != null);
            return parts.length ? Math.min(...parts) : tip.confidence;
        },
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
// virtual payouts, and `profit` covers settled slips only - an open slip's
// stake is not yet lost (the UI shows the open count instead).
export function slipTotals(slips, stake = 1) {
    const t = { slips: 0, won: 0, lost: 0, open: 0, staked: 0, returned: 0, profit: 0 };
    for (const slip of Array.isArray(slips) ? slips : []) {
        const legs = Array.isArray(slip?.legs) ? slip.legs : [];
        if (!legs.length) continue;
        t.slips++;
        const { state } = slipOutcome(legs);
        if (state === 'won') {
            t.won++;
            t.returned += slipSummary(legs, stake).payout;
        } else if (state === 'lost') t.lost++;
        else t.open++;
    }
    t.staked = _round(t.slips * stake);
    t.returned = _round(t.returned);
    t.profit = _round(t.returned - (t.won + t.lost) * stake);
    return t;
}

// Rank one day's candidates under a strategy: score desc with a fully
// deterministic tiebreak (confidence desc, price asc, market asc).
function _rankDay(pool, strategy, cal) {
    return pool
        .map(tip => ({ tip, score: strategy.score(tip, cal) }))
        .filter(e => Number.isFinite(e.score))
        .sort((a, b) => (b.score - a.score)
            || ((b.tip.confidence ?? 0) - (a.tip.confidence ?? 0))
            || ((a.tip.price ?? 0) - (b.tip.price ?? 0))
            || String(a.tip.market).localeCompare(String(b.tip.market)));
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
            },
        };
    });

    return {
        sample: {
            settled: settled.length,
            days: days.length,
            eligible_days: eligibleDays,
            min_days: minDays,
            sufficient: eligibleDays >= minDays,
        },
        strategies: _tierRank(results, minDays).slice(0, topN),
        // Full-set calibration: what the client scores TODAY's rows with.
        calibration: computeCalibration(settled.map(e => e.tip), shrinkK),
    };
}
