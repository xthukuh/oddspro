# Ingestion pipeline audit, 2026-08-19

Read-only audit of the collection path, run after the three-day outage. Findings were
produced by parallel agents and then verified by hand before any code was changed. Ranked
by irreplaceable data at risk, because bookmaker odds are view-once while API-Football
data can always be re-fetched (`2026-08-19-odds-durability-and-outage-damage.md`).

**Coverage note, stated honestly:** the `src/apisports.js` and `src/link.js` audits both
died on API errors before reporting. Those two surfaces are NOT covered here and remain
open work. Everything below was actually completed.

## Fixed in this session

**F1. A failed BetPawa list page read as "end of data" (CRITICAL, silent).**
`src/betpawa.js` caught any list-page error and returned `{error: e}`. `res.data` was then
undefined, so the page parsed as an empty array, `done = len < take` evaluated true, and
the truncated buffer was returned as a normal successful result and persisted by
`saveMatches` as a complete day. A transient timeout, 429 or 5xx on page two of a busy day
silently produced a partial day that looked exactly like a quiet one. Verified by hand.
Betika was already correct (it throws). Fixed: bounded retry with backoff, and a throw on
exhaustion, so `done` can only be computed from a genuinely successful response.

**F2. An empty market list mass-marked live prices stale (CRITICAL).**
Both parsers fall back to `markets: []` when the expected array is missing, so a
degraded-but-200 detail response produced a structurally valid record with zero markets.
`diffOddsRows` then moved every existing fresh row into `staleIds`. Because a frozen match
is never revisited, if that glitch landed on the last fetch before kickoff, genuinely live
closing prices were permanently recorded as stale. Fixed: an empty snapshot now means "no
snapshot", never "empty snapshot" (`emptySnapshotIsSuspect`), so existing rows are left
untouched and the event is logged.

**F3. The collection heartbeat lied when the scraper returned nothing (IMPORTANT).**
`last_odds_at` was stamped whenever `saveMatches` did not throw, so a scraper running but
returning zero markets read as healthy and defeated the watchdog built to catch exactly
that. Fixed: stamped only when markets were written or a match row changed
(`hasOddsSaveData`). This one was a defect in code written earlier the same day, which is
a useful reminder that new safety code needs the same scrutiny as old code.

**F4. One bad match discarded the whole fetched day (IMPORTANT).**
A single failing per-match detail fetch rejected the whole `_batch`, throwing away every
game already fetched for that date and aborting the rest of the run. Fixed: per-match
failures are caught, logged with provider and id, and skipped, with a failure count in the
summary line.

**F5. The full sweep had no step isolation and burned its daily slot on failure
(CRITICAL).** The post-outage hardening went into `lightRefresh` only. `src/pipeline.js`
remained an unguarded sequential chain, and the full sweep is the ONLY thing that fetches
odds for FUTURE dates, since the light pass scopes today alone. The tick also stamped the
day BEFORE running, so a failure was not retried until the next day. A throw in the early
steps therefore cost up to 24 hours of future-date odds, silently. Fixed in the same
pattern: per-step and per-provider-per-date guards, and a bounded same-day retry.

## Verified safe (a confidence map, not just a defect list)

- **Transaction atomicity in `saveMatches`.** The whole per-match refresh (upsert, diff,
  stale marking, delete, batch insert) runs in one transaction wrapped in `withRetry`, so
  there is no window where markets are deleted but not reinserted.
- **DB write concurrency.** `saveMatches` iterates sequentially; `_batch` concurrency is
  used only for HTTP detail fetches, never for DB writes, matching the documented
  gap-lock discipline.
- **`updated_at` bumping** is explicit, correctly bypassing MySQL's no-op-update skip.
- **The HT/FT settle guard is scoped correctly.** A tree-wide search found no other score
  arithmetic that could underflow an unsigned column, and the hot-pick settle only adds.
- **The `odds_markets` catalog scan** is covered by a purpose-built index (documented as
  taking it from never-completing to under a second), and no other unbounded scan of the
  large tables exists in the ingestion path.
- **`oddsRefreshDue` and the tier parser fail open**: a match with no resolvable kickoff
  always refreshes, and a malformed tier config disables backoff rather than skipping
  fetches.
- **Log growth** is bounded by the self-truncating logger; in-memory maps grow at roughly
  one entry per day, which is negligible.

## Corrected during review (do not act on these)

- **The "UTC host" timezone finding does not apply.** An agent reported that `_date()` and
  `_dtime()` use process-local time while the host runs UTC, which would make the scrapers
  fetch the wrong day during the first three hours of each EAT day. The host was checked
  directly: it runs `Africa/Nairobi`, so local time IS EAT and the bug does not bite. It
  remains a latent portability risk if the app is ever moved to a UTC host, and is worth
  fixing when the scheduler is next touched, but it is not an active defect.

## Open, not addressed

1. **`src/apisports.js` and `src/link.js` were never audited** (agents failed). Of the two,
   `link.js` matters more: a confident wrong link teaches a permanent alias, and about 33k
   unlinkable Betika virtual "Zoom" matches are re-attempted at cost.
2. **No statement or pool-acquire timeout.** `knexfile.js` sets only pool min and max. A
   single runaway query can hold a connection indefinitely, and with three instances
   sharing a small pool that is a plausible path to starving collection. The fix mirrors
   the existing `time_zone` hook: set `max_execution_time` in `afterCreate`, plus
   `acquireTimeoutMillis` so a starved pool fails fast instead of hanging.
3. **No step-level wall-clock budget.** The guards catch throws but not hangs; a multi
   minute stall in an early step still delays odds collection behind it.
4. **No dead-man's switch on the watchdog itself.** If cron stops running it, nothing
   external notices.
5. **A canary for implausibly empty scrapes.** An anti-bot response that returns HTTP 200
   with an empty body is now prevented from stale-bombing prices (F2), but nothing yet
   alerts that a normally busy date came back with zero games.
