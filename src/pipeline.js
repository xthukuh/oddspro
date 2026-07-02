import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { fetchApisportsFixtures, settleApisportsResults, fetchApisportsStats, fetchApisportsStandings, fetchApisportsHistory, apisportsQuotaRemaining } from './apisports.js';
import { saveMatches, completedMatchIds } from './db/store.js';
import { linkMatches } from './link.js';
import { updatePrematchSnapshots } from './prematch.js';
import { _date, _dtime } from './utils.js';

// `npm run start` sweeps today plus this many future days by default
const DEFAULT_DAYS_AHEAD = 3;

const STEPS = 9;

// Full ingestion pipeline (default `npm run start` action). Step order is
// chosen to minimize server hits:
//   1. fixtures per date - refreshing today wholesale (1-3 paginated requests)
//      also updates today's statuses, shrinking the per-id refresh set below;
//   2. results - settles scores and marks matches completed BEFORE odds
//      scraping, so scrapers skip detail requests for finished games;
//   3-4. bookmaker odds per date (completed matches excluded pre-fetch);
//   5. link once after all ingestion (instead of after every fetch);
//   6-7. deep stats (fetch-once flags) + standings;
//   8. team history backfill (fetch-once) - needs linked fixtures (5);
//   9. pre-match snapshots - needs local history (8) and fresh standings (7).
export async function runStartPipeline(days_ahead_ = null) {
    // parseInt: null/undefined parse to NaN (Number(null) would be 0)
    const n = parseInt(days_ahead_, 10);
    const days_ahead = Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAYS_AHEAD;
    const today = _date();
    const dates = [...Array(days_ahead + 1)].map((_, i) =>
        _dtime(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)).substring(0, 10)
    );
    let step = 0;
    const _step = label => console.debug(`\n[start ${++step}/${STEPS}] ${label}`);
    console.debug(`[start] Full pipeline - ${dates.length} date(s): ${dates.join(', ')}...`);

    _step('API-Football fixtures (canonical base records)');
    for (const dt of dates) {
        const c = await fetchApisportsFixtures(dt);
        console.debug(`[+] fixtures ${dt}: ${c.fixtures} fixtures, ${c.leagues} leagues, ${c.teams} teams upserted (quota remaining: ${c.quota_remaining}).`);
    }

    _step('results (settle finished fixtures, complete matches)');
    const r = await settleApisportsResults();
    console.debug(`[+] results: ${r.refreshed} fixtures refreshed, ${r.settled} matches settled, ${r.fallback_completed} fallback-completed (quota remaining: ${r.quota_remaining}).`);

    for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
        _step(`${provider} odds`);
        const exclude = await completedMatchIds(provider, `${dates[0]} 00:00:00`);
        for (const dt of dates) {
            const games = await fetcher(dt, exclude);
            const c = await saveMatches(games);
            console.debug(`[+] ${provider} ${dt}: ${c.inserted} inserted, ${c.updated} updated, ${c.skipped} skipped (completed), ${c.markets} odds market rows saved.`);
        }
    }

    _step('link (correlate bookmaker matches to fixtures)');
    await linkMatches();

    _step('deep stats (final correlated fixtures, fetch-once)');
    const s = await fetchApisportsStats();
    console.debug(`[+] stats: ${s.fixtures} fixtures processed - ${s.statistics} statistics, ${s.lineups} lineups (${s.players} players), ${s.events} events (quota remaining: ${s.quota_remaining}).`);

    _step('standings (correlated leagues)');
    const t = await fetchApisportsStandings();
    console.debug(`[+] standings: ${t.leagues} league/seasons, ${t.rows} rows saved, ${t.empty} without tables (quota remaining: ${t.quota_remaining}).`);

    _step('team history (upcoming correlated fixtures, fetch-once)');
    const h = await fetchApisportsHistory();
    console.debug(`[+] history: ${h.fixtures} fixtures processed, ${h.saved} historical fixtures saved (quota remaining: ${h.quota_remaining}).`);

    _step('pre-match snapshots (upsert upcoming, freeze past)');
    const p = await updatePrematchSnapshots();
    console.debug(`[+] prematch: ${p.written} snapshots upserted.`);

    console.debug(`\n[start] Done - ${dates[0]} .. ${dates[dates.length - 1]} (quota remaining: ${apisportsQuotaRemaining()}).`);
}

// On-demand single-date refresh (web UI refresh button): fixtures, results
// (unless the date is in the future - nothing to settle yet), both bookmakers'
// odds, one link pass, then deep stats; for today/future dates also team
// history + pre-match snapshots. Standings stay owned by the full pipeline -
// a league-wide sweep is out of scope for one date. `onStep` gets each step
// label (job progress for the API).
export async function runDateRefresh(date_, onStep = null) {
    const dt = _dtime(_date(date_)).substring(0, 10);
    const today = _dtime(_date()).substring(0, 10);
    const _step = label => {
        console.debug(`[refresh ${dt}] ${label}...`);
        if (typeof onStep === 'function') onStep(label);
    };
    const summary = { date: dt };

    _step('fixtures');
    summary.fixtures = (await fetchApisportsFixtures(dt)).fixtures;

    if (dt <= today) {
        _step('results');
        const r = await settleApisportsResults();
        summary.settled = r.settled;
    }

    for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
        _step(`${provider} odds`);
        const exclude = await completedMatchIds(provider, `${dt} 00:00:00`);
        const c = await saveMatches(await fetcher(dt, exclude));
        summary[provider] = { saved: c.inserted + c.updated, skipped: c.skipped, markets: c.markets };
    }

    _step('link');
    await linkMatches();

    if (dt <= today) {
        _step('deep stats');
        summary.stats = (await fetchApisportsStats()).fixtures;
    }

    if (dt >= today) {
        // Upcoming fixtures only: past dates are frozen (and already fetched).
        // Snapshots copy whatever standings exist - standings stay owned by
        // the full pipeline, matching what the live view would have shown.
        _step('team history');
        summary.history = (await fetchApisportsHistory()).fixtures;

        _step('pre-match snapshots');
        summary.prematch = (await updatePrematchSnapshots()).written;
    }

    summary.quota_remaining = apisportsQuotaRemaining();
    console.debug(`[refresh ${dt}] Done - ${JSON.stringify(summary)}`);
    return summary;
}
