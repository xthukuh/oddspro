// Pure stalled-collection watchdog rules (zero imports so tests skip
// config/.env). Bookmaker odds are view-once (docs/research/2026-08-19-odds-
// durability-and-outage-damage.md) - a silent stop in the light pass costs
// prices nobody can ever recover. scripts/collection-watchdog.js reads the
// freshness signal (MAX(matches.updated_at)) straight from the warehouse and
// asks collectionVerdict what it means; all clocks are epoch ms so tests
// control time (the auto-rules.js convention).

// Classify the collection freshness signal. `lastOddsMs` = the most recent
// matches.updated_at, or null if odds have never been collected.
// `fixturesNearby` = how many fixtures kick off within the +-6h window (see
// the caller's SQL) - the context that decides how urgent a stale signal is:
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
