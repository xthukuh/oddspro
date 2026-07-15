import { db } from './db/connection.js';
import { whereMarket } from './markets.js';
import { applyLabFilters, aggregateOutcomeRate, labFeature, labOutcome } from './db/lab-rules.js';

// Data-viz lab loader (admin-only): flat per-fixture rows for the pure
// aggregation in src/db/lab-rules.js. SQL stays here, math stays pure - the
// same division of labor as records.js / magic.js.
//
// Row universe: SETTLED fixtures only (every lab outcome needs a final score).
// Rank/form/H2H come from the frozen fixture_prematch snapshot - never live
// standings, which already contain the studied match (leakage; see lab-rules).
// Fixtures predating the snapshot feature simply carry nulls and drop out of
// snapshot-based axes.
const RESULT_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO'];

// Query-shape guardrails (admin tool, but still bounded).
export const LAB_DEFAULTS = { sample: 20000, sample_max: 100000, min_count: 10, days_max: 365 };

const _clamp = (v, lo, hi, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

// Load flat lab rows. `needs` (feature keys in play) gates the expensive
// per-feature joins - odds pivots and stat sums only run when an axis or
// filter actually uses them.
export async function labRows({ days = null, sample = LAB_DEFAULTS.sample, needs = new Set() } = {}) {
    const q = db('fixtures as f')
        .join('leagues as l', 'l.id', 'f.league_id')
        // 1:1 joins (both PK = fixture_id): never multiply the fixture count.
        .leftJoin('fixture_prematch as pm', 'pm.fixture_id', 'f.id')
        .leftJoin('fixture_predictions as fp', 'fp.fixture_id', 'f.id')
        .whereIn('f.status', RESULT_STATUSES)
        .whereNotNull('f.ft_home')
        .whereNotNull('f.ft_away')
        .orderBy('f.kickoff', 'desc') // newest first - the sample cap trims history
        .limit(_clamp(sample, 100, LAB_DEFAULTS.sample_max, LAB_DEFAULTS.sample))
        .select(
            'f.id as fixture_id',
            db.raw('HOUR(f.kickoff) as kickoff_hour'), // session TZ pinned +03:00 = EAT
            'f.ft_home', 'f.ft_away',
            'l.name as league', 'l.country as country',
            'pm.home_rank', 'pm.away_rank', 'pm.home_form', 'pm.away_form',
            'pm.h2h_n', 'pm.h2h_home_goals', 'pm.h2h_away_goals',
            'fp.implied_over', 'fp.tip_market', 'fp.tip_confidence', 'fp.tip_price', 'fp.tip_outcome',
        );
    if (days != null) {
        q.where('f.kickoff', '>=', db.raw('DATE_SUB(NOW(), INTERVAL ? DAY)', [_clamp(days, 1, LAB_DEFAULTS.days_max, LAB_DEFAULTS.days_max)]));
    }

    // 1X2 odds: MIN(price) across the fixture's linked bookmaker matches.
    // Deliberately includes is_stale rows - for concluded games the stale flag
    // just means the market delisted before kickoff; its last-seen price IS the
    // historical price (records.js excludes stale only for live sort/filter).
    const joinOdds = (marketKey, alias) => {
        const sub = whereMarket(
            db('odds_markets as om').join('matches as m', 'm.id', 'om.match_id'),
            marketKey,
        )
            .groupBy('m.fixture_id')
            .select('m.fixture_id')
            .min('om.price as price')
            .as(alias);
        q.leftJoin(sub, `${alias}.fixture_id`, 'f.id').select(`${alias}.price as ${alias}`);
    };
    if (needs.has('home_odds')) joinOdds('1', 'home_odds');
    if (needs.has('away_odds')) joinOdds('2', 'away_odds');

    // Match-stat totals: SUM over the fixture's two team rows. Values are
    // varchar - plain counts for these types, so the CAST is safe.
    const joinStat = (type, alias) => {
        const sub = db('fixture_statistics')
            .where('type', type)
            .groupBy('fixture_id')
            .select('fixture_id', db.raw('SUM(CAST(value AS DECIMAL(8,2))) as total'))
            .as(alias);
        q.leftJoin(sub, `${alias}.fixture_id`, 'f.id').select(`${alias}.total as ${alias}`);
    };
    if (needs.has('shots_total')) joinStat('Shots on Goal', 'shots_total');
    if (needs.has('corners_total')) joinStat('Corner Kicks', 'corners_total');

    return q;
}

// One lab request: load -> filter -> aggregate. Unknown feature/outcome keys
// throw TypeError (validated BEFORE the query so a bad request never hits the
// DB); the server's JSON error handler maps that to a 400.
export async function labData({ x, y = null, color = null, outcome, filters = [], days = null, sample = undefined, minCount = undefined } = {}) {
    for (const [name, key] of [['x', x], ['y', y], ['color', color]]) {
        if (key != null && !labFeature(key)) throw new TypeError(`Unknown lab feature for ${name}: ${key}`);
    }
    if (!labFeature(x)) throw new TypeError(`Missing lab feature: x`);
    if (!labOutcome(outcome)) throw new TypeError(`Unknown lab outcome: ${outcome}`);
    if (!Array.isArray(filters)) throw new TypeError('filters must be an array');

    const needs = new Set([x, y, color, ...filters.map(f => f?.key)].filter(Boolean));
    const rows = await labRows({ days, sample, needs });
    const filtered = applyLabFilters(rows, filters);
    const agg = aggregateOutcomeRate(filtered, {
        xKey: x, yKey: y, colorKey: color, outcome,
        minCount: _clamp(minCount, 1, 1000, LAB_DEFAULTS.min_count),
    });
    return {
        x: labFeature(x),
        y: y ? labFeature(y) : null,
        color: color ? labFeature(color) : null,
        outcome: labOutcome(outcome),
        rows_loaded: rows.length,
        days: days ?? null,
        ...agg,
    };
}
