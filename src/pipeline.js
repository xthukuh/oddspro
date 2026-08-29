import { fetchBetpawaGames } from './betpawa.js';
import { fetchBetikaGames } from './betika.js';
import { fetchApisportsFixtures, settleApisportsResults, fetchApisportsStats, fetchApisportsStandings, fetchApisportsHistory, fetchApisportsPredictions, apisportsQuotaRemaining } from './apisports.js';
import { saveMatches, completedMatchIds } from './db/store.js';
import { linkMatches } from './link.js';
import { updatePrematchSnapshots } from './prematch.js';
import { updateHotPicks } from './hotpicks.js';
import { buildDailySlip, settleDailySlips } from './daily-slip.js';
import { enrichFixtures } from './enrich.js';
import { makeStepGuard, summarizeSteps, summarizeTimings, hasDataBearingSuccess, hasOddsSaveData } from './db/auto-rules.js';
import { setMeta } from './meta.js';
import { _date, _dtime, debugLog } from './utils.js';

// The collection heartbeat, shared with src/auto-refresh.js's light pass.
//
// FIX (2026-08-28): `last_odds_at` used to be stamped ONLY by lightRefresh,
// but the single-slot job guard means a full sweep BLOCKS every light pass
// for its whole duration - measured at 3.7-5.5h on the live host. The key
// therefore froze for hours while this pipeline was busily saving odds, and
// scripts/collection-watchdog.js (which reads exactly this key - see
// src/db/watchdog-rules.js#resolveOddsSignal) read the freeze as a stalled
// scrape: every night it declared a stall, recycled Passenger mid-sweep and
// SMS-ed the admin, all while collection was healthy.
//
// Same contract as the light path: stamped ONLY when odds data actually
// landed (hasOddsSaveData - a scraper that ran and returned nothing must not
// read as healthy), and best-effort, so a meta write failure can never fail
// the odds step that just succeeded. Deliberately NOT gated on isWriter():
// unlike lightRefresh this pipeline is also the CLI `npm run start` entry
// point that cron-only hosts drive, and odds collected there are just as real.
function _stampOddsHeartbeat(counts) {
    if (!hasOddsSaveData(counts)) return;
    setMeta('last_odds_at', new Date().toISOString())
        .catch(e => console.error('[pipeline] last_odds_at meta write failed:', e?.message ?? e));
}

// `npm run start` sweeps today plus this many future days by default
const DEFAULT_DAYS_AHEAD = 3;

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
//   9. pre-match snapshots - needs local history (8) and fresh standings (7);
//   10. API predictions (fetch-once) - the hot-pick boost/veto signal;
//   11. hot picks - needs snapshots (9), predictions (10) and fresh odds (3-4);
//   12. AI enrichment (M4.1, collection only, off by default) - the anchored
//       call needs the tip hot picks (11) just wrote, so this MUST run last.
//
// Task 1 (2026-08-19 durability pass round 2, docs/research/2026-08-19-odds-
// durability-and-outage-damage.md section 4.2): lightRefresh got per-step
// isolation in round 1 (makeStepGuard, src/db/auto-rules.js) but this
// function - the ONLY thing that fetches odds for FUTURE dates - never did.
// A throw in an early step (results, exactly the step that caused the
// 2026-08-16 outage) used to skip every step after it, including every
// remaining date's odds scrape, for up to 24h until the next scheduled sweep.
// Every step below is now independently guarded via guardStep: a throw is
// caught, recorded and logged, and the pass continues. The ORDER is
// unchanged. Fixtures and odds are guarded PER DATE (odds additionally per
// provider) - the highest-value line in this pass - so one date or one
// provider failing cannot cost the others within the same phase.
export async function runStartPipeline(days_ahead_ = null, onStep = null, shouldCancel = null) {
    // parseInt: null/undefined parse to NaN (Number(null) would be 0)
    const n = parseInt(days_ahead_, 10);
    const days_ahead = Number.isInteger(n) && n >= 0 ? n : DEFAULT_DAYS_AHEAD;
    const today = _date();
    const dates = [...Array(days_ahead + 1)].map((_, i) =>
        _dtime(new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)).substring(0, 10)
    );
    const totalSteps = 3 * dates.length + 10; // dates.length x (fixtures + betpawa + betika) + 10 single-shot phases
    let step = 0;
    const pipelineStarted = Date.now();
    let stepStarted = pipelineStarted;
    const _step = label => {
        if (typeof shouldCancel === 'function' && shouldCancel()) throw new Error('cancelled');
        if (step) debugLog(`step ${step}/${totalSteps} done in ${Date.now() - stepStarted}ms`);
        console.debug(`\n[start ${++step}/${totalSteps}] ${label}`);
        if (typeof onStep === 'function') onStep(label);
        stepStarted = Date.now();
    };
    console.debug(`[start] Full pipeline - ${dates.length} date(s): ${dates.join(', ')}...`);

    // Per-step outcomes for every guarded unit below. checkCancel runs
    // OUTSIDE guardStep's try (see makeStepGuard), so the cooperative-cancel
    // throw always propagates uncaught and aborts the whole run immediately -
    // only an ordinary step Error is captured into stepResults.
    const stepResults = [];
    const guardStep = makeStepGuard({
        results: stepResults,
        checkCancel: _step,
        onFailure: (label, message) => console.error(`[start] ${label} failed:`, message),
    });

    for (const dt of dates) {
        await guardStep(`fixtures ${dt}`, async () => {
            const c = await fetchApisportsFixtures(dt);
            console.debug(`[+] fixtures ${dt}: ${c.fixtures} fixtures, ${c.leagues} leagues, ${c.teams} teams upserted (quota remaining: ${c.quota_remaining}).`);
        });
    }

    const r = await guardStep('results (settle finished fixtures, complete matches)', () => settleApisportsResults());
    if (r) console.debug(`[+] results: ${r.refreshed} fixtures refreshed, ${r.settled} matches settled, ${r.fallback_completed} fallback-completed (quota remaining: ${r.quota_remaining}).`);

    // The single most valuable line in this task: a failure fetching one
    // provider's odds for one date must not prevent every other provider/date
    // combination from being scraped, so each (provider, date) pair is its
    // own guarded unit. The exclusion query is recomputed per date INSIDE the
    // guard (cheap) rather than hoisted, so a failure there is isolated too
    // and can never abort the whole provider's date loop.
    for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
        for (const dt of dates) {
            await guardStep(`${provider} odds ${dt}`, async () => {
                const exclude = await completedMatchIds(provider, `${dates[0]} 00:00:00`);
                const c = await saveMatches(await fetcher(dt, exclude));
                _stampOddsHeartbeat(c);
                console.debug(`[+] ${provider} ${dt}: ${c.inserted} inserted, ${c.updated} updated, ${c.skipped} skipped (completed), ${c.markets} odds market rows saved.`);
            });
        }
    }

    await guardStep('link (correlate bookmaker matches to fixtures)', () => linkMatches());

    const s = await guardStep('deep stats (final correlated fixtures, fetch-once)', () => fetchApisportsStats());
    if (s) console.debug(`[+] stats: ${s.fixtures} fixtures processed - ${s.statistics} statistics, ${s.lineups} lineups (${s.players} players), ${s.events} events (quota remaining: ${s.quota_remaining}).`);

    const t = await guardStep('standings (correlated leagues)', () => fetchApisportsStandings());
    if (t) console.debug(`[+] standings: ${t.leagues} league/seasons, ${t.rows} rows saved, ${t.empty} without tables (quota remaining: ${t.quota_remaining}).`);

    const h = await guardStep('team history (upcoming correlated fixtures, fetch-once)', () => fetchApisportsHistory());
    if (h) console.debug(`[+] history: ${h.fixtures} fixtures processed, ${h.saved} historical fixtures saved (quota remaining: ${h.quota_remaining}).`);

    const p = await guardStep('pre-match snapshots (upsert upcoming, freeze past)', () => updatePrematchSnapshots());
    if (p) console.debug(`[+] prematch: ${p.written} snapshots upserted.`);

    const a = await guardStep('API predictions (upcoming correlated fixtures, fetch-once)', () => fetchApisportsPredictions());
    if (a) console.debug(`[+] predictions: ${a.fixtures} fixtures processed, ${a.saved} predictions saved (quota remaining: ${a.quota_remaining}).`);

    const k = await guardStep('hot picks (rules; AI reviews run in the background worker)', () => updateHotPicks());
    if (k) console.debug(`[+] hotpicks: ${k.settled} settled (${k.tips_settled} tips), ${k.written} evaluated, ${k.hot} hot, ${k.tips} tips (AI reviews pending: ${k.pending_reviews.hot} hot, ${k.pending_reviews.tips} tips - worker/aireview drains them).`);

    await guardStep('daily multibet slip (settle pending, build today\'s card)', async () => {
        const dsSettle = await settleDailySlips();
        const ds = await buildDailySlip();
        console.debug(`[+] dailyslip: ${dsSettle.settled} settled; today ${ds.frozen ? 'frozen'
            : ds.noSlip ? 'NO SLIP' : `${ds.slip.mood} card, ${ds.slip.legs} legs @ ${ds.slip.combined_odds}x`}.`);
    });

    const e = await guardStep('AI enrichment (upcoming correlated fixtures; collection only)', () => enrichFixtures());
    if (e) console.debug(`[+] enrich: ${e.fixtures} fixtures, ${e.written} insights, ${e.errors} errors.`);

    debugLog(`step ${step}/${totalSteps} done in ${Date.now() - stepStarted}ms`);
    debugLog(`total pipeline time ${Date.now() - pipelineStarted}ms`);

    // Final verdict over every guarded step (mirrors lightRefresh). 'partial'
    // is a normal return - real work may have landed - so step 2's retry
    // decision (fullSweepAttemptVerdict) and shouldStampFreshness both key
    // off data_bearing_ok rather than the verdict alone; 'error' (every
    // guarded step failed) throws so the run is honestly classified as a
    // failure by refreshOutcome instead of silently reporting 'ok'.
    const step_failures = stepResults.filter(x => !x.ok).map(({ step: stepName, error }) => ({ step: stepName, error }));
    const steps_verdict = summarizeSteps(stepResults);
    const data_bearing_ok = hasDataBearingSuccess(stepResults);
    console.debug(`\n[start] Done - ${dates[0]} .. ${dates[dates.length - 1]} (quota remaining: ${apisportsQuotaRemaining()}, verdict: ${steps_verdict}).`);
    if (steps_verdict === 'error') {
        throw new Error(`full pipeline: every step failed (${step_failures.map(f => `${f.step}: ${f.error}`).join('; ')})`);
    }
    return { dates, quota_remaining: apisportsQuotaRemaining(), step_failures, steps_verdict, data_bearing_ok,
        step_timings: summarizeTimings(stepResults) };
}

// On-demand single-date refresh (web UI refresh button): fixtures, results
// (unless the date is in the future - nothing to settle yet), both bookmakers'
// odds, one link pass, then deep stats; for today/future dates also team
// history + pre-match snapshots. Standings stay owned by the full pipeline -
// a league-wide sweep is out of scope for one date. `onStep` gets each step
// label (job progress for the API).
//
// Task 1 (2026-08-19 durability pass round 2): same per-step isolation as
// runStartPipeline above, via the SAME makeStepGuard - a throw in one step
// (fixtures, results, either provider's odds, ...) no longer skips the rest.
// Single date, so "each provider's odds fetch per date its own guarded unit"
// already holds with one guard per provider (no further date nesting needed).
export async function runDateRefresh(date_, onStep = null, shouldCancel = null) {
    const dt = _dtime(_date(date_)).substring(0, 10);
    const today = _dtime(_date()).substring(0, 10);
    const refreshStarted = Date.now();
    let stepStarted = refreshStarted;
    let lastLabel = null;
    const _step = label => {
        // Cooperative cancel (F3): abort at a step boundary; finished steps stay
        // (idempotent - a resume re-run skips them via the fetch-once flags).
        if (typeof shouldCancel === 'function' && shouldCancel()) throw new Error('cancelled');
        if (lastLabel) debugLog(`refresh ${dt}: ${lastLabel} done in ${Date.now() - stepStarted}ms`);
        console.debug(`[refresh ${dt}] ${label}...`);
        if (typeof onStep === 'function') onStep(label);
        lastLabel = label;
        stepStarted = Date.now();
    };
    const summary = { date: dt };

    // Same guardStep idiom as lightRefresh/runStartPipeline: checkCancel
    // (=_step) runs OUTSIDE the try, so a cancel always aborts the whole run
    // uncaught; only an ordinary step Error is captured into stepResults.
    const stepResults = [];
    const guardStep = makeStepGuard({
        results: stepResults,
        checkCancel: _step,
        onFailure: (label, message) => console.error(`[refresh ${dt}] ${label} failed:`, message),
    });

    const fx = await guardStep('fixtures', () => fetchApisportsFixtures(dt));
    if (fx) summary.fixtures = fx.fixtures;

    if (dt <= today) {
        const r = await guardStep('results', () => settleApisportsResults());
        if (r) summary.settled = r.settled;
    }

    for (const [provider, fetcher] of [['betpawa', fetchBetpawaGames], ['betika', fetchBetikaGames]]) {
        const res = await guardStep(`${provider} odds`, async () => {
            const exclude = await completedMatchIds(provider, `${dt} 00:00:00`);
            const c = await saveMatches(await fetcher(dt, exclude));
            _stampOddsHeartbeat(c);
            return c;
        });
        if (res) summary[provider] = { saved: res.inserted + res.updated, skipped: res.skipped, markets: res.markets };
    }

    await guardStep('link', () => linkMatches());

    if (dt <= today) {
        const st = await guardStep('deep stats', () => fetchApisportsStats());
        if (st) summary.stats = st.fixtures;
    }

    if (dt >= today) {
        // Upcoming fixtures only: past dates are frozen (and already fetched).
        // Snapshots copy whatever standings exist - standings stay owned by
        // the full pipeline, matching what the live view would have shown.
        const h = await guardStep('team history', () => fetchApisportsHistory());
        if (h) summary.history = h.fixtures;

        const p = await guardStep('pre-match snapshots', () => updatePrematchSnapshots());
        if (p) summary.prematch = p.written;

        const a = await guardStep('API predictions', () => fetchApisportsPredictions());
        if (a) summary.predictions = a.saved;

        const k = await guardStep('hot picks', () => updateHotPicks());
        if (k) summary.hotpicks = k.hot;
    }

    if (lastLabel) debugLog(`refresh ${dt}: ${lastLabel} done in ${Date.now() - stepStarted}ms`);
    debugLog(`refresh ${dt}: total time ${Date.now() - refreshStarted}ms`);
    summary.quota_remaining = apisportsQuotaRemaining();
    summary.step_failures = stepResults.filter(x => !x.ok).map(({ step, error }) => ({ step, error }));
    summary.steps_verdict = summarizeSteps(stepResults);
    summary.data_bearing_ok = hasDataBearingSuccess(stepResults);
    summary.step_timings = summarizeTimings(stepResults);
    console.debug(`[refresh ${dt}] Done - ${JSON.stringify(summary)}`);
    if (summary.steps_verdict === 'error') {
        throw new Error(`date refresh ${dt}: every step failed (${summary.step_failures.map(f => `${f.step}: ${f.error}`).join('; ')})`);
    }
    return summary;
}
