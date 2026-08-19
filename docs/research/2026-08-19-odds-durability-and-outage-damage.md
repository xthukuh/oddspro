# Bookmaker odds are view-once data: outage damage, durability, and the market it implies

Written 2026-08-19 after the three-day production outage (2026-08-16 01:20 to 2026-08-19
00:00 EAT) and the historical-gap audit that followed. This document records what was
permanently lost, why it cannot be recovered, what now protects the pipeline, and the
business case the asymmetry creates.

## 1. The asymmetry that governs everything

Two data sources feed the warehouse, and they behave in opposite ways when a collection
window is missed.

**API-Football is a permanent record.** Fixtures, results, statistics, lineups, events,
standings and head-to-head history can be re-fetched at any later date and return the
same values. A missed day costs API calls, not information. The 2026-08-19 backfill
proved this: 212 fixtures frozen in a stale state since 2026-07-04 were repaired by
re-asking the API, and 130 resolved to their true current status.

**Bookmaker odds are view-once.** BetPawa and Betika publish only what is currently
bettable. Once a market closes, the price that stood at that moment is gone from every
public source. There is no historical odds endpoint, no archive, no paid tier that
returns it. If our scraper is not running while a market is open, that price is lost
permanently, for everyone, not just for us.

Everything below follows from that single fact.

## 2. Damage from the 2026-08-16 outage (unsalvageable)

The results-settle statement threw `ER_DATA_OUT_OF_RANGE` on a fixture published as
`FT 0-0` with `HT 1-0` (unsigned column arithmetic). That statement is step one of every
light pass, so every subsequent step, including all odds scraping, never executed. The
failure was silent: HTTP stayed up, the site served stale rows, and nothing alerted.

Bookmaker rows captured per day, measured 2026-08-19:

| Date | Bookmaker rows | Normal range | Status |
|---|---|---|---|
| 2026-08-14 | 1,962 | 1,000 to 3,000 | healthy |
| 2026-08-15 | 3,152 | 1,000 to 3,000 | healthy (last full day) |
| 2026-08-16 | 1,049 | 1,000 to 3,000 | partial, outage began 01:20 |
| 2026-08-17 | 203 | 1,000 to 3,000 | **severe loss** |
| 2026-08-18 | 57 | 1,000 to 3,000 | **near-total loss** |
| 2026-08-19 | 1,068 and climbing | 1,000 to 3,000 | recovered |

Roughly two days of odds coverage, on the order of 3,000 to 5,000 bookmaker match records
with their full market sets, do not exist and cannot be reconstructed. Fixtures, results
and statistics for those same days were recovered in full from API-Football, so the
canonical record is intact; only the price history is gone.

Secondary, also unrecoverable:
- **AI verdicts for fixtures that kicked off during the window.** A grounded model call on
  a played fixture reads the final score off the web, so a backfilled verdict would be
  hindsight disguised as foresight. Collection is wall-clock-bound and forward-only.
- **Daily MultiBet cards for 2026-08-15 to 2026-08-18.** The engine had no fresh odds to
  build from. The timeline shows the gap rather than inventing entries.
- **Pre-match snapshots** for fixtures that kicked off during the window. They can be
  reconstructed for research (leak-free, from fixtures that finished before each target
  kickoff) but must be labelled as reconstructions, never presented as frozen snapshots.

## 3. What now protects the pipeline

Shipped in v1.4.0 build 2 and the hotfixes around it (2026-08-19):

1. **The settle statement cannot abort a pass again.** Inconsistent half-time and
   full-time pairs store NULL for the second half instead of raising. The failure that
   caused this outage is structurally impossible now.
2. **Single-writer lease.** Only the instance holding `GET_LOCK('oddspro:writer')` runs
   the scheduler, so the three concurrent Passenger instances can no longer collide on
   the same odds rows, which was a standing deadlock risk to the collector.
3. **Keep-alive cron.** Passenger idles the app out on a quiet site, and the in-process
   scheduler slept with it: verified, no passes between 12:57 and 14:41 UTC on 2026-08-19.
   A five-minute cron now keeps the process resident so collection does not depend on
   visitor traffic.
4. **Retry and backoff already in place:** transient API 403/429/5xx use bounded
   exponential backoff, InnoDB deadlocks self-heal via `withRetry`, and the per-minute
   rate limit is paced rather than fatal.
5. **Boot-time log trimming** so an error storm cannot fill the disk and take the app
   down as a second-order failure.

## 4. Gaps that remain, and the fix each needs

These are recommendations, not yet built. Ordered by how much irreplaceable data each
protects.

**4.1 Odds-collection heartbeat with an outbound alert (highest value).**
Nothing currently tells anyone that collection stopped. The outage ran three days because
the site kept serving. The warehouse already records everything needed: if
`MAX(matches.updated_at)` is older than a threshold during a period when fixtures are
scheduled, collection is broken. An SMS or email to the owner (the Bonga seam already
exists) on that condition would have cut a three-day loss to under an hour. Cheap, and it
addresses the actual failure mode: silent, not loud.

**4.2 Step isolation in the light pass.**
Today the pass is sequential and an early failure skips everything after it. Odds
collection is the only step whose input expires, so it should run FIRST, and every step
should be independently guarded so one failure cannot cascade. A failed settle should
never cost an odds window.

**4.3 Write-ahead capture.**
Scraped payloads are currently parsed and persisted in one transaction, so a DB failure
during a window loses the fetch. Writing the raw provider response to disk before parsing
would make the capture survivable and replayable, since re-parsing is free while
re-fetching is impossible.

**4.4 Kickoff-anchored scheduling (workstream D).**
The fixed cadence both wastes calls on quiet slates and under-samples near kickoff, when
prices move most. Anchoring to kickoff captures the valuable moments and is the same
change that makes the snapshot history worth selling.

**4.5 Off-host backup of the odds tables.**
The verified dumps now live on the dev box, which is one machine. For view-once data,
one copy is thin.

## 5. Why this is a business, not just an ops concern

The same property that makes an outage expensive makes the archive valuable: nobody can
reconstruct it after the fact, including a competitor with more money. An odds archive is
a strictly append-only asset whose value compounds with time, and whose gaps are
permanent scars. That is an unusually strong moat for a dataset.

What we hold that is hard to reproduce:
- Real closing and pre-kickoff prices from two Kenyan bookmakers, timestamped.
- Those prices **harmonized to a canonical market vocabulary** across providers, which is
  the genuinely hard part: BetPawa and Betika name the same market differently, and one
  reuses type ids across markets.
- Each bookmaker match **correlated to a canonical API-Football fixture** via fuzzy
  matching with learned aliases, so the odds join to results, statistics and lineups.

Buyers for that: quantitative bettors and syndicates testing strategies on real
obtainable prices rather than idealized ones, researchers studying market efficiency and
favourite-longshot bias in African markets, and media or affiliate sites wanting price
comparison. The distinguishing claim is honest and narrow: these are prices that were
actually available to a retail customer in Kenya at a stated time, not a theoretical
consensus line.

**Scoped for later, deliberately not now** (workstream E, and its own spec before any
code): a metered REST API over the correlated archive, priced per call or per seat, with
the adapter framework (workstream F) making new bookmakers cheap to add so coverage can
widen to other markets and eventually other regions. The prerequisite is boring and comes
first: the collection has to be provably reliable, because an archive with silent holes
in it cannot be sold twice.

## 6. Standing rule this establishes

Treat bookmaker odds as the only irreplaceable data in the system. When choosing between
protecting a collection window and any other concern, protect the window. Anything sourced
from API-Football can wait, because it will still be there tomorrow.
