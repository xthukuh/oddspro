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

### F2 - Home/away orientation is never re-validated  (HIGH, PROVEN, FIXED - CORRECTED mechanism)

The audit's original diagnosis was wrong about what these 13 rows are. They are
**not bad links.** On every one, both bookmakers agree with each other and
disagree with the fixture, and the cached `team_aliases` are correct and would
not have matched the reversed pairing - the link was made correctly. What
actually happened: `home_team_id`/`away_team_id` are in the fixtures upsert
merge list, and API-Football SWAPPED the fixture's sides SOME TIME AFTER the
link was written, with nothing re-checking afterwards. Neutral-venue ties and
friendlies are where it happens.

The damage is real and user-visible, because the read layer pairs the
BOOKMAKER's team names with the CANONICAL score: fixture `1548857` rendered as
"FC Annecy - FC Sion 4-0" for a game Sion won 4-0 (straight-pairing similarity
0.00, flipped 1.00). Nothing downstream is affected - tips settle from the
fixture directly, and the goals-sum sort is symmetric - so this was purely a
display lie.

Because it is a display problem, the fix stays out of the write path entirely.
`matches.sides_swapped` (migration `20260820000001_matches_sides_swapped`)
records the reversal; `src/db/records.js` swaps the score it renders so names
and score always tell the same story. The settle SQL - the most failure-prone
statement in the codebase, and the cause of the 2026-08-16 outage - is
untouched, and the stored score columns stay in the canonical fixture's
orientation.

`revalidateOrientation()` (`src/link.js`) maintains the flag on every link pass
over a bounded 30-day window (the shared host punishes unbounded scans, and
sides flip around kickoff, not years later), guarded so it can never fail a pass
that correlated matches successfully. Pure `orientationVerdict`/
`orientationUpdate` (`src/db/link-rules.js`) decide: `'unknown'` when the two
pairings are too close to call, and then the stored flag is LEFT ALONE rather
than guessed, because short abbreviated names ("Nottingham v Guimaraes")
legitimately score low both ways. `orientationUpdate` also returns `null` for
rows that did not move, so a pass over every recent link does not rewrite them
all and bump the `updated_at` the web shows as the odds refresh time.

`scripts/repair-orientation.js` runs the same pass unbounded for links
predating the flag. **Applied to local AND production 2026-08-19/20: 18,024
links checked, exactly 13 flagged (the same 13 rows the audit found), zero
false positives, second run clean on both.**

### F4 - Subset containment scores 0.9  (MEASURED AND REFUTED, NOT a bug - do not rebuild)

This is the important correction: **F4 is not fixed, it is refuted.** The
proposed veto was implemented and measured against all 18,022 live links before
being wired in, and it cannot ship - keeping this write-up so nobody rebuilds
it.

The mechanism the audit described is real: `_tokenSim` returns
`max(dice, 0.9 * overlap)`, so any strict token subset ("Arsenal Women" in
"Arsenal", "Bayern Munich II" in "Bayern Munich") scores exactly 0.9, clearing
the 0.85 floor with no competition evidence at all. But a hard veto on that
signal rejects far more than it catches:

```
exact-tag veto on team names ............. rejects 958 links (5.3%)
women-only, team OR competition evidence . rejects 57
additionally on development/senior ....... rejects a further 994
```

Nearly all of those are CORRECT links, because the two sources put the
qualifier in different FIELDS and tag it inconsistently:

- the bookmaker puts it in the competition ("Liga Femenina", "U20 NSW NPL") and
  leaves the team name bare, while API-Football puts it in the team name
  ("Manly Utd U20", "Washington Spirit W");
- API-Football is not even self-consistent: it tags one side of the fixture
  "VIFK W v IF Gnistan" and not the other;
- whole women's leagues carry no marker at all (Damallsvenskan, WK-League);
- a bare "w" token is not a marker - "Springvale W. E." is White Eagles and
  "Havant & W" is Waterlooville;
- a bare "2" token is not a reserve marker - it rejected an exact 1.00 name
  match because the league is called "China League 2".

Against that, the target error the veto was meant to catch is **one row in
18,022** (betika "North Lakes United v Caboolture FC", Queensland Premier
League 1 Women, linked to the men's "Broadbeach United v Caboolture"), and it
happened because API-Football did not carry that women's league for the date,
so the men's fixture won the candidate pool uncontested - a candidate-SCOPING
failure (see F7 below), not a name-similarity failure. A name veto is the wrong
instrument for it.

This is the third time the codebase has recorded that a veto underperforms a
bonus here - competition similarity stays a bonus, never a veto, and v1's AI
contradiction vetoes were net-negative for the same reason. Full evidence and
the refutation rationale live next to `aliasWorthCaching` in
`src/db/link-rules.js`.

### F3 - Alias fast-path teaching bar  (HIGH, PROVEN, PARTIALLY FIXED - deliberately)

Alias teaching now needs a strictly higher bar than linking. A confident link
teaches `team_aliases`/`league_aliases`, and that entry then short-circuits the
scorer for every future fixture of those teams - there is no DELETE, no UPDATE,
no override and no expiry anywhere in the repo, and `scripts/lib/sync-rules.js`
classes both tables `canonical`, so a bad entry replicates between local and
live and is permanent. The poisoning vector is a link accepted at the very edge
of the gate: `LINK_MIN_CONFIDENCE` (0.85) plus a 0.05 runner-up margin is enough
to LINK, and that was also enough to teach a permanent rule.

`aliasWorthCaching(conf, runnerUp, threshold)` (`src/db/link-rules.js`) requires
the confidence to clear the linking floor by 0.05 AND the runner-up margin by
0.15; withheld links are counted in the pass log (`alias_withheld`).
`scripts/forget-alias.js` is the missing escape hatch (search, dry-run,
per-provider, `--yes`), and deleting an alias is safe by construction because it
removes only a shortcut - the next pass re-derives the correlation by scoring.

**Deliberately NOT done:** the audit also proposed re-scoring the alias fast
path and rejecting it below ~0.5. That would break the aliases that matter
most - a club rename ("Zhenis Nur Sultan" -> "Zhenys", "Lisen Brno" -> "Artis")
scores near zero by name, which is exactly why the alias exists, and the
audit's own sweep found 314 such entries below 0.60. Reasoning recorded in
`link-rules.js` next to the rule.

### A4/A5/A6 - API-Football write-path + timezone hardening  (PROVEN, FIXED)

- **A4** `buildEventRows` still lacked true per-item isolation: the 2026-07 fix
  made `type` nullable, tolerating the one shape then observed, but any other
  malformation still discarded every event for the fixture. Now the
  `buildStandingRows` treatment: skip, collect, report, never throw.
- **A5** the statistics, lineups, events, predictions and standings writes all
  called `db.transaction` bare, so a transient deadlock against a concurrent
  writer was not retried - only `_saveFixtureItems` was. All five now use the
  same `withRetry` idiom (default `isRetryableDbError`).
- **A6** the `STATS_GIVEUP_HOURS` threshold did `new Date(f.kickoff)` on a raw
  `DATETIME` column, which mysql2 decodes in the NODE process's timezone rather
  than the pinned +03:00 session, skewing the 48h give-up on any non-EAT host.
  Now a `TIMESTAMPDIFF` computed in the session, per `enrich.js`'s
  `KICKOFF_SQL_EXPR` precedent.

### Betika list-page pager - silent truncation the audit itself misdiagnosed  (NEW, PROVEN, FIXED)

Not one of the original 14 findings - found while fixing the BetPawa "no
results is not a malformed page" false alarm (BetPawa signals empty by
OMITTING the inner `responses[0].responses` key rather than returning `[]`;
`listPageOutcome`/`listPageDone`, `src/db/collector-rules.js`, now classify
`ok`/`empty`/`malformed` by envelope shape so a genuine "nothing left to
collect" no longer fires a malformed-page alarm every 15 minutes).

While fixing that, this audit's own "verified clean" note on Betika turned out
to be wrong: it stated Betika's pager "already threw by construction." It does
not. `fetchBetikaGames` read each page as
`Array.isArray(data.data) ? data.data : []`, so any body it could not read
collapsed to an EMPTY page - and because the walk terminates on
`len < limit`, a degraded 200 on page 3 of 10 returned the first two pages as
if they were the complete day. That is the exact silent-truncation class that
cost three days of irreplaceable BetPawa odds on 2026-08-16, sitting unfixed in
the other provider the whole time this audit ran.

Probed the live API: a page past the end answers HTTP 200 with a REAL
`data: []`, so unlike BetPawa there is no empty-vs-omitted ambiguity to resolve
for Betika - an empty array is genuinely usable and simply ends the walk. Pure
`dataPageOutcome` (`src/db/collector-rules.js`) separates that from a body with
no `data` array at all, which now retries with the same bounded backoff the
other two clients have and then throws, so `done` can only be computed from a
page actually read.

---

## Open - ranked, not yet fixed

### Correlator (`src/link.js`)

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
let F4's cross-league error happen - and now that F4's own veto is refuted as
the fix for that error class, **F7 candidate scoping is the leading remaining
candidate** for closing it: a per-league-scoped pool would have kept the
uncontested men's fixture from winning that one row without touching any of the
958-994 legitimately cross-tagged links a name veto would have broken.
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

**Still open, unrelated to F1-F4/F8: 92 links remain where a SINGLE match sits
more than 60 min from its fixture's kickoff.** These are reschedules the
bookmaker never relisted, so the link itself is right, but the row still
displays under a stale bookmaker `start_time`. Lower severity than F1 (no wrong
score, just the wrong date). Candidate fix: refresh `matches.start_time` from
`f.kickoff` once linked - consistent with the standing "canonical cutoffs" rule
that bookmaker-provided times go stale after a reschedule.

### API-Football client (`src/apisports.js`)

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
- `buildStandingRows` is the reference hardened parser; A4 was brought up to it
  this session.
