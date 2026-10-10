# Spec: odds history, target snapshots and the due-queue (2026-10-10)

Owner requirement (2026-10-10, confirmed): "keep an accurate account of odds assignments
chronologically, accurately snapshot targets". Confirmed meaning:

1. Log only the CHANGES of every odds price with the time observed, instead of losing history.
2. Frozen snapshots at targets: opening (first seen), T-24h, T-3h, T-1h, closing (last before
   kickoff).
3. Folded in from the backlog: a due-queue so collection is driven by what is due, not only
   by blanket passes.

## Where we start

`odds_markets` is latest-only. `src/db/store.js` deletes the rows whose identity
(`type_name`, `name`, normalized `handicap`; never `type_id`) is in a new snapshot and
re-inserts them; vanished markets are flagged `is_stale`; an empty snapshot over fresh rows
is ignored as suspect. Every prior price is overwritten. Measured scale (toolset KB,
2026-09-10): 17.4 M live rows, `max_id` 203 M, about 177 rows per match, about 1,400 matches
per day, so about 2.9 M market rows are (re)written per day, of which about 2.65 M are
re-observations of a market already on file.

## Design

### Three new tables (one migration, `20261010000003_odds_history.js`)

All utf8mb4, snake_case plural, `created_at`/`updated_at`, FKs `ON DELETE CASCADE` to
`matches` (the history of a match is meaningless without the match). `odds_markets` and
`matches` are NOT altered: an ALTER on the 17 M row table is exactly the long statement the
live host kills.

| Table | One row per | Key columns |
|---|---|---|
| `odds_observations` | logged look at one match (one `saveMatches` transaction) | `match_id`, `observed_at` DATETIME(3), `kind` first/baseline/update, `source`, `kickoff_at`, `markets`, `changes`; index `(match_id, observed_at)` |
| `odds_changes` | price event of one market identity | `match_id`, `type_name`, `name`, `handicap`, `odds`, `prev_odds`, `event` first_seen/changed/stale/revived/baseline, `observed_at`; index `(match_id, observed_at)` |
| `odds_target_snapshots` | target of one match | `match_id`, `target` opening/t24h/t3h/t1h/closing, `kickoff_at`, `target_at`, `observed_at`, `lag_seconds`, `quality` ok/lagged/missing/baseline, `markets`, `as_of_change_id`; UNIQUE `(match_id, target)` |

Times are EAT wall-clock (the warehouse convention), millisecond precision, written from the
DATABASE clock (one `NOW(3)` probe per save call, cached 5 minutes as an offset) so they
compare honestly with the `TIMESTAMP` columns MySQL stamps itself. Every read projects them
through `DATE_FORMAT` with the `+03:00` offset baked in (the TZ-decode hazard).

### B. The change log

Written inside the SAME transaction as the `odds_markets` update, from the pure
`diffOddsChanges(existing, snapshot, { baseline })` in `src/db/odds-diff.js`. Prices compare
numerically in integer cents (mysql2 returns DECIMAL as `'1.85'`, snapshots carry `1.85`).

| Situation | Event | `odds` | `prev_odds` |
|---|---|---|---|
| identity never on file | `first_seen` | new price | null |
| on file, fresh, same price | nothing | - | - |
| on file, fresh, different price | `changed` | new | old |
| on file, stale, back in the snapshot | `revived` | new | last-seen |
| fresh, missing from the snapshot | `stale` | last-seen | null |
| stale and still missing | nothing | - | - |

Every logged look also writes one `odds_observations` row, including a look that changed
nothing. That row is what makes target lag honest: "unchanged since 09:00, last looked at
11:55" is different from "not looked at since 09:00", and the change log alone cannot tell
them apart.

**Gates (all must hold, else nothing is written for that match):**
`ODDS_HISTORY_ENABLED` on; the match is not completed (already skipped by `saveMatches`); the
snapshot is not suspect (`emptySnapshotIsSuspect` suppresses change and observation rows
too); and the database clock is before the CANONICAL kickoff -
`fixtures.kickoff` when linked, else the snapshot's own `start_time`. Pre-match only, the
same freeze semantics as `fixture_prematch`. An unparseable kickoff fails closed.

**Baseline (self-healing resync).** The log must stay replayable: "the state at time X" is,
per identity, its last event at or before X. If `odds_markets` ever moved without the log
seeing it, comparing against `odds_markets` would silently miss changes. Three ways that can
happen: the match pre-dates the feature, `ODDS_HISTORY_ENABLED` was off for a while, or an
odds write landed after the canonical kickoff and the kickoff later moved back out. All
three are detected the same way: the match already has odds rows and either has no logged
observation, or its newest `odds_markets` timestamp is more than 60 s past its last logged
observation. Such a look is logged as `kind = baseline`: every snapshot market as a
`baseline` event plus a `stale` event for every identity on file but absent. Replay is
exact again from that row on. The opening snapshot of such a match is flagged
`quality = baseline` (we did not see its true opening).

### C. Target snapshots

`opening` = the first logged observation. `t24h`/`t3h`/`t1h` = canonical kickoff minus 24h /
3h / 1h. `closing` = canonical kickoff.

Values are NOT copied. A snapshot row stores the cutoff into the append-only change log
(`as_of_change_id`, the highest change id of that match at or before `observed_at`) plus
`observed_at` = the last logged observation at or before `target_at`. The markets are the
log replayed up to that id. Because change rows are only ever inserted with
`observed_at = now` and never updated or deleted, the replay up to a past cutoff can never
change: the snapshot is frozen by construction, and it costs one small row instead of a
copy of ~177 markets. The read surface materializes the markets.

**Freeze rule.** A target is written once, by `INSERT IGNORE` on `(match_id, target)` (a
duplicate is a no-op, never an update), when:

- opening: at least one logged observation exists;
- the other four: the database clock is past `target_at` plus a 2-minute settle margin (so an
  in-flight observation stamped just before `target_at` has committed).

`lag_seconds = target_at - observed_at`. `quality`: `ok` within `ODDS_TARGET_MAX_LAG_MINUTES`
(15), `lagged` beyond it, `missing` when no observation exists at or before `target_at`
(row written, `observed_at`/`as_of_change_id` null, zero markets - never fabricated from a
later look), `baseline` for an opening captured by a baseline look.

**Reschedules.** `target_at` follows the canonical kickoff at freeze time, so a kickoff that
moves before a target is due simply moves the target (nothing is stored yet). Once frozen a
row is never rewritten; it records the `kickoff_at` it was frozen under, and the read
surface flags `kickoff_moved` when the current canonical kickoff differs. The change log
keeps recording against the new kickoff (the gate always uses the current one), so the raw
history for the new schedule is complete even though its targets stay frozen.

**Who freezes.** `materializeTargets()` in `src/odds-history.js`: after every `saveMatches`
call for the matches it logged, and as a bounded sweep (500 matches) in the light pass for
targets that passed with no later look (most closings).

### D. Due-queue

Pure `planDueQueue(nowMs, matches, { leadMin, cap })` in `src/db/odds-history-rules.js`: for
each upcoming, uncompleted, non-virtual match (linked or not), the four time targets open a
due window `[target_at - lead, target_at)`; the match is due when the clock is inside a
window and it has not been looked at since the window opened. Output is ordered by
`target_at` and capped (`ODDS_DUE_MAX_PER_TICK`, 40). It also returns when the next window
opens, so the tick re-reads the database only when something can become due (or every 5
minutes, to pick up new matches and reschedules).

`src/odds-due.js` fetches just those matches through each bookmaker's existing per-event
detail endpoint (BetPawa `GET /events/{id}`, Betika `GET /match?parent_match_id=`; Betika's
list-only fields come from our own `matches` row), 5 in flight, 15 s per request, then saves
them one at a time through `saveMatches` (`source = due`) and materializes their targets.

**Coexistence with the single job slot.** The due lane is not a `startJob` job: it runs
awaited inside the writer's tick, after the manual-request, full and light checks, so a due
scheduled job always wins the tick and light passes are never starved (a light pass takes
about a minute against a 5-minute lead). It does not bump `warehouse_version`, write the
`job_state` beacon, the run ledger or `last_odds_at`: those signals mean "a collection pass
finished", and a 30-second cadence would also re-warm every cache each time. A manual
refresh started by a click during a due run is never refused; the lane checks the slot
between saves and stops.

**During a full sweep** (2.5-7 h, 06:00 EAT), the slot is held. Skipping would miss every
target in the window, so with `ODDS_DUE_DURING_SWEEP` (default on) the lane also runs while
the sweep is in a step from a fixed allow-list (deep stats, standings, team history,
pre-match snapshots, API predictions, hot picks, daily multibet, AI enrichment). Those steps
write only `fixture_*`/`fixtures`/`standings`/`fixture_predictions` and read odds, so they
share no rows or gap ranges with the lane's `matches`/`odds_markets`/history writes; an
unknown step label fails closed (lane waits). This is the one place two writers coexist in
one process; the knob turns it off, and the cost of off is stated: targets in the sweep
window freeze `lagged` or `missing`.

**Knobs (Admin -> Settings, group refresh, all live):**

| Key | Default | Meaning |
|---|---|---|
| `ODDS_HISTORY_ENABLED` | on | change log + observations + target snapshots |
| `ODDS_TARGET_MAX_LAG_MINUTES` | 15 | a target observed further back than this is `lagged` |
| `ODDS_DUE_ENABLED` | on | the due-queue lane (needs history on) |
| `ODDS_DUE_LEAD_MINUTES` | 5 | how far before a target the due fetch fires |
| `ODDS_DUE_MAX_PER_TICK` | 40 | matches fetched per due run |
| `ODDS_DUE_DURING_SWEEP` | on | let the lane run during the sweep's allow-listed steps |

### E. Read surface

`GET /api/odds-history/:matchId` - the match, its canonical kickoff, the observation summary,
the change timeline (newest `limit` rows, default 2000, max 20000, `truncated` flag) and the
five targets with their replayed markets. Gated by a new registry feature `odds_history`
(`minTier: 'user'`): signed-in users, PATs, machine bearers and `AUTH_ENABLED=0`. Guests get
401; `GUEST_PREMIUM` cannot open it (only `guest`-tier features are guest-openable).

## Invariants

- `odds_changes`, `odds_observations` and frozen `odds_target_snapshots` rows are never
  updated or deleted by the app (cascade with their match only). Pruning `odds_changes` would
  destroy the snapshot values; there is deliberately no retention knob.
- Nothing is logged at or after the canonical kickoff, or for a completed match.
- A target row is written once; `INSERT IGNORE` is the only write.
- The log is self-consistent by the baseline rule; replay of a cutoff is deterministic.

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| History insert throws | whole match transaction rolls back and retries (`withRetry`) | same as today's odds write; never half-written |
| Clock probe fails | offset 0 (app clock) | baseline tolerance 60 s absorbs normal skew |
| Materializer throws | targets frozen later by the next call or the sweep | best-effort, logged, never fails a save |
| Detail fetch fails / event removed | match skipped, counted | next window or blanket pass |
| Due lane overlaps a manual click | lane stops before its next save | at most one in-flight single-match write overlaps the manual job's first API step |
| Knob off for a while | no log rows in the gap | next look is a baseline, replay exact again |
| Duplicate identity inside one bookmaker snapshot | first occurrence wins for the diff | odds_markets behavior unchanged |
| Due run during a full sweep | could contend with an unexpected writer | allow-list fails closed, `withRetry` covers deadlocks, knob turns it off |

## Storage estimate (code-level reasoning, to be replaced by measurement)

Row sizes (InnoDB, ~18 B row overhead, ~25% page slack, one secondary index):
`odds_changes` ~160 B, `odds_observations` ~70 B, `odds_target_snapshots` ~90 B.

| Table | Rows per day | MB per day | GB per year |
|---|---|---|---|
| odds_changes, first sightings | 1,400 x 177 = 248k | 40 | 14 |
| odds_changes, price moves (f = share of re-observed prices that moved) | f x 2.65 M: 133k (5%), 265k (10%), 530k (20%) | 21 / 42 / 85 | 8 / 15 / 31 |
| odds_observations | ~20k | 1.4 | 0.5 |
| odds_target_snapshots | 7k | 0.6 | 0.2 |
| **Total** | 410k - 810k | 63 - 127 | **23 - 46** |

One-off: the first sweep after deploy baselines every upcoming match (~7k x 177 = 1.2 M rows,
~200 MB). For scale, the whole warehouse is about 5 GB today. The true `f` is measurable
after two days without any new tooling:
`SELECT SUM(changes)/SUM(markets) FROM odds_observations WHERE kind='update'`.
This is the main owner decision (see the plan).
