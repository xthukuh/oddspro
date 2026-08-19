// Pure stalled-collection watchdog rules (zero imports so tests skip
// config/.env). Bookmaker odds are view-once (docs/research/2026-08-19-odds-
// durability-and-outage-damage.md) - a silent stop in the light pass costs
// prices nobody can ever recover. scripts/collection-watchdog.js reads the
// dedicated `last_odds_at` freshness signal (src/meta.js, bumped only by a
// successful odds save - see resolveOddsSignal below for why) and asks
// collectionVerdict what it means; all clocks are epoch ms so tests control
// time (the auto-rules.js convention).

// Classify the collection freshness signal. `lastOddsMs` = the resolved odds
// freshness timestamp (see resolveOddsSignal), or null if odds have never
// been collected. `fixturesNearby` = how many fixtures kick off within the
// +-6h window (see the caller's SQL) - the context that decides how urgent a
// stale signal is:
// a quiet slate legitimately has nothing to scrape, so it gets a much longer
// leash than a busy one. Total and order-independent; tolerant of a null
// lastOddsMs (treated as maximally stale WHEN fixtures are nearby - there is
// no legitimate reason odds have never been collected while games are about
// to kick off; with no fixtures nearby a null lastOddsMs is not itself
// evidence of a problem, so it degrades to the same quiet-slate treatment as
// any other stale reading).
//   'ok'    - fresh enough for the current context
//   'idle'  - no fixtures nearby and not yet past the quiet floor: nothing to
//             scrape, this is not a failure
//   'stale' - collection appears to have stopped; scripts/collection-watchdog.js
//             attempts recovery on this state only
export function collectionVerdict({
    lastOddsMs = null, nowMs = Date.now(), fixturesNearby = 0, staleMinutes = 45, quietStaleMinutes = 240,
} = {}) {
    const nearby = Number(fixturesNearby) > 0;
    if (lastOddsMs == null || !Number.isFinite(Number(lastOddsMs))) {
        return nearby
            ? { state: 'stale', minutes: null, reason: 'no odds ever collected and fixtures are scheduled nearby' }
            : { state: 'idle', minutes: null, reason: 'no odds ever collected, but no fixtures are scheduled nearby' };
    }
    const minutes = Math.max(0, Math.round((Number(nowMs) - Number(lastOddsMs)) / 60_000));
    if (nearby) {
        return minutes > staleMinutes
            ? { state: 'stale', minutes, reason: `odds are ${minutes}m old with fixtures scheduled nearby (floor ${staleMinutes}m)` }
            : { state: 'ok', minutes, reason: `odds are ${minutes}m old, within the ${staleMinutes}m near-kickoff floor` };
    }
    return minutes > quietStaleMinutes
        ? { state: 'stale', minutes, reason: `odds are ${minutes}m old with no fixtures nearby (quiet floor ${quietStaleMinutes}m)` }
        : { state: 'idle', minutes, reason: `no fixtures nearby; odds are ${minutes}m old (quiet floor ${quietStaleMinutes}m)` };
}

// Advance the consecutive-stale run counter (persisted in
// logs/watchdog-state.json across cron runs). 'stale' increments the streak;
// 'ok' resets it (collection is confirmed moving again); 'idle' leaves it
// unchanged - a quiet slate is neither proof collection resumed nor proof it
// is still broken, so it does not reset an in-progress streak nor extend one.
export function nextStaleStreak(state, prevCount = 0) {
    const n = Number.isFinite(prevCount) ? prevCount : 0;
    if (state === 'stale') return n + 1;
    if (state === 'ok') return 0;
    return n;
}

// Whether this run should fire the one-time escalation SMS: the streak has
// reached the alert threshold and this streak has not already alerted (the
// caller resets `alreadyAlerted` alongside the streak count whenever state
// returns to 'ok', so a NEW stale streak alerts again).
export function shouldAlert(streakCount, alertAfter, alreadyAlerted) {
    return Number(streakCount) >= Number(alertAfter) && !alreadyAlerted;
}

// CRITICAL FIX (fix round 1, 2026-08-19): choose the freshness signal
// collectionVerdict is fed. MAX(matches.updated_at) is ALSO bumped by
// src/link.js's fixture_id writes and src/apisports.js's results-settle
// completed_at writes, both independent of odds scraping - a
// both-bookmakers-broken outage with results/link still healthy would never
// trip 'stale' if that column were the signal, which defeats the watchdog's
// whole purpose. src/auto-refresh.js instead stamps a DEDICATED
// `last_odds_at` meta key, bumped ONLY on a successful odds save. This
// resolver prefers that stamp whenever it exists - even if it is OLDER than
// the matches.updated_at fallback, since a newer results/link write must
// never mask a genuinely stalled odds scrape - and falls back to
// MAX(matches.updated_at) ONLY while the meta key has never been set at all
// (a fresh deploy, or before the very first successful odds pass; note this
// also correctly degrades to "always use the fallback" for a host that runs
// with the light pass permanently disabled, since last_odds_at would then
// never exist).
export function resolveOddsSignal({ lastOddsAtMs = null, fallbackMs = null } = {}) {
    if (lastOddsAtMs != null && Number.isFinite(Number(lastOddsAtMs))) {
        return { ms: Number(lastOddsAtMs), source: 'last_odds_at' };
    }
    const fb = fallbackMs != null && Number.isFinite(Number(fallbackMs)) ? Number(fallbackMs) : null;
    return { ms: fb, source: 'matches.updated_at (fallback - no last_odds_at yet)' };
}

// Cap on consecutive-stale runs that may still attempt a recovery restart
// (Task 5, fix round 1, 2026-08-19). Past this many, a restart is clearly not
// fixing anything - bouncing the app forever would just be noise, so
// shouldRestart refuses and the script keeps alerting only.
export const MAX_RESTART_ATTEMPTS = 5;

// Whether this stale run should attempt the recovery restart: capped by a
// per-run cooldown (so a stuck stale state does not bounce the app every
// cron tick forever) AND abandoned completely once `maxAttempts` consecutive
// stale runs have passed without recovering - escalation (shouldAlert) is
// independent and keeps firing regardless of this decision. `lastRestartMs`
// is the previous restart attempt's timestamp (null = never attempted, so
// the very first stale run always restarts).
export function shouldRestart({
    streakCount = 0, lastRestartMs = null, nowMs = Date.now(), cooldownMinutes = 30, maxAttempts = MAX_RESTART_ATTEMPTS,
} = {}) {
    if (Number(streakCount) > Number(maxAttempts)) return false;
    if (lastRestartMs == null || !Number.isFinite(Number(lastRestartMs))) return true;
    return (Number(nowMs) - Number(lastRestartMs)) >= Number(cooldownMinutes) * 60_000;
}
