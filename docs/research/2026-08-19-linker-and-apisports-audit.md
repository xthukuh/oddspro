# Correlator + API-Football client audit (2026-08-19)

The two surfaces the 2026-08-18 session never reached (both audit agents died on
API errors that session). One agent per file with a precise brief, findings cited
at `file:line`, PROVEN separated from SUSPECTED, then every PROVEN finding
re-verified by hand against the warehouse before any code changed.

Ranking rule carried over from the odds-durability work: **silent corruption
first, irreplaceable odds second, re-fetchable API data third.**

---

## Fixed this session

### F1 - Reschedule orphans back-date scores  (CRITICAL, PROVEN, FIXED)

One canonical fixture could be claimed by several matches of the SAME provider.
API-Football reschedules a fixture; the bookmaker relists the game under a new
`provider_match_id` at the new time; the old listing keeps its `fixture_id`
because nothing ever checked whether the fixture was already claimed. The settle
pass joins on `m.fixture_id = f.id`, so it wrote the eventual score onto EVERY
claimant, and the stale one rendered under its ORIGINAL date.

Verified by hand: fixture `1493561` was played 2026-08-06 and its 1-0 was shown
on 2026-07-05, a month before kickoff. **103 duplicate `(provider, fixture_id)`
pairs locally and 103 on the live host; 93 local / 97 live carried a score from
the wrong fixture.** Drifts ran 3 to 32 days.

Fix: `src/db/link-rules.js` `claimVerdict` (pure, 9 offline tests) - the listing
whose `start_time` is nearest the canonical kickoff holds the link; a tie keeps
the incumbent (no churn); an unparseable clock never evicts, because unlinking on
a guess would destroy a good link. `src/link.js` contests the claim before
writing and clears the scores the loser inherited. `completed_at` is left alone:
it is a one-way door, and reopening a dead `provider_match_id` would only buy
pointless odds requests. `scripts/repair-duplicate-claims.js` repairs an
already-corrupted warehouse using that same pure rule (dry-run default,
idempotent). **Applied to local AND production 2026-08-19; both re-run clean.**

### F8 - One row's DB error aborted the whole pass  (PROVEN, FIXED)

The row loop had no isolation and none of its three writes is deadlock-retried,
so a transient error killed the provider - and because `linkMatches` runs
providers sequentially, betpawa failing meant **betika never ran at all**. Same
cascade class as the 2026-08-16 outage. Now guarded per row and per provider,
with the counts reported in the pass log.

### A1/A2/A3 - API-Football per-item isolation  (PROVEN, FIXED)

`_saveFixtureItems` parsed each item with a bare `FixtureItem.parse` inside the
loop, so one malformed fixture threw before any write and discarded every other
already-fetched item in the call. It is reached from the fixtures fetch,
`refetchFixtureIds`, the history backfill and `settleApisportsResults` - the last
running every ~10 minutes, so one persistently malformed fixture could have
jammed ALL score settlement indefinitely. Parsing moved to a new pure
`src/apisports-fixtures.js` mirroring the events/standings modules. The
statistics and lineups parsers (a bad record for one team discarded the other
team's valid data) and the history/predictions batch bodies (no per-fixture
guard, unlike `fetchApisportsStats`) got the same treatment.

---

## Open - ranked, not yet fixed

### Correlator (`src/link.js`)

**F2 - Home/away orientation is never re-validated (HIGH, PROVEN, 13 rows).**
`home_team_id`/`away_team_id` are in the fixtures merge list, so orientation can
flip upstream after linking; nothing re-checks. Worse, betika's `alt` scoring arm
compares against the already-linked betpawa row rather than against the fixture,
so once betpawa is reversed betika scores 1.0 and the error is laundered into a
maximally confident link. Evidence: `FC Annecy v FC Sion` linked to fixture
`FC Sion v Annecy` (straight 0.00 / flipped 1.00). The settle pass then writes
the score backwards onto that row.
*Fix:* reject when `flip - straight > 0.30`; make `alt` a bonus that can never
reach 1.0 on its own; re-validate linked-but-uncompleted rows each pass.

**F4 - Subset containment scores 0.9, collapsing reserve/women/youth sides onto
the senior side (HIGH, PROVEN mechanism; 2,246 subset links, 1 confirmed
cross-team error).** `_tokenSim` returns `max(dice, 0.9 * overlap)`, so any
strict token subset (`Arsenal Women` in `Arsenal`, `Bayern Munich II` in `Bayern
Munich`) scores exactly 0.9 on both sides = a 0.9 average, clearing the 0.85
floor with no competition evidence at all. The runner-up margin only protects
when the correct fixture is also in the candidate pool - and when API-Football
does not carry that women's/youth league for the date, the senior fixture wins
uncontested. Confirmed error: betika `North Lakes United v Caboolture FC`
(Queensland Premier League 1 **Women**) linked to fixture `Broadbeach United v
Caboolture`.
*Fix:* extract age/gender/reserve markers in `normalizeName` into a qualifier tag
instead of an ordinary token, and treat a qualifier mismatch as a hard veto - the
one place a veto is justified, because the difference is categorical, not fuzzy.
Add a per-side floor (`min(simH, simA) >= 0.6`); the 50/50 average currently lets
one side be badly wrong.

**F3 - Alias fast-path bypasses the confidence gate, is irreversible, and poisons
within the same pass (HIGH, PROVEN structurally).** An exact alias hit links with
NO score computed and NO threshold applied. Aliases are written for every
accepted link, including one accepted at exactly the floor, and are mutated into
the in-memory map immediately - so a marginal fuzzy link on row 5 short-circuits
the scorer for rows 6..N of the same pass, no rerun needed. `(provider,
alias_name)` is unique with `.onConflict().ignore()`, so the first mapping ever
written wins permanently. There is **no DELETE, UPDATE, override or expiry for
either alias table anywhere in the repo**, and `scripts/lib/sync-rules.js` classes
them `canonical`, so a poisoned alias replicates between local and live. 9,006
team aliases; 314 score below 0.60 against their team (mostly legitimate club
renames, which is exactly why a blind cleanup is unsafe); 76 carry an age/gender
marker the canonical team name lacks.
*Fix:* cache an alias only well above the linking floor (`conf >= min + 0.05` and
runner-up margin >= 0.15); keep the fast-path but still require a sanity score
>= 0.5 so a poisoned alias cannot link a fixture the names visibly contradict;
add a `--forget-alias` path so a bad alias is reversible at all.

**F5 - Virtual competitions are re-scored forever (MEDIUM, PROVEN, quantified).**
Betika's `-Zoom` / `SRL ` virtual competitions have no real-world counterpart, so
API-Football will never cover them. The open set is bounded by the 4h completion
fallback (so the oft-quoted 33k is not the per-pass cost), but creation runs
~560/day, each row stays open 4-5h, and the link pass runs every 10 min - about
**15,000-17,000 wasted candidate queries/day and on the order of 1-1.5M
similarity evaluations/day**, plus continuous near-miss log noise.
*Fix:* a persisted `matches.is_virtual` flag written at scrape time by the
provider parsers (classification belongs where the provider taxonomy is known,
and an indexed column also lets the odds scrapers and read layer skip them),
behind a pure `isVirtualCompetition` predicate anchored on the `-Zoom` suffix and
`SRL ` prefix - never a bare `zoom`/`virtual` substring. Never delete or hide the
rows, only skip them in the linker, and report `virtual_skipped` plus the
distinct names skipped so a false positive surfaces the first time it happens.
Belt: assert in a test that no name in the current `leagues` table matches.

**F6 - `league_aliases` is write-only.** The map is read only to decide whether
to skip a redundant INSERT; it never scores, scopes or short-circuits anything.
README, `docs/engine/03-LINKING.md` and CLAUDE.md all describe it as speeding up
correlation. Either use it (it is exactly the scoping signal F7 lacks) or delete
the write and correct the three docs.

**F7 - Candidate pool is unscoped and queried per row (N+1).** Filtered on
kickoff alone, no league/country/season scoping: up to 84 fixtures per row
measured, with 246 sharing a single kickoff minute at peak. A wide pool is what
let F4's cross-league error happen.
*Fix:* one batched query per pass over the whole start_time range, bucketed by
minute in memory; then prefilter by league when `leagueAliases` resolves (which
is what would make F6's table earn its keep).

**F9 (SUSPECTED)** two-letter initialisms score 0.9 - `_initialismSim` accepts
`[a-z]{2,4}`, and `sm` matches `santa maria`, `san marino` and `sporting
mendoza` alike. Needs a count of links whose winning arm was `_initialismSim`
with `short.length === 2` before changing anything.

**F10 (SUSPECTED, low)** link writes bump `matches.updated_at`, which the web
surfaces as "odds refresh time" in the row tooltip. The collection watchdog is
already immune (it reads `meta.last_odds_at`).

**Related, found while repairing F1:** 92 links remain where a SINGLE match sits
more than 60 min from its fixture's kickoff. These are reschedules the bookmaker
never relisted, so the link itself is right, but the row still displays under a
stale bookmaker `start_time`. Lower severity than F1 (no wrong score, just the
wrong date). Candidate fix: refresh `matches.start_time` from `f.kickoff` once
linked - consistent with the standing "canonical cutoffs" rule that
bookmaker-provided times go stale after a reschedule.

### API-Football client (`src/apisports.js`)

**A4 - `buildEventRows` still lacks true per-item isolation (PROVEN).** The
2026-07 fix made `type` nullable, tolerating the one observed shape, but did not
add the per-item try/catch `buildStandingRows` later got. Any other malformation
(e.g. a missing `time.elapsed`) still discards every event for that fixture.

**A5 - Five write paths lack the deadlock retry `_saveFixtureItems` has
(PROVEN).** Stats, lineups, events, predictions and standings all call
`db.transaction(...)` bare. A transient `ER_LOCK_DEADLOCK` there is not retried.

**A6 - `STATS_GIVEUP_HOURS` uses process-local `Date` math on a raw `f.kickoff`
column (PROVEN pattern; impact SUSPECTED).** Exactly the class CLAUDE.md
documents as fixed in `enrich.js` via `KICKOFF_SQL_EXPR`, never applied here.
Harmless while the host runs EAT, wrong on any other host. Same latent family as
the `_date()`/`_dtime()` note already in the resume point.

**A7 (SUSPECTED, low)** module-level rate-limit counters are unsynchronised
across `_batch` calls running at parallel 2, allowing a 1-2 request overshoot
past the quota floor. The floor is a safety margin, not a hard ceiling.

**A8 - resolved as a side effect of A1/A3.** Because the bare `.parse()` threw
BEFORE the give-up gate was reached, a persistently malformed API response could
never trigger the 48h give-up and was retried forever, burning quota. Skip-and-
continue now lets the gate see the resulting empty/partial rows.

### Verified clean - do not re-audit

- Every `.onConflict().merge()` in `src/apisports.js` passes an explicit column
  list. The knex bare-merge trap does not appear there.
- The 48h empty-response give-up rule is applied identically on stats, lineups
  and events.
- The daily-quota error is deliberately excluded from `isRateLimitError`, so it
  stays fatal and can never be swallowed as retryable; the per-minute retry loop
  is bounded at 2 retries.
- The link pass is idempotent and safe to interrupt. Exact scoring ties are
  correctly rejected: the `else if (conf > second)` branch sets `second` on a
  tie, so the runner-up margin fails and nothing is linked.
- `RESULTS_MAX_AGE_DAYS` retirement is sound for the normal case (the ~10 min
  by-id refetch catches a reschedule fast). The one real hole: a fixture stuck
  `NS`/`PST` for more than 7 days that is THEN given a new date ages out of the
  pending set first and is never refetched. Worth a one-time warning as a fixture
  crosses out of the window rather than widening it.
- `buildStandingRows` is the reference hardened parser; A4 should be brought up
  to it.
