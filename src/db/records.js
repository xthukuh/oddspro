import { db } from './connection.js';
import { MARKET_COLUMNS, isMarketKey, marketKey, whereMarket } from '../markets.js';

// Read-side query layer over the warehouse for Phase 6 visualization.
// Serves both the `export` CSV action and the :3001 API. Only correlated
// records (matches with a canonical fixture) are considered.

// Fixture statuses that carry a final result (usable for H2H history)
const RESULT_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO'];

// Terminal statuses (mirrors the results action): the game is over or dead,
// so its match is no longer a viable betting option.
const TERMINAL_STATUSES = [...RESULT_STATUSES, 'CANC', 'ABD'];

// Base row fields: SQL expression + type drive sorting, filtering and
// value coercion. `raw` marks computed expressions (vs plain columns).
const BASE_FIELDS = {
    api_id: { sql: 'f.id', type: 'number' },
    provider: { sql: 'm.provider', type: 'string' },
    start_time: { sql: 'm.start_time', type: 'datetime' },
    fixture: { sql: "CONCAT(m.home_team_name, ' - ', m.away_team_name)", raw: true, type: 'string' },
    goals: {
        sql: "(CASE WHEN f.status IN ('FT','AET','PEN','AWD','WO') THEN m.home_score_fulltime + m.away_score_fulltime END)",
        raw: true, type: 'number',
    },
    league: { sql: 'l.name', type: 'string' },
    status: { sql: 'f.status', type: 'string' },
};

// Static pre-match STATS columns (dynamic post-match stat types are appended
// from fixture_statistics by `columnCatalog`). Display-only: not sortable.
const STAT_COLUMNS = [
    { key: 'league', label: 'League', default: true },
    { key: 'home_rank', label: 'Home Rank', default: true },
    { key: 'home_form', label: 'Home Form', default: true },
    { key: 'away_rank', label: 'Away Rank', default: true },
    { key: 'away_form', label: 'Away Form', default: true },
    { key: 'h2h', label: 'H2H (W-D-L)', default: true },
];

const FILTER_OPS = {
    eq: (q, col, v) => q.where(col, v),
    ne: (q, col, v) => q.whereNot(col, v),
    gt: (q, col, v) => q.where(col, '>', v),
    gte: (q, col, v) => q.where(col, '>=', v),
    lt: (q, col, v) => q.where(col, '<', v),
    lte: (q, col, v) => q.where(col, '<=', v),
    like: (q, col, v) => q.where(col, 'like', `%${v}%`),
};

// Column catalog consumed by the settings modal (and the CSV default set).
export async function columnCatalog() {
    const types = await db('fixture_statistics').distinct('type').orderBy('type');
    return {
        base: Object.keys(BASE_FIELDS).map(key => ({ key, sortable: true, filterable: true })),
        markets: MARKET_COLUMNS.map(c => ({ ...c, sortable: true, filterable: true })),
        stats: [
            ...STAT_COLUMNS.map(c => ({ ...c, sortable: false, filterable: false })),
            ...types.map(({ type }) => ({
                key: `fs:${type}`, label: `${type} (H/A)`, default: false,
                sortable: false, filterable: false,
            })),
        ],
    };
}

// Resolve a sort/filter key to an orderable SQL target, adding a LEFT JOIN
// pivot subquery per referenced market column (one join per key, reused).
function _sqlTarget(query, key, joined) {
    const base = BASE_FIELDS[key];
    if (base) return base.raw ? db.raw(base.sql) : base.sql;
    if (!isMarketKey(key)) return null;
    let alias = joined.get(key);
    if (!alias) {
        alias = `mk${joined.size}`;
        joined.set(key, alias);
        const sub = whereMarket(db('odds_markets'), key)
            .where('is_stale', 0) // dead odds never drive sort/filter
            .groupBy('match_id')
            .select('match_id')
            .min('price as price')
            .as(alias);
        query.leftJoin(sub, `${alias}.match_id`, 'm.id');
    }
    return `${alias}.price`;
}

// Coerce a filter value by field type (market columns are numeric prices)
function _coerce(key, value) {
    const type = BASE_FIELDS[key]?.type ?? 'number';
    return type === 'number' ? Number(value) : String(value);
}

// Query correlated records: paginated + multi-sort + filtered.
//   date: 'YYYY-MM-DD' | Date | null (null = all dates)
//   sort: [{key, dir:'asc'|'desc'}] over base fields + market columns
//   filters: [{key, op, value}] with ops eq/ne/gt/gte/lt/lte/like
export async function queryRecords({ date = null, page = 1, per_page = 50, sort = [], filters = [] } = {}) {
    page = Math.max(1, Number(page) || 1);
    per_page = Math.min(500, Math.max(1, Number(per_page) || 50));

    const query = db('matches as m')
        .join('fixtures as f', 'f.id', 'm.fixture_id') // inner join = correlated only
        .join('leagues as l', 'l.id', 'f.league_id');
    if (date) {
        const d = date instanceof Date ? date.toISOString().substring(0, 10) : String(date);
        query.whereBetween('m.start_time', [`${d} 00:00:00`, `${d} 23:59:59`]);
    }

    const joined = new Map();
    for (const f of Array.isArray(filters) ? filters : []) {
        const target = _sqlTarget(query, f?.key, joined);
        const apply = FILTER_OPS[f?.op];
        if (!target || !apply) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
        apply(query, target, _coerce(f.key, f.value));
    }

    const [{ total }] = await query.clone().count('m.id as total');

    for (const s of Array.isArray(sort) ? sort : []) {
        const target = _sqlTarget(query, s?.key, joined);
        if (!target) throw new TypeError(`Invalid sort key: ${JSON.stringify(s?.key)}`);
        query.orderBy(target, s.dir === 'desc' ? 'desc' : 'asc');
    }
    query.orderBy('m.start_time').orderBy('f.id').orderBy('m.provider');

    const rows = await query
        .offset((page - 1) * per_page)
        .limit(per_page)
        .select(
            'm.id as match_id', 'f.id as api_id', 'm.provider', 'm.start_time', 'm.match_url',
            'm.updated_at', 'm.completed_at',
            'm.home_team_name', 'm.away_team_name',
            'm.home_score_fulltime', 'm.away_score_fulltime',
            'l.name as league_name', 'l.country as league_country',
            'f.status', 'f.season', 'f.league_id', 'f.kickoff',
            'f.home_team_id', 'f.away_team_id',
        );

    const data = await _hydrate(rows);
    return { data, total: Number(total), page, per_page, pages: Math.max(1, Math.ceil(Number(total) / per_page)) };
}

// Attach odds pivot, standings pre-match stats, H2H and fixture statistics.
async function _hydrate(rows) {
    if (!rows.length) return [];
    const matchIds = rows.map(r => r.match_id);
    const fixtureIds = [...new Set(rows.map(r => r.api_id))];
    const teamIds = [...new Set(rows.flatMap(r => [r.home_team_id, r.away_team_id]))];

    // Odds -> canonical market columns. Fresh and stale rows pivot into
    // separate maps (stale = vanished from the latest bookmaker update;
    // last-seen price kept for display). Fresh row count (ALL markets, not
    // just canonical) feeds the per-match availability flag.
    const odds = await db('odds_markets').whereIn('match_id', matchIds)
        .select('match_id', 'type_name', 'name', 'price', 'handicap', 'is_stale');
    const marketsByMatch = new Map(), staleByMatch = new Map(), freshCounts = new Map();
    for (const o of odds) {
        if (!o.is_stale) freshCounts.set(o.match_id, (freshCounts.get(o.match_id) ?? 0) + 1);
        const key = marketKey(o);
        if (!key) continue;
        const map = o.is_stale ? staleByMatch : marketsByMatch;
        let obj = map.get(o.match_id);
        if (!obj) map.set(o.match_id, obj = {});
        obj[key] = Number(o.price);
    }

    // Standings (rank/form) per league+season+team
    const standings = await db('standings').whereIn('team_id', teamIds)
        .select('league_id', 'season', 'team_id', 'rank', 'form');
    const standing = new Map(standings.map(s => [`${s.league_id}:${s.season}:${s.team_id}`, s]));

    // H2H: finished fixtures between each row's team pair (either venue)
    const h2h = await db('fixtures')
        .whereIn('home_team_id', teamIds).whereIn('away_team_id', teamIds)
        .whereIn('status', RESULT_STATUSES)
        .select('home_team_id', 'away_team_id', 'ft_home', 'ft_away', 'kickoff');

    // Post-match statistics pivoted per fixture+team
    const fstats = await db('fixture_statistics').whereIn('fixture_id', fixtureIds)
        .select('fixture_id', 'team_id', 'type', 'value');
    const statByFixture = new Map();
    for (const s of fstats) {
        let obj = statByFixture.get(s.fixture_id);
        if (!obj) statByFixture.set(s.fixture_id, obj = new Map());
        let pair = obj.get(s.type);
        if (!pair) obj.set(s.type, pair = {});
        pair[s.team_id] = s.value;
    }

    return rows.map(r => {
        // Results are canonical: bookmaker scores are unreliable pre-match
        // (BetPawa reports 0-0), so only surface them once the fixture is final.
        const settled = RESULT_STATUSES.includes(r.status);
        const hs = settled ? r.home_score_fulltime : null, as = settled ? r.away_score_fulltime : null;
        const sh = standing.get(`${r.league_id}:${r.season}:${r.home_team_id}`);
        const sa = standing.get(`${r.league_id}:${r.season}:${r.away_team_id}`);
        const stats = {};
        for (const [type, pair] of statByFixture.get(r.api_id) ?? []) {
            stats[`fs:${type}`] = `${pair[r.home_team_id] ?? '-'} / ${pair[r.away_team_id] ?? '-'}`;
        }
        // A stale price only shows where no fresh price shadows it
        const markets = marketsByMatch.get(r.match_id) ?? {};
        const markets_stale = { ...staleByMatch.get(r.match_id) };
        for (const key of Object.keys(markets_stale)) {
            if (key in markets) delete markets_stale[key];
        }
        // No longer a viable betting option: game over/dead or the latest
        // update carried no markets at all (completed matches keep their
        // last snapshot fresh, so status/completed_at decide for them).
        const available = !TERMINAL_STATUSES.includes(r.status)
            && !r.completed_at
            && (freshCounts.get(r.match_id) ?? 0) > 0;
        return {
            match_id: r.match_id,
            api_id: r.api_id,
            provider: r.provider,
            start_time: r.start_time,
            fixture: `${r.home_team_name} - ${r.away_team_name}`,
            match_url: r.match_url,
            score: hs != null && as != null ? `${hs}-${as}` : null,
            goals: hs != null && as != null ? hs + as : null,
            league: r.league_country ? `${r.league_country} - ${r.league_name}` : r.league_name,
            status: r.status,
            home_rank: sh?.rank ?? null,
            home_form: sh?.form ?? null,
            away_rank: sa?.rank ?? null,
            away_form: sa?.form ?? null,
            h2h: _h2hSummary(h2h, r),
            updated_at: r.updated_at,
            available,
            markets,
            markets_stale,
            stats,
        };
    });
}

// Summarize finished head-to-head meetings from the row's home-team
// perspective ("2W-1D-0L"), meetings strictly before this fixture's kickoff.
function _h2hSummary(h2h, r) {
    let w = 0, d = 0, l = 0;
    for (const f of h2h) {
        const home = f.home_team_id === r.home_team_id && f.away_team_id === r.away_team_id;
        const away = f.home_team_id === r.away_team_id && f.away_team_id === r.home_team_id;
        if (!(home || away) || f.ft_home == null || f.ft_away == null) continue;
        if (new Date(f.kickoff).getTime() >= new Date(r.kickoff).getTime()) continue;
        const [gf, ga] = home ? [f.ft_home, f.ft_away] : [f.ft_away, f.ft_home];
        if (gf > ga) w++;
        else if (gf < ga) l++;
        else d++;
    }
    return w + d + l ? `${w}W-${d}D-${l}L` : null;
}
