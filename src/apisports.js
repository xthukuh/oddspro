import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';
import { _date, _dtime, _batch, _progress } from './utils.js';
import { db } from './db/connection.js';
import { minuteRemaining, msToNextMinute, shouldRetryRateLimit } from './db/rate-rules.js';
import { withRetry } from './db/retry-rules.js';
import { buildEventRows } from './apisports-events.js';

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
        status: z.object({ short: z.string(), elapsed: z.number().nullable().optional() }),
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
// Per-minute burst budget (x-ratelimit-remaining header): pace, don't die.
let _minuteRemaining = Infinity;

const _sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Quota-aware GET returning the validated `response` array of a single page.
// The daily floor stays fatal (run halted, progress saved); the per-minute
// limit is transient - paced proactively on the header and retried (bounded)
// when a burst still slips through as an errors.rateLimit response.
async function _getPage(path, params) {
    for (let attempt = 0; ; attempt++) {
        if (_remaining <= config.APISPORTS_MIN_REMAINING) {
            throw new Error(
                `api-sports quota floor reached (${_remaining} requests remaining <= ${config.APISPORTS_MIN_REMAINING}). `
                + 'Run halted; progress so far is saved.'
            );
        }
        if (_minuteRemaining <= 1) {
            await _sleep(msToNextMinute(Date.now()));
            _minuteRemaining = Infinity; // fresh window; headers re-sync below
        }
        const res = await ApisportsClient.get(path, { params });
        const rem = Number(res.headers?.['x-ratelimit-requests-remaining']);
        if (Number.isFinite(rem)) _remaining = rem;
        const mrem = minuteRemaining(res.headers);
        if (mrem != null) _minuteRemaining = mrem;
        const data = ApiEnvelope.parse(res.data);
        const errs = Array.isArray(data.errors) ? data.errors : Object.entries(data.errors);
        if (!errs.length) return data;
        if (shouldRetryRateLimit(data.errors, attempt)) {
            console.debug(`API-Football rate-limited (${path}) - waiting for the next minute window (retry ${attempt + 1})`);
            await _sleep(msToNextMinute(Date.now()));
            _minuteRemaining = Infinity;
            continue;
        }
        throw new Error(`api-sports error (${path}): ${JSON.stringify(data.errors)}`);
    }
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
            elapsed: f.status.elapsed ?? null,
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
    // These idempotent upserts can deadlock against a concurrent process's
    // warehouse write (a 2nd serve/CLI/cron) on the shared leagues/teams/fixtures
    // rows - the observed manual-refresh "Insert SQL error". Retry transiently
    // (see retry-rules.js) instead of failing the whole refresh.
    if (leagues.size) {
        await withRetry(() => db('leagues').insert([...leagues.values()]).onConflict('id').merge(['name', 'type', 'country', 'logo']));
    }
    if (teams.size) {
        await withRetry(() => db('teams').insert([...teams.values()]).onConflict('id').merge(['name', 'logo']));
    }
    // merge excludes *_fetched_at flags - they are owned by the stats action
    for (let i = 0; i < fixtures.length; i += 200) {
        const chunk = fixtures.slice(i, i + 200);
        await withRetry(() => db('fixtures').insert(chunk).onConflict('id').merge([
            'league_id', 'season', 'round', 'kickoff', 'home_team_id', 'away_team_id',
            'status', 'elapsed', 'goals_home', 'goals_away', 'ht_home', 'ht_away', 'ft_home', 'ft_away',
            'et_home', 'et_away', 'pen_home', 'pen_away', 'venue', 'referee', 'metadata',
        ]));
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

// Stop re-polling non-terminal fixtures whose kickoff is older than this.
// API-Football sometimes never resolves obscure fixtures (stuck NS/PST forever,
// null scores) - without a floor they would be re-fetched on every pass for good,
// growing the refresh set unbounded. Genuinely-postponed games self-heal: a
// reschedule moves the kickoff forward, so they drop out and re-enter naturally
// once the new time passes. Mirrors STATS_GIVEUP_HOURS (give-up-polling policy).
export const RESULTS_MAX_AGE_DAYS = 7;

// Refresh unfinished past-kickoff fixtures; settle scores; mark matches completed.
export async function settleApisportsResults() {
    const pending = await db('fixtures')
        .select('id')
        .whereNotIn('status', TERMINAL_STATUSES)
        .where('kickoff', '<', db.raw('NOW()'))
        .where('kickoff', '>', db.raw('NOW() - INTERVAL ? DAY', [RESULTS_MAX_AGE_DAYS]));
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

// --- deep stats (statistics / lineups / events, fetch-once per final fixture) ---

// Stats for minor leagues may never be published; stop retrying empty
// responses this long after kickoff and mark the fixture fetched.
const STATS_GIVEUP_HOURS = 48;

const _PlayerObj = z.object({
    id: z.number().nullable(),
    name: z.string().nullable(),
    number: z.number().nullable().optional(),
    pos: z.string().nullable().optional(),
    grid: z.string().nullable().optional(),
});

const StatisticsItem = z.object({
    team: z.object({ id: z.number() }),
    statistics: z.array(z.object({
        type: z.string(),
        value: z.union([z.string(), z.number()]).nullable(),
    })),
});

const LineupItem = z.object({
    team: z.object({ id: z.number() }),
    formation: z.string().nullable().optional(),
    coach: z.object({
        id: z.number().nullable().optional(),
        name: z.string().nullable().optional(),
    }).partial().nullable().optional(),
    startXI: z.array(z.object({ player: _PlayerObj })).nullable().optional(),
    substitutes: z.array(z.object({ player: _PlayerObj })).nullable().optional(),
});

// Replace + flag one fixture's team statistics. Returns row count.
async function _fetchFixtureStatistics(fixture_id, giveup) {
    const items = (await _get('/fixtures/statistics', { fixture: fixture_id })).map(i => StatisticsItem.parse(i));
    const rows = [];
    for (const item of items) {
        for (const s of item.statistics) {
            rows.push({
                fixture_id,
                team_id: item.team.id,
                type: s.type,
                value: s.value === null ? null : String(s.value),
            });
        }
    }
    if (!rows.length && !giveup) return 0;
    await db.transaction(async trx => {
        await trx('fixture_statistics').where('fixture_id', fixture_id).del();
        if (rows.length) await db.batchInsert('fixture_statistics', rows, 200).transacting(trx);
        await trx('fixtures').where('id', fixture_id).update({ stats_fetched_at: db.fn.now() });
    });
    return rows.length;
}

// Replace + flag one fixture's lineups + players. Returns counts.
async function _fetchFixtureLineups(fixture_id, giveup) {
    const items = (await _get('/fixtures/lineups', { fixture: fixture_id })).map(i => LineupItem.parse(i));
    const lineups = [], players = [];
    for (const item of items) {
        lineups.push({
            fixture_id,
            team_id: item.team.id,
            formation: item.formation ?? null,
            coach_id: item.coach?.id ?? null,
            coach_name: item.coach?.name ?? null,
        });
        for (const [list, is_starter] of [[item.startXI, true], [item.substitutes, false]]) {
            for (const { player } of list ?? []) {
                if (!player?.name) continue; // player_name is required
                players.push({
                    fixture_id,
                    team_id: item.team.id,
                    player_id: player.id,
                    player_name: player.name,
                    number: player.number ?? null,
                    position: player.pos ?? null,
                    grid: player.grid ?? null,
                    is_starter,
                });
            }
        }
    }
    if (!lineups.length && !giveup) return { lineups: 0, players: 0 };
    await db.transaction(async trx => {
        await trx('fixture_players').where('fixture_id', fixture_id).del();
        await trx('fixture_lineups').where('fixture_id', fixture_id).del();
        if (lineups.length) await trx('fixture_lineups').insert(lineups);
        if (players.length) await db.batchInsert('fixture_players', players, 200).transacting(trx);
        await trx('fixtures').where('id', fixture_id).update({ lineups_fetched_at: db.fn.now() });
    });
    return { lineups: lineups.length, players: players.length };
}

// Replace + flag one fixture's events. Returns row count.
async function _fetchFixtureEvents(fixture_id, giveup) {
    const rows = buildEventRows(await _get('/fixtures/events', { fixture: fixture_id }), fixture_id);
    if (!rows.length && !giveup) return 0;
    await db.transaction(async trx => {
        await trx('fixture_events').where('fixture_id', fixture_id).del();
        if (rows.length) await db.batchInsert('fixture_events', rows, 200).transacting(trx);
        await trx('fixtures').where('id', fixture_id).update({ events_fetched_at: db.fn.now() });
    });
    return rows.length;
}

// Fetch deep stats for final fixtures correlated to at least one bookmaker
// match, skipping whatever each fixture already has (fetch-once flags).
export async function fetchApisportsStats() {
    const targets = await db('fixtures as f')
        .whereIn('f.status', FINAL_STATUSES)
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .where(q => q.whereNull('f.stats_fetched_at').orWhereNull('f.lineups_fetched_at').orWhereNull('f.events_fetched_at'))
        .select('f.id', 'f.kickoff', 'f.stats_fetched_at', 'f.lineups_fetched_at', 'f.events_fetched_at');
    console.debug(`API-Football - ${targets.length} final correlated fixtures need deep stats...`);
    const counts = { fixtures: targets.length, statistics: 0, lineups: 0, players: 0, events: 0 };
    const tick = _progress('API-Football - deep stats');
    await _batch(targets, async (f, i, len) => {
        try {
            const giveup = (Date.now() - new Date(f.kickoff).getTime()) > STATS_GIVEUP_HOURS * 3600_000;
            if (!f.stats_fetched_at) counts.statistics += await _fetchFixtureStatistics(f.id, giveup);
            if (!f.lineups_fetched_at) {
                const r = await _fetchFixtureLineups(f.id, giveup);
                counts.lineups += r.lineups;
                counts.players += r.players;
            }
            if (!f.events_fetched_at) counts.events += await _fetchFixtureEvents(f.id, giveup);
        } catch (e) {
            // One fixture's malformed API payload must not abort the whole sweep.
            // Data-shape errors (zod) are logged and skipped - the fixture stays
            // unflagged and is retried next run. Everything else (quota floor,
            // network) still propagates so the run halts cleanly and saves progress.
            if (!(e instanceof z.ZodError)) throw e;
            console.warn(`API-Football - deep stats: skipping fixture ${f.id} (unparseable payload): ${e.message}`);
        }
        tick(len);
    }, 1); // serial: concurrent delete+insert transactions deadlock on index gap locks
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}

// --- team history backfill (fetch-once per upcoming correlated fixture) ---

// Backfill each team's recent finished fixtures plus the pair's full
// head-to-head history for upcoming correlated fixtures, so the pre-match
// rolling-goals windows are complete regardless of how long the warehouse
// has been sweeping. Fetch-once per fixture (fixtures.history_fetched_at):
// <=3 requests each, ever, minus the per-run team dedupe.
export async function fetchApisportsHistory() {
    const targets = await db('fixtures as f')
        .whereNull('f.history_fetched_at')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id', 'f.home_team_id', 'f.away_team_id');
    console.debug(`API-Football - ${targets.length} upcoming correlated fixtures need team history...`);
    // Fetch a buffer beyond the vs-others window: pair meetings are discarded
    // from it, and the H2H window is served by the headtohead call anyway.
    const last = config.PREMATCH_TEAM_WINDOW + config.PREMATCH_H2H_WINDOW;
    const counts = { fixtures: targets.length, saved: 0 };
    const fetchedTeams = new Set(); // a team with several upcoming fixtures costs one call
    const tick = _progress('API-Football - team history');
    await _batch(targets, async (f, i, len) => {
        const items = [];
        for (const team of [f.home_team_id, f.away_team_id]) {
            if (fetchedTeams.has(team)) continue;
            fetchedTeams.add(team);
            items.push(...await _get('/fixtures', { team, last, timezone: TIMEZONE }));
        }
        // No `last` cap: the full meeting history backs the all-time h2h_count
        items.push(...await _get('/fixtures/headtohead', {
            h2h: `${f.home_team_id}-${f.away_team_id}`, timezone: TIMEZONE,
        }));
        // Only finished games are history. headtohead also returns future
        // meetings; saving those would leak never-settling fixtures into the
        // results action's per-id refresh set.
        const finished = items.filter(it => FINAL_STATUSES.includes(it?.fixture?.status?.short));
        const saved = await _saveFixtureItems(finished);
        counts.saved += saved.fixtures;
        await db('fixtures').where('id', f.id).update({ history_fetched_at: db.fn.now() });
        tick(len);
    }, 1); // serial: repo convention for DB-writing batches
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}

// --- predictions (fetch-once per upcoming correlated fixture) ---

// Consumed fields of a /predictions response item (kept tolerant - live data
// has taught this; `raw` in the table preserves everything else).
const PredictionItem = z.object({
    predictions: z.object({
        under_over: z.union([z.string(), z.number()]).nullable().optional(),
        goals: z.object({
            home: z.union([z.string(), z.number()]).nullable().optional(),
            away: z.union([z.string(), z.number()]).nullable().optional(),
        }).partial().nullable().optional(),
        advice: z.string().nullable().optional(),
        percent: z.object({
            home: z.string().nullable().optional(),
            draw: z.string().nullable().optional(),
            away: z.string().nullable().optional(),
        }).partial().nullable().optional(),
    }).partial().nullable().optional(),
});

// "45%" -> 45.00; anything unreadable -> null
function _percent(value) {
    const n = parseFloat(String(value ?? '').replace('%', ''));
    return Number.isFinite(n) ? n : null;
}

// Fetch API-Football's own prediction for each upcoming correlated fixture
// (advice, 1X2 percentages, goals lines) - a boost/veto signal for the hot
// picks rules, never the pick itself. Fetch-once per fixture
// (fixtures.predictions_fetched_at): predictions may drift as kickoff nears,
// but one snapshot up to a few days early is enough for a secondary signal.
export async function fetchApisportsPredictions() {
    const targets = await db('fixtures as f')
        .whereNull('f.predictions_fetched_at')
        .where('f.kickoff', '>', db.raw('NOW()'))
        .whereRaw('EXISTS (SELECT 1 FROM matches m WHERE m.fixture_id = f.id)')
        .select('f.id');
    console.debug(`API-Football - ${targets.length} upcoming correlated fixtures need predictions...`);
    const counts = { fixtures: targets.length, saved: 0 };
    const tick = _progress('API-Football - predictions');
    await _batch(targets, async (f, i, len) => {
        const items = await _get('/predictions', { fixture: f.id });
        const p = items.length ? PredictionItem.parse(items[0]).predictions : null;
        await db.transaction(async trx => {
            if (p) {
                await trx('fixture_api_predictions').insert({
                    fixture_id: f.id,
                    advice: p.advice ?? null,
                    percent_home: _percent(p.percent?.home),
                    percent_draw: _percent(p.percent?.draw),
                    percent_away: _percent(p.percent?.away),
                    under_over: p.under_over == null ? null : String(p.under_over),
                    goals_home: p.goals?.home == null ? null : String(p.goals.home),
                    goals_away: p.goals?.away == null ? null : String(p.goals.away),
                    raw: JSON.stringify(items[0]),
                }).onConflict('fixture_id').merge([
                    'advice', 'percent_home', 'percent_draw', 'percent_away',
                    'under_over', 'goals_home', 'goals_away', 'raw',
                ]);
                counts.saved++;
            }
            // Flag even on an empty response - fetch-once; a fixture without a
            // prediction is simply neutral downstream.
            await trx('fixtures').where('id', f.id).update({ predictions_fetched_at: db.fn.now() });
        });
        tick(len);
    }, 1); // serial: repo convention for DB-writing batches
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}

// --- standings (replace per league+season) ---

const StandingRow = z.object({
    rank: z.number(),
    team: z.object({ id: z.number(), name: z.string(), logo: z.string().nullable().optional() }),
    points: z.number(),
    goalsDiff: z.number(),
    group: z.string().nullable().optional(),
    form: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    all: z.object({
        played: z.number(), win: z.number(), draw: z.number(), lose: z.number(),
        goals: z.object({ for: z.number(), against: z.number() }),
    }),
});

// Refresh standings for every league+season pair seen on correlated fixtures.
export async function fetchApisportsStandings() {
    const pairs = await db('fixtures as f')
        .join('matches as m', 'm.fixture_id', 'f.id')
        .distinct('f.league_id', 'f.season');
    console.debug(`API-Football - ${pairs.length} league/season standings to refresh...`);
    const counts = { leagues: pairs.length, rows: 0, empty: 0 };
    await _batch(pairs, async ({ league_id, season }) => {
        const items = await _get('/standings', { league: league_id, season });
        const groups = items?.[0]?.league?.standings ?? [];
        // Keyed by the standings unique tuple (team_id|group_name; league+season
        // are constant here) so an in-response duplicate - some leagues, e.g.
        // MLS Next Pro, emit a team twice under an identically-labelled group -
        // collapses to one row instead of tripping the unique constraint.
        const byKey = new Map(), teams = new Map();
        for (const group of groups) {
            for (const raw of group) {
                // Placeholder rows (TBD playoff/bracket slots) carry null team
                // ids - no FK target, nothing to store.
                if (!raw?.team?.id) continue;
                const r = StandingRow.parse(raw);
                teams.set(r.team.id, { id: r.team.id, name: r.team.name, logo: r.team.logo ?? null });
                const group_name = r.group ?? '';
                byKey.set(`${r.team.id}|${group_name}`, {
                    league_id,
                    season,
                    team_id: r.team.id,
                    group_name,
                    rank: r.rank,
                    points: r.points,
                    goals_diff: r.goalsDiff,
                    form: r.form ?? null,
                    description: r.description ?? null,
                    played: r.all.played,
                    win: r.all.win,
                    draw: r.all.draw,
                    lose: r.all.lose,
                    goals_for: r.all.goals.for,
                    goals_against: r.all.goals.against,
                    metadata: JSON.stringify(raw),
                });
            }
        }
        const rows = [...byKey.values()];
        if (!rows.length) {
            counts.empty++; // cups/friendlies have no table
            return;
        }
        if (teams.size) {
            await db('teams').insert([...teams.values()]).onConflict('id').merge(['name', 'logo']);
        }
        await db.transaction(async trx => {
            await trx('standings').where({ league_id, season }).del();
            await db.batchInsert('standings', rows, 200).transacting(trx);
        });
        counts.rows += rows.length;
    }, 1); // serial: concurrent delete+insert transactions deadlock on index gap locks
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}
