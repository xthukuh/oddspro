import axios from 'axios';
import { z } from 'zod';
import { config } from './config.js';
import { effective } from './settings.js';
import { _date, _dtime, _batch, _progress } from './utils.js';
import { db } from './db/connection.js';
import { minuteRemaining, msToNextMinute, shouldRetryRateLimit } from './db/rate-rules.js';
import { withRetry } from './db/retry-rules.js';
import { isRetryableApiError } from './db/net-rules.js';
import { buildEventRows } from './apisports-events.js';
import { buildStandingRows } from './apisports-standings.js';
import { buildFixtureItemRows } from './apisports-fixtures.js';

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
        if (_remaining <= effective('APISPORTS_MIN_REMAINING')) {
            throw new Error(
                `api-sports quota floor reached (${_remaining} requests remaining <= ${effective('APISPORTS_MIN_REMAINING')}). `
                + 'Run halted; progress so far is saved.'
            );
        }
        if (_minuteRemaining <= 1) {
            await _sleep(msToNextMinute(Date.now()));
            _minuteRemaining = Infinity; // fresh window; headers re-sync below
        }
        // Transient socket/TLS/DNS faults AND transient HTTP statuses (the
        // live-observed 403-then-success edge throttle, 429/5xx) get a
        // bounded exponential-backoff retry so one blip doesn't abort the
        // whole sweep - the GET is idempotent. Quota-floor + per-minute
        // pacing above are outside the wrap (never retried); the body-level
        // rate-limit path below still owns 200-with-errors responses. A real
        // auth 403 exhausts the 4 tries and stays a loud permanent failure.
        const res = await withRetry(() => ApisportsClient.get(path, { params }), {
            tries: 4, base: 1500, isRetryable: isRetryableApiError,
        });
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

// Upsert fixture items (leagues + teams first for FK integrity). Parsing +
// aggregation is delegated to the pure src/apisports-fixtures.js: a raw item
// that fails validation is skipped and logged rather than thrown - the same
// per-item-isolation fix already applied to standings/events, closing the
// last cascading-throw gap in the fixtures path (2026-08-16 outage class).
async function _saveFixtureItems(items) {
    const { leagues, teams, fixtures, skipped } = buildFixtureItemRows(items);
    if (skipped.length) {
        console.warn(`[apisports] ${skipped.length} fixture items skipped (unparseable)`);
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
    // copy authoritative scores + set the completed flag. The second-half
    // split is guarded: the score columns are UNSIGNED, and API-Football
    // occasionally publishes a final with half-time > full-time (awarded
    // games, data glitches - fixture 1556592 froze the live light pass for
    // three days on 2026-08-16 with ER_DATA_OUT_OF_RANGE). An inconsistent
    // pair stores NULL for the second half instead of aborting the whole pass.
    // Narrowed to rows that actually changed (2026-08-18): the unqualified
    // WHERE rewrote every linked final match on every light pass (~13k rows
    // locally, ~49k on the live host, every 15 min) even when nothing about
    // the fixture had moved. The NULL-safe <=> comparisons below make the
    // UPDATE a no-op for a match already settled to the current fixture
    // values - a genuinely-corrected score (e.g. a post-refetch fix) still
    // matches and updates normally.
    const finalsIn = FINAL_STATUSES.map(() => '?').join(',');
    const [settled] = await db.raw(
        `UPDATE matches m JOIN fixtures f ON m.fixture_id = f.id
         SET m.home_score_fulltime = COALESCE(f.ft_home, f.goals_home),
             m.away_score_fulltime = COALESCE(f.ft_away, f.goals_away),
             m.home_score_first_half = f.ht_home,
             m.away_score_first_half = f.ht_away,
             m.home_score_second_half = CASE WHEN COALESCE(f.ft_home, f.goals_home) >= f.ht_home
                 THEN COALESCE(f.ft_home, f.goals_home) - f.ht_home END,
             m.away_score_second_half = CASE WHEN COALESCE(f.ft_away, f.goals_away) >= f.ht_away
                 THEN COALESCE(f.ft_away, f.goals_away) - f.ht_away END,
             m.completed_at = COALESCE(m.completed_at, NOW())
         WHERE f.status IN (${finalsIn})
           AND (m.completed_at IS NULL
                OR NOT (m.home_score_fulltime <=> COALESCE(f.ft_home, f.goals_home)
                    AND m.away_score_fulltime <=> COALESCE(f.ft_away, f.goals_away)
                    AND m.home_score_first_half <=> f.ht_home
                    AND m.away_score_first_half <=> f.ht_away))`,
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

    // Fallback: matches long past kickoff stop being refreshed. The cutoff prefers the
    // CANONICAL fixture kickoff whenever the match is linked - matches.start_time is
    // bookmaker-provided and goes stale on a reschedule (seen 24h adrift), which would
    // otherwise complete a game still in play and freeze its odds mid-match. Unlinked
    // matches keep falling back to start_time, and retired NS/PST zombies (kickoff long
    // past, never terminal upstream) still complete here rather than scraping forever.
    const [fallback] = await db.raw(
        `UPDATE matches m LEFT JOIN fixtures f ON f.id = m.fixture_id
         SET m.completed_at = NOW()
         WHERE m.completed_at IS NULL
           AND COALESCE(f.kickoff, m.start_time) < NOW() - INTERVAL 4 HOUR`
    );

    return {
        refreshed,
        settled: settled.affectedRows ?? 0,
        fallback_completed: fallback.affectedRows ?? 0,
        quota_remaining: apisportsQuotaRemaining(),
    };
}

// Force-refetch a specific set of API-Football fixture ids (e.g. the
// half-time/full-time-inconsistent fixtures the settle guard now stores as
// NULL for the second half - a manual re-poll sometimes finds API-Football
// has since corrected the record). Mirrors the /fixtures?ids= batching in
// settleApisportsResults; the caller is expected to run
// settleApisportsResults() afterwards to re-propagate any corrected scores
// into matches. Read-write (bills quota), CLI-only - not part of any sweep.
export async function refetchFixtureIds(ids) {
    const list = [...new Set(ids.map(id => String(id)))];
    const groups = [];
    for (let i = 0; i < list.length; i += 20) {
        groups.push(list.slice(i, i + 20).join('-'));
    }
    let saved = 0;
    await _batch(groups, async group => {
        const items = await _get('/fixtures', { ids: group, timezone: TIMEZONE });
        const counts = await _saveFixtureItems(items);
        saved += counts.fixtures;
    }, 2);
    return { requested: list.length, saved };
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

// Parse each raw item against `schema`, skipping (and counting) any that
// fail rather than letting one malformed team record (e.g. a missing
// statistics array) throw and discard the OTHER team's valid data in the
// same response - the same per-item-isolation fix as apisports-events.js /
// apisports-standings.js, applied to the statistics/lineups parsers.
function _parseEach(schema, rawItems, label) {
    const parsed = [];
    let skipped = 0;
    for (const raw of rawItems) {
        try {
            parsed.push(schema.parse(raw));
        } catch {
            skipped++;
        }
    }
    if (skipped) {
        console.warn(`[apisports] ${label}: ${skipped} item(s) skipped (unparseable)`);
    }
    return parsed;
}

// Replace + flag one fixture's team statistics. Returns row count.
async function _fetchFixtureStatistics(fixture_id, giveup) {
    const items = _parseEach(StatisticsItem, await _get('/fixtures/statistics', { fixture: fixture_id }), 'statistics');
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
    const items = _parseEach(LineupItem, await _get('/fixtures/lineups', { fixture: fixture_id }), 'lineups');
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
    const last = effective('PREMATCH_TEAM_WINDOW') + effective('PREMATCH_H2H_WINDOW');
    const counts = { fixtures: targets.length, saved: 0 };
    const fetchedTeams = new Set(); // a team with several upcoming fixtures costs one call
    const tick = _progress('API-Football - team history');
    await _batch(targets, async (f, i, len) => {
        try {
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
        } catch (e) {
            // One fixture's malformed API payload must not abort the whole sweep.
            // Data-shape errors (zod) are logged and skipped - the fixture stays
            // unflagged and is retried next run. Everything else (quota floor,
            // network) still propagates so the run halts cleanly and saves progress.
            if (!(e instanceof z.ZodError)) throw e;
            console.warn(`API-Football - team history: skipping fixture ${f.id} (unparseable payload): ${e.message}`);
        }
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
        try {
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
        } catch (e) {
            // One fixture's malformed API payload must not abort the whole sweep.
            // Data-shape errors (zod) are logged and skipped - the fixture stays
            // unflagged and is retried next run. Everything else (quota floor,
            // network) still propagates so the run halts cleanly and saves progress.
            if (!(e instanceof z.ZodError)) throw e;
            console.warn(`API-Football - predictions: skipping fixture ${f.id} (unparseable payload): ${e.message}`);
        }
        tick(len);
    }, 1); // serial: repo convention for DB-writing batches
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}

// --- standings (replace per league+season) ---

// Refresh standings for every league+season pair seen on correlated fixtures.
// Parsing + row shaping live in the pure src/apisports-standings.js (tolerant
// of the observed `points: null` bracket rows; a row zod cannot parse is
// skipped and logged, never thrown - one bad row must not abort the sweep).
export async function fetchApisportsStandings() {
    const pairs = await db('fixtures as f')
        .join('matches as m', 'm.fixture_id', 'f.id')
        .distinct('f.league_id', 'f.season');
    console.debug(`API-Football - ${pairs.length} league/season standings to refresh...`);
    const counts = { leagues: pairs.length, rows: 0, empty: 0, skipped: 0 };
    await _batch(pairs, async ({ league_id, season }) => {
        const items = await _get('/standings', { league: league_id, season });
        const groups = items?.[0]?.league?.standings ?? [];
        const { rows, teams: teamRows, skipped } = buildStandingRows(groups, { league_id, season });
        if (skipped.length) {
            counts.skipped += skipped.length;
            console.warn(`  standings ${league_id}/${season}: skipped ${skipped.length} unparseable row(s)`);
        }
        if (!rows.length) {
            counts.empty++; // cups/friendlies have no table
            return;
        }
        if (teamRows.length) {
            await db('teams').insert(teamRows).onConflict('id').merge(['name', 'logo']);
        }
        await db.transaction(async trx => {
            await trx('standings').where({ league_id, season }).del();
            await db.batchInsert('standings', rows, 200).transacting(trx);
        });
        counts.rows += rows.length;
    }, 1); // serial: concurrent delete+insert transactions deadlock on index gap locks
    return { ...counts, quota_remaining: apisportsQuotaRemaining() };
}
