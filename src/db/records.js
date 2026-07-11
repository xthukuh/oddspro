import { db } from './connection.js';
import { MARKET_COLUMNS, isMarketKey, marketKey, whereMarket } from '../markets.js';
import { h2hSummary, formatGoals } from './prematch-calc.js';
import { parseFilterList } from './filter-csv.js';

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
    home_team: { sql: 'm.home_team_name', type: 'string' },
    away_team: { sql: 'm.away_team_name', type: 'string' },
    goals: {
        sql: "(CASE WHEN f.status IN ('FT','AET','PEN','AWD','WO') THEN m.home_score_fulltime + m.away_score_fulltime END)",
        raw: true, type: 'number',
    },
    league: { sql: 'l.name', type: 'string' },
    status: { sql: 'f.status', type: 'string' },
    // Over 2.5 hot picks (fixture_predictions is 1:1 per fixture; LEFT JOIN
    // in queryRecords). `hot eq 1` filters to picks; rows without a ledger
    // entry are NULL, not 0.
    hot: { sql: 'fp.hot', type: 'number' },
    hot_score: { sql: 'fp.score', type: 'number' },
    // "Tip" column sorts/filters by its blended confidence (0..1); `like`
    // conditions match the tip market TEXT instead (what the cell displays)
    tip: { sql: 'fp.tip_confidence', like_sql: 'fp.tip_market', type: 'number' },
    // Odds refresh time / betting-closed time ("Locked At" = completed_at)
    updated_at: { sql: 'm.updated_at', type: 'datetime' },
    locked_at: { sql: 'm.completed_at', type: 'datetime' },
};

// Static pre-match STATS columns (dynamic post-match stat types are appended
// from fixture_statistics by `columnCatalog`). Display-only: not sortable.
const STAT_COLUMNS = [
    { key: 'league', label: 'League', default: true },
    { key: 'season', label: 'Season', default: true },
    { key: 'round', label: 'Round', default: true },
    { key: 'home_rank', label: 'Home Rank', default: true },
    { key: 'home_form', label: 'Home Form', default: true },
    { key: 'away_rank', label: 'Away Rank', default: true },
    { key: 'away_form', label: 'Away Form', default: true },
    { key: 'h2h', label: 'H2H (W-D-L)', default: true },
    // Rolling-goals aggregates - snapshot-only (null without a fixture_prematch
    // row): live-deriving them from pre-backfill local history would show
    // misleading lows. Rendered compact: "gf/ga (avg total per game)".
    { key: 'h2h_count', label: 'Meetings', default: true },
    { key: 'home_goals_h2h', label: 'H Goals vs Opp', default: true },
    { key: 'away_goals_h2h', label: 'A Goals vs Opp', default: true },
    { key: 'home_goals_oth', label: 'H Goals vs Others', default: true },
    { key: 'away_goals_oth', label: 'A Goals vs Others', default: true },
];

const FILTER_OPS = {
    eq: (q, col, v) => q.where(col, v),
    ne: (q, col, v) => q.whereNot(col, v),
    gt: (q, col, v) => q.where(col, '>', v),
    gte: (q, col, v) => q.where(col, '>=', v),
    lt: (q, col, v) => q.where(col, '<', v),
    lte: (q, col, v) => q.where(col, '<=', v),
    like: (q, col, v) => q.where(col, 'like', `%${v}%`),
    'not-contains': (q, col, v) => q.where(col, 'not like', `%${v}%`),
    // `v` is a coerced array (see _coerceList); NULL rows drop (NOT IN semantics)
    in: (q, col, v) => q.whereIn(col, v),
    'not-in': (q, col, v) => q.whereNotIn(col, v),
};

// Text/set ops resolve to a base field's `like_sql` text target (e.g. tip ->
// fp.tip_market) instead of its numeric sort target, and their values stay text.
const TEXT_TARGET_OPS = new Set(['like', 'not-contains', 'in', 'not-in']);

// Column-to-column comparison operators for `{key, op, col}` filters
// (RHS is another column, not a literal); text/set ops intentionally excluded.
const COL_OPS = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

// Column catalog consumed by the settings modal (and the CSV default set).
// `providers` is discovered from the warehouse so newly-integrated bookmakers
// appear in the settings UI without frontend changes.
export async function columnCatalog() {
    const types = await db('fixture_statistics').distinct('type').orderBy('type');
    const providers = await db('matches').distinct('provider').orderBy('provider');
    return {
        providers: providers.map(p => p.provider),
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
// `op` is the filter operator: a base field with a `like_sql` text target
// resolves there for `like` conditions (e.g. tip -> fp.tip_market).
function _sqlTarget(query, key, joined, op = null) {
    const base = BASE_FIELDS[key];
    if (base) {
        if (TEXT_TARGET_OPS.has(op) && base.like_sql) return base.like_sql;
        return base.raw ? db.raw(base.sql) : base.sql;
    }
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

// mysql2 may return JSON columns as objects or strings depending on flags
function _json(value) {
    if (value == null || typeof value === 'object') return value ?? null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

// Coerce a filter value by field type (market columns are numeric prices).
// `like`/`not-contains` values stay text (string-contains works on any column);
// numeric comparisons reject unparsable input - mysql2 would otherwise serialize
// NaN as a bare SQL token ("Unknown column 'NaN'").
function _coerce(key, value, op) {
    const type = BASE_FIELDS[key]?.type ?? 'number';
    if (op === 'like' || op === 'not-contains' || type !== 'number') return String(value);
    const n = Number(value);
    if (Number.isNaN(n)) {
        throw new TypeError(`Invalid numeric filter value for ${key}: ${JSON.stringify(value)}`);
    }
    return n;
}

// Coerce an `in` / `not-in` CSV value into an array of typed items. Items are
// text when the field routes to a text target (tip's like_sql) or is a string
// column; numeric otherwise (markets, numeric base fields) - same NaN guard as
// _coerce. An empty list is rejected (would match nothing / everything).
function _coerceList(key, value, op) {
    const items = parseFilterList(value);
    if (!items.length) {
        throw new TypeError(`Empty ${op} list for ${key}: ${JSON.stringify(value)}`);
    }
    const base = BASE_FIELDS[key];
    const text = base ? (base.like_sql != null || base.type !== 'number') : false;
    if (text) return items.map(String);
    return items.map(it => {
        const n = Number(it);
        if (Number.isNaN(n)) {
            throw new TypeError(`Invalid numeric filter item for ${key}: ${JSON.stringify(it)}`);
        }
        return n;
    });
}

// Query correlated records: paginated + multi-sort + filtered.
//   date: 'YYYY-MM-DD' | Date | null (null = all dates)
//   sort: [{key, dir:'asc'|'desc'}] over base fields + market columns
//   filters: [{key, op, value}] with ops eq/ne/gt/gte/lt/lte/like/not-contains
//   /in/not-in (in/not-in take a CSV-list value via parseFilterList)
//   completed: false hides concluded games (terminal fixture status or a
//   completed match) - the web "Show completed games" settings toggle
//   providers: array limiting rows to those bookmakers (default: all)
//   per_page: 'all' disables pagination (the web table shows a whole date)
export async function queryRecords({ date = null, page = 1, per_page = 50, sort = [], filters = [], completed = true, providers = null } = {}) {
    const unpaged = per_page === 'all';
    page = unpaged ? 1 : Math.max(1, Number(page) || 1);
    per_page = unpaged ? 0 : Math.min(500, Math.max(1, Number(per_page) || 50));

    const query = db('matches as m')
        .join('fixtures as f', 'f.id', 'm.fixture_id') // inner join = correlated only
        .join('leagues as l', 'l.id', 'f.league_id')
        // Canonical API-Football team names (fixtures stores only ids);
        // LEFT JOIN so a missing team row can never drop a match.
        .leftJoin('teams as th', 'th.id', 'f.home_team_id')
        .leftJoin('teams as ta', 'ta.id', 'f.away_team_id')
        // 1:1 (fp PK = fixture_id): never multiplies the m.id count/pagination
        .leftJoin('fixture_predictions as fp', 'fp.fixture_id', 'f.id');
    if (date) {
        const d = date instanceof Date ? date.toISOString().substring(0, 10) : String(date);
        query.whereBetween('m.start_time', [`${d} 00:00:00`, `${d} 23:59:59`]);
    }
    if (!completed) {
        // Same "game is over" definition as the availability flag: terminal
        // fixture status, or the match completed (incl. the 4h fallback)
        query.whereNotIn('f.status', TERMINAL_STATUSES).whereNull('m.completed_at');
    }
    if (Array.isArray(providers) && providers.length) {
        query.whereIn('m.provider', providers);
    }

    const joined = new Map();
    for (const f of Array.isArray(filters) ? filters : []) {
        const target = _sqlTarget(query, f?.key, joined, f?.op);
        if (!target) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
        if (f?.col != null) {
            // Column-to-column comparison: the RHS resolves like the LHS
            // (sharing market joins) and binds as an identifier (??), never
            // a value. SQL NULL semantics drop rows missing either side.
            const op = COL_OPS[f?.op];
            const rhs = _sqlTarget(query, f.col, joined);
            if (!op || !rhs) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
            query.where(target, op, typeof rhs === 'string' ? db.raw('??', [rhs]) : rhs);
        } else {
            const apply = FILTER_OPS[f?.op];
            if (!apply) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
            const value = (f.op === 'in' || f.op === 'not-in')
                ? _coerceList(f.key, f.value, f.op)
                : _coerce(f.key, f.value, f.op);
            apply(query, target, value);
        }
    }

    const [{ total }] = await query.clone().count('m.id as total');

    for (const s of Array.isArray(sort) ? sort : []) {
        const target = _sqlTarget(query, s?.key, joined);
        if (!target) throw new TypeError(`Invalid sort key: ${JSON.stringify(s?.key)}`);
        query.orderBy(target, s.dir === 'desc' ? 'desc' : 'asc');
    }
    query.orderBy('m.start_time').orderBy('f.id').orderBy('m.provider');

    if (!unpaged) query.offset((page - 1) * per_page).limit(per_page);
    const rows = await query
        .select(
            'm.id as match_id', 'f.id as api_id', 'm.provider', 'm.start_time', 'm.match_url',
            'm.updated_at', 'm.completed_at',
            'm.home_team_name', 'm.away_team_name',
            'm.home_score_fulltime', 'm.away_score_fulltime',
            'l.name as league_name', 'l.country as league_country',
            'f.status', 'f.elapsed', 'f.season', 'f.round', 'f.league_id', 'f.kickoff',
            'f.home_team_id', 'f.away_team_id',
            'th.name as api_home', 'ta.name as api_away',
            'fp.hot', 'fp.score as hot_score', 'fp.outcome as hot_outcome',
            'fp.ai_reason as hot_ai_reason', 'fp.signals as hot_signals',
            'fp.ai_review as hot_ai_review',
            'fp.tip_market', 'fp.tip_price', 'fp.tip_confidence', 'fp.tip_outcome',
            'fp.tip_breakdown', 'fp.tip_skip_reason', 'fp.tip_ai_verdict', 'fp.tip_ai_reason',
            'fp.tip_ai_review',
        );

    const data = await _hydrate(rows);
    return {
        data,
        total: Number(total),
        page,
        per_page: unpaged ? Number(total) : per_page,
        pages: unpaged ? 1 : Math.max(1, Math.ceil(Number(total) / per_page)),
    };
}

// Raw head-to-head meeting list for the web tooltip. Same row rules as
// h2hSummary (either venue, scored, kickoff strictly before this fixture's),
// newest first, capped: whole-date responses carry one list per row. Note
// the frozen snapshot's h2h_count can exceed this live-derived list after
// later history backfills - the tooltip's "+N more" line covers the gap.
const H2H_MEETINGS_MAX = 10;
function _h2hMeetings(h2h, r, homeName, awayName) {
    const p = n => String(n).padStart(2, '0');
    return h2h
        .filter(f => ((f.home_team_id === r.home_team_id && f.away_team_id === r.away_team_id)
            || (f.home_team_id === r.away_team_id && f.away_team_id === r.home_team_id))
            && f.ft_home != null && f.ft_away != null
            && new Date(f.kickoff).getTime() < new Date(r.kickoff).getTime())
        .sort((a, b) => new Date(b.kickoff).getTime() - new Date(a.kickoff).getTime())
        .slice(0, H2H_MEETINGS_MAX)
        .map(f => {
            const d = new Date(f.kickoff);
            return {
                date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
                home: f.home_team_id === r.home_team_id ? homeName : awayName,
                away: f.away_team_id === r.away_team_id ? awayName : homeName,
                score: `${f.ft_home}-${f.ft_away}`,
            };
        });
}

// Attach odds pivot, pre-match stats (frozen fixture_prematch snapshot when
// present, live standings/H2H derivation otherwise) and fixture statistics.
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

    // Frozen pre-match snapshots (preferred over live derivation when present)
    const snapshots = await db('fixture_prematch').whereIn('fixture_id', fixtureIds);
    const snapshot = new Map(snapshots.map(p => [p.fixture_id, p]));

    // Standings (rank/form) per league+season+team - live fallback for
    // fixtures that predate the snapshot feature
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
        // Snapshot rows win wholesale (presence of the row, not per-field ??):
        // a null snapshot rank means "no rank at kickoff" and must not drift
        // back to today's live standings.
        const p = snapshot.get(r.api_id);
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
        // Canonical team names for tooltips; fall back to bookmaker names
        const homeName = r.api_home ?? r.home_team_name;
        const awayName = r.api_away ?? r.away_team_name;
        return {
            match_id: r.match_id,
            api_id: r.api_id,
            provider: r.provider,
            start_time: r.start_time,
            fixture: `${r.home_team_name} - ${r.away_team_name}`,
            fixture_api: r.api_home && r.api_away ? `${r.api_home} - ${r.api_away}` : null,
            home_team: r.home_team_name,
            away_team: r.away_team_name,
            match_url: r.match_url,
            score: hs != null && as != null ? `${hs}-${as}` : null,
            goals: hs != null && as != null ? hs + as : null,
            league: r.league_country ? `${r.league_country} - ${r.league_name}` : r.league_name,
            season: r.season ?? null,
            round: r.round ?? null,
            status: r.status,
            elapsed: r.elapsed ?? null,
            home_rank: p ? p.home_rank : sh?.rank ?? null,
            home_form: p ? p.home_form : sh?.form ?? null,
            away_rank: p ? p.away_rank : sa?.rank ?? null,
            away_form: p ? p.away_form : sa?.form ?? null,
            h2h: p ? p.h2h : h2hSummary(h2h, r),
            h2h_count: p?.h2h_count ?? null,
            h2h_meetings: _h2hMeetings(h2h, r, homeName, awayName),
            home_goals_h2h: p ? formatGoals(p.h2h_home_goals, p.h2h_away_goals, p.h2h_n) : null,
            away_goals_h2h: p ? formatGoals(p.h2h_away_goals, p.h2h_home_goals, p.h2h_n) : null,
            home_goals_oth: p ? formatGoals(p.home_oth_gf, p.home_oth_ga, p.home_oth_n) : null,
            away_goals_oth: p ? formatGoals(p.away_oth_gf, p.away_oth_ga, p.away_oth_n) : null,
            updated_at: r.updated_at,
            locked_at: r.completed_at ?? null,
            available,
            // Over 2.5 hot pick ledger (fixture_predictions LEFT JOIN)
            hot: !!r.hot,
            hot_score: r.hot_score == null ? null : Number(r.hot_score),
            hot_outcome: r.hot_outcome ?? null,
            hot_reason: r.hot_ai_reason ?? null,
            hot_review: _json(r.hot_ai_review),
            hot_signals: _json(r.hot_signals),
            tip_market: r.tip_market ?? null,
            tip_price: r.tip_price == null ? null : Number(r.tip_price),
            tip_confidence: r.tip_confidence == null ? null : Number(r.tip_confidence),
            tip_outcome: r.tip_outcome ?? null,
            tip_breakdown: _json(r.tip_breakdown),
            tip_skip_reason: r.tip_skip_reason ?? null,
            tip_ai_verdict: r.tip_ai_verdict ?? null,
            tip_ai_reason: r.tip_ai_reason ?? null,
            tip_ai_review: _json(r.tip_ai_review),
            markets,
            markets_stale,
            stats,
        };
    });
}
