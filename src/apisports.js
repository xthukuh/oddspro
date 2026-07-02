import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';
import { _date, _dtime, _batch } from './utils.js';
import { db } from './db/connection.js';

// Bookmaker times are EAT - fetch fixtures in the same wall-clock timezone
const TIMEZONE = 'Africa/Nairobi';

// Played to a settled result - deep stats available
export const FINAL_STATUSES = ['FT', 'AET', 'PEN', 'AWD', 'WO'];
// Terminal without play - never poll again, no stats to fetch
export const TERMINAL_STATUSES = [...FINAL_STATUSES, 'CANC', 'ABD'];

// Get axios client instance
const ApisportsClient = axios.create({
    baseURL: config.X_APISPORTS_URL,
    headers: {
        'x-apisports-key': config.X_APISPORTS_KEY,
        Accept: 'application/json',
    },
    timeout: 30_000,
});

// Response envelope (validated - external data)
const ApiEnvelope = z.object({
    errors: z.union([z.array(z.any()), z.record(z.string(), z.any())]),
    results: z.number(),
    paging: z.object({ current: z.number(), total: z.number() }),
    response: z.array(z.any()),
});

// Nullable score pair
const ScorePair = z.object({
    home: z.number().nullable(),
    away: z.number().nullable(),
});

// Consumed fields of a /fixtures response item
const FixtureItem = z.object({
    fixture: z.object({
        id: z.number(),
        date: z.string(), // ISO with TZ offset (requested timezone)
        referee: z.string().nullable().optional(),
        venue: z.object({ name: z.string().nullable().optional() }).partial().nullable().optional(),
        status: z.object({ short: z.string() }),
    }),
    league: z.object({
        id: z.number(),
        name: z.string(),
        type: z.string().optional(),
        country: z.string().optional(),
        logo: z.string().nullable().optional(),
        season: z.number(),
        round: z.string().nullable().optional(),
    }),
    teams: z.object({
        home: z.object({ id: z.number(), name: z.string(), logo: z.string().nullable().optional() }),
        away: z.object({ id: z.number(), name: z.string(), logo: z.string().nullable().optional() }),
    }),
    goals: ScorePair,
    score: z.object({
        halftime: ScorePair,
        fulltime: ScorePair,
        extratime: ScorePair,
        penalty: ScorePair,
    }),
});

// Track daily quota from response headers; halt cleanly at the configured floor.
let _remaining = Infinity;

// Quota-aware GET returning the validated `response` array of a single page
async function _getPage(path, params) {
    if (_remaining <= config.APISPORTS_MIN_REMAINING) {
        throw new Error(
            `api-sports quota floor reached (${_remaining} requests remaining <= ${config.APISPORTS_MIN_REMAINING}). `
            + 'Run halted; progress so far is saved.'
        );
    }
    const res = await ApisportsClient.get(path, { params });
    const rem = Number(res.headers?.['x-ratelimit-requests-remaining']);
    if (Number.isFinite(rem)) _remaining = rem;
    const data = ApiEnvelope.parse(res.data);
    const errs = Array.isArray(data.errors) ? data.errors : Object.entries(data.errors);
    if (errs.length) throw new Error(`api-sports error (${path}): ${JSON.stringify(data.errors)}`);
    return data;
}

// Quota-aware GET following pagination to the full `response` array
async function _get(path, params) {
    const buffer = [];
    let page = 1, total = 1;
    do {
        const data = await _getPage(path, page > 1 ? { ...params, page } : params);
        buffer.push(...data.response);
        total = data.paging.total;
        page = data.paging.current + 1;
    } while (page <= total);
    return buffer;
}

export function apisportsQuotaRemaining() {
    return _remaining;
}

// "2026-07-02T15:00:00+03:00" -> "2026-07-02 15:00:00" (requested-TZ wall time)
function _isoToDatetime(iso) {
    return String(iso).substring(0, 19).replace('T', ' ');
}

// Map a validated fixture item to upsert rows
function _fixtureRows(item) {
    const f = item.fixture, l = item.league, t = item.teams;
    return {
        league: { id: l.id, name: l.name, type: l.type ?? null, country: l.country ?? null, logo: l.logo ?? null },
        teams: [
            { id: t.home.id, name: t.home.name, logo: t.home.logo ?? null },
            { id: t.away.id, name: t.away.name, logo: t.away.logo ?? null },
        ],
        fixture: {
            id: f.id,
            league_id: l.id,
            season: l.season,
            round: l.round ?? null,
            kickoff: _isoToDatetime(f.date),
            home_team_id: t.home.id,
            away_team_id: t.away.id,
            status: f.status.short,
            goals_home: item.goals.home,
            goals_away: item.goals.away,
            ht_home: item.score.halftime.home,
            ht_away: item.score.halftime.away,
            ft_home: item.score.fulltime.home,
            ft_away: item.score.fulltime.away,
            et_home: item.score.extratime.home,
            et_away: item.score.extratime.away,
            pen_home: item.score.penalty.home,
            pen_away: item.score.penalty.away,
            venue: f.venue?.name ?? null,
            referee: f.referee ?? null,
            metadata: JSON.stringify(item),
        },
    };
}

// Upsert fixture items (leagues + teams first for FK integrity)
async function _saveFixtureItems(items) {
    const leagues = new Map(), teams = new Map(), fixtures = [];
    for (const raw of items) {
        const { league, teams: tt, fixture } = _fixtureRows(FixtureItem.parse(raw));
        leagues.set(league.id, league);
        for (const t of tt) teams.set(t.id, t);
        fixtures.push(fixture);
    }
    if (leagues.size) {
        await db('leagues').insert([...leagues.values()]).onConflict('id').merge(['name', 'type', 'country', 'logo']);
    }
    if (teams.size) {
        await db('teams').insert([...teams.values()]).onConflict('id').merge(['name', 'logo']);
    }
    // merge excludes *_fetched_at flags - they are owned by the stats action
    for (let i = 0; i < fixtures.length; i += 200) {
        await db('fixtures').insert(fixtures.slice(i, i + 200)).onConflict('id').merge([
            'league_id', 'season', 'round', 'kickoff', 'home_team_id', 'away_team_id',
            'status', 'goals_home', 'goals_away', 'ht_home', 'ht_away', 'ft_home', 'ft_away',
            'et_home', 'et_away', 'pen_home', 'pen_away', 'venue', 'referee', 'metadata',
        ]);
    }
    return { leagues: leagues.size, teams: teams.size, fixtures: fixtures.length };
}

// Fetch and store all fixtures for a date (canonical base records)
export async function fetchApisportsFixtures(date_ = null) {
    const dt = _dtime(_date(date_)).substring(0, 10);
    console.debug(`API-Football ${dt} - Fetch fixtures...`);
    const items = await _get('/fixtures', { date: dt, timezone: TIMEZONE });
    console.debug(`API-Football ${dt} - Found ${items.length} fixtures...`);
    const counts = await _saveFixtureItems(items);
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}

// Refresh unfinished past-kickoff fixtures; settle scores; mark matches completed.
export async function settleApisportsResults() {
    const pending = await db('fixtures')
        .select('id')
        .whereNotIn('status', TERMINAL_STATUSES)
        .where('kickoff', '<', db.raw('NOW()'));
    console.debug(`API-Football - ${pending.length} unfinished past-kickoff fixtures to refresh...`);

    // /fixtures?ids= accepts up to 20 ids per request
    const groups = [];
    for (let i = 0; i < pending.length; i += 20) {
        groups.push(pending.slice(i, i + 20).map(r => r.id).join('-'));
    }
    let refreshed = 0;
    await _batch(groups, async ids => {
        const items = await _get('/fixtures', { ids, timezone: TIMEZONE });
        const counts = await _saveFixtureItems(items);
        refreshed += counts.fixtures;
    }, 2);

    // Settle linked matches from final fixtures (fixtures are canonical):
    // copy authoritative scores + set the completed flag.
    const finalsIn = FINAL_STATUSES.map(() => '?').join(',');
    const [settled] = await db.raw(
        `UPDATE matches m JOIN fixtures f ON m.fixture_id = f.id
         SET m.home_score_fulltime = COALESCE(f.ft_home, f.goals_home),
             m.away_score_fulltime = COALESCE(f.ft_away, f.goals_away),
             m.home_score_first_half = f.ht_home,
             m.away_score_first_half = f.ht_away,
             m.home_score_second_half = COALESCE(f.ft_home, f.goals_home) - f.ht_home,
             m.away_score_second_half = COALESCE(f.ft_away, f.goals_away) - f.ht_away,
             m.completed_at = COALESCE(m.completed_at, NOW())
         WHERE f.status IN (${finalsIn})`,
        FINAL_STATUSES
    );

    // Terminal-without-play fixtures also complete their matches (no scores).
    const termIn = TERMINAL_STATUSES.map(() => '?').join(',');
    await db.raw(
        `UPDATE matches m JOIN fixtures f ON m.fixture_id = f.id
         SET m.completed_at = NOW()
         WHERE m.completed_at IS NULL AND f.status IN (${termIn})`,
        TERMINAL_STATUSES
    );

    // Fallback: unlinked matches long past kickoff stop being refreshed.
    const [fallback] = await db.raw(
        `UPDATE matches SET completed_at = NOW()
         WHERE completed_at IS NULL AND start_time < NOW() - INTERVAL 4 HOUR`
    );

    return {
        refreshed,
        settled: settled.affectedRows ?? 0,
        fallback_completed: fallback.affectedRows ?? 0,
        quota_remaining: apisportsQuotaRemaining(),
    };
}
