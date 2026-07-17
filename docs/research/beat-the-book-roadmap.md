# Beat-the-Book Roadmap (independent-edge research program)

> **STATUS: PARKED at C0 — NO-GO (2026-07-14).** The premise check found no
> market-independent signal with exploitable discrimination in any bettable
> segment on current data — and this held under selection-bias correction,
> out-of-sample recalibration, AND recency-aware (timeliness) stats. **No C1+
> work should start, and no API quota should be spent, until C0 flips** per the
> gate below. Evidence: `docs/research/fair-comparison-and-false-positives.md`.

*This is a tracked research program, deliberately gated so we never pour quota or
build effort into a dead premise. It is a **research bet that can fail** — and on
current data it has. Cross-linked from `docs/dev/implementation-plan.md`.*

---

## 1. What "beat the book" means, and the honest ceiling

Goal: **a bet selection whose out-of-sample hit-rate clears break-even on real
odds** — i.e. an independent (or market-augmenting) signal that finds value the
bookmaker has mispriced. This is NOT the same as our shipped `sure` sort, which
maximizes *win probability / slip survival*, not profit.

The honest ceiling is the **vig**. Every liquid market on our books is currently
negative flat-stake EV (X2 −12.8%, 12 −8.0%, O 2.5 −5.5%, 1X −4.1%, U 4.5 −3.0%
on the fair board). Beating the book requires an edge the odds have *not* already
absorbed — and so far, everywhere the independent signal is real, the book has
priced it (and priced it below the 1.20 bettable floor).

**Kill-gate philosophy:** each phase has a go/no-go gate. A phase only runs if the
prior gate passed. C0 is currently NO-GO, so the program is parked.

## 2. C0 evidence (why we're parked)

From `docs/research/fair-comparison-and-false-positives.md` (22,213 fixture×market rows,
1,445 settled FT fixtures, 13 EAT days, selection-bias removed):

- The **market out-discriminates the independent stats signal in every market
  group** (AUC + leave-one-day-out recalibrated Brier, day-clustered CIs exclude
  zero). It stays ahead after recalibration → genuine discrimination loss, not
  fixable over-confidence.
- **0 of 14** bettable group×price segments show stats reaching parity with the
  market.
- The real independent signal (79–88% stats-gate precision, holds OOS across 232
  leagues) is **fully priced** — concentrated below the 1.20 floor, −EV where
  bettable.
- **Timeliness is not the missing ingredient.** Recency-capped and
  recency-weighted stats (45/90-day caps, 30/45-day decay) did **not** close the
  AUC gap; weighting *hurt* stats, and the 45-day cap cost 36% of fixtures for
  zero gain (§5b).
- **No liquid market is positive-EV.** The earlier "X2 +EV" was a selection
  artifact (now −12.8% fair-board EV, regressed to unresolved).

**Conclusion:** the dependence on bookmaker odds is *correct*, not a flaw. The
market has absorbed the independent signal wherever it is bettable.

## 3. Phased plan & gates

| Phase | What | Gate to proceed | Status |
|---|---|---|---|
| **C0** | Premise check — is there market-underweighted independent discrimination in a bettable segment? | A segment where an independent signal ≥ market with a day-clustered CI excluding zero, above the 1.20 floor. | **NO-GO** (2026-07-14) |
| **C1** | Feature-coverage backfill — canonical facts only (standings →>90%, H2H/last-N, deep match-stats `fixture_statistics` across a prioritized league/season set). Fetch-once, immutable, additive. | C0 passes **OR** a scoped spike shows a specific new feature is plausibly mispriced. **Explicit go-ahead + quota estimate required.** | Blocked by C0 |
| **C2** | Pre-match deep-stat aggregate pipeline — new leak-free per-team rolling aggregates (shots, xG created/conceded, possession…), frozen at kickoff like `fixture_prematch`. Pure rules + writer + tests. | C1 delivers ≥ the coverage C2 needs. | Blocked |
| **C3** | Independent / market-residual model + OOS backtest (leak-free, day-clustered CIs). | **OOS Wilson lower bound > break-even on bettable prices, ≥30 independent match-days.** | Blocked |
| **C4** | Ship or kill — integrate as an honestly-labeled new signal, or document the negative result and stop. | C3 gate cleared AND holds live-forward. | Blocked |

## 4. The only remaining hypothesis that could flip C0

Two things have already been ruled out as the missing ingredient — **re-weighting
the existing stats** (blend never beat market-only; not established) and
**timeliness** (recency variants tested null/negative). What has **not** been
tested at scale, because the data doesn't exist yet:

- **Pre-match per-team rolling *deep*-stat aggregates** — shots, xG
  created/conceded, possession, etc., as *pre-match* inputs. Today deep stats
  cover ~130 fixtures total and are *post-match realized values*, so they are
  unusable as predictors without both (a) far wider `fixture_statistics` coverage
  (C1) and (b) an as-of-before-kickoff aggregate pipeline (C2).
- **Standings rank/form to >90% coverage** (currently ~60% of tip fixtures).

The bar to declare success (C3 gate): such a feature must show **market-beating
discrimination in a bettable segment, out-of-sample, over ≥30 independent
match-days, with a CI excluding zero** — 13 days is not enough to move on. Until
then, C0 stays NO-GO.

## 5. C1 cost flag (do not spend without go-ahead)

C1's deep-stats backfill is the expensive part: `fixture_statistics` costs ≥1
API-Football request per fixture (fetch-once, immutable). Covering the tipped
leagues over 1–2 seasons is plausibly **thousands to tens of thousands of
requests** (≈ hours to ~1 day of the 150k/day plan). Before any C1 run I will
produce a precise per-league/season request estimate and get explicit approval —
per the standing rule that live-host/quota actions are confirmed first.

## 6. Decision log

| Date | Decision | Basis |
|---|---|---|
| 2026-07-14 | Program opened; C0 run | User reopened beat-the-book; included in plans |
| 2026-07-14 | **C0 = NO-GO**; C1+ parked | Fair comparison + recency re-test — no bettable independent edge |
| 2026-07-14 | Deep-stat spike scoped → **DON'T FUND yet** | Backfill cheap (~2.3k req, 1.6% quota) but bettable evaluable sample caps at ~11 match-days (< 30-day C3 bar); xG absent from high-volume tippable leagues. See "Spike scoping". |

## Spike scoping (2026-07-14)

*Read-only warehouse scoping of the C1/C2 "deep-stat spike" — the only remaining
hypothesis that could flip C0 (pre-match per-team rolling **deep**-stat aggregates:
shots / xG created-conceded / possession). No fetches, no writes; every figure
from the live DB via `tmp/audit-07-spike-scoping.mjs` (+ `audit-07-probe.mjs`).*
**Verdict: DON'T FUND yet — the blocker is calendar depth, not backfill cost.**

### 4a. Feasibility flag — which deep stats does the API actually return?
`fixture_statistics` stores **19 distinct types** across just **130 FT fixtures**
(0.5% of 25,952). Crucially, **xG IS present** as `expected_goals` — but on only
**65 fixtures**, and `Ball Possession` (128), `Total Shots` (130) are the widest.
So the spike's premise feature (xG) *exists on this plan* — the blocker is
coverage, not availability of the field.

**But xG is concentrated in leagues we barely tip.** The 65 xG fixtures live in:
World Cup (18), Sweden Allsvenskan (15), Brazil Serie B (10), Norway Eliteserien
(8), UEFA Europa League (6), Ecuador Liga Pro (4)… The **high-volume correlated
leagues return NO xG**: USL League Two (16 stat fixtures, **0 xG**), and all the
Argentine/Brazilian lower divisions + Friendlies have 0 stats/0 xG. So a backfill
of our actual tippable board may return **shots-only, not xG** — this must be
confirmed by a **cheap 1-2 sample `/fixtures/statistics` call on historical
fixtures from the *target tippable leagues*** BEFORE any spike (do NOT spend now).

### 1. Candidate leagues (correlated, i.e. carry linked odds)
121 correlated leagues, **1,472 correlated FT fixtures total, all inside a 13-day
window**. Top by FT volume (`statCov` = existing deep-stat %, `xG` = fixtures with
expected_goals, `stdCov` = both-teams standings-rank %, `days` = distinct match-days):

| League | FT | statCov | xG | stdCov | days | span |
|---|---|---|---|---|---|---|
| World - Friendlies Clubs | 294 | 0% | 0 | 0% | 11 | Jul 02–13 |
| USA - USL League Two | 88 | 18% | **0** | 0% | 11 | Jul 03–13 |
| Brazil - Paulista U20 | 42 | 0% | 0 | 95% | 8 | Jul 03–13 |
| Argentina - Primera Nacional | 35 | 0% | 0 | 100% | 6 | Jul 04–14 |
| Argentina - Torneo Federal A | 26 | 23% | 0 | 100% | 5 | Jul 04–14 |
| Sweden - Allsvenskan | 16 | 100% | **15** | 100% | 7 | Jul 03–13 |
| Brazil - Serie B | 17 | 88% | **10** | 100% | 11 | Jul 03–14 |
| Ecuador - Liga Pro | 16 | 56% | 4 | 100% | 8 | Jul 04–13 |

**Quality problem:** the volume leaders are **context-excluded** (Friendlies, U20 —
`TIP_CONTEXT_EXCLUDE`) or **xG-barren** (USL League Two). The xG-proven, tippable
leagues (Sweden, Brazil Serie B, Norway, Ecuador) each carry only ~16 correlated FT
over ≤11 days. Every correlated league spans **1 season / ≤11 match-days** — the
warehouse has been collecting odds for 13 days.

### 2. Backfill cost (top-3-by-volume candidate set; ≥1 `/fixtures/statistics` req/fixture)
| Span | FT fixtures in pool | already have stats | **requests needed** | % of 150k/day |
|---|---|---|---|---|
| most recent season | 2,355 | 16 | **2,339** (1,955 unflagged) | **1.56%** |
| most recent 2 seasons | 2,672 | 16 | **2,656** (2,272 unflagged) | **1.77%** |

The pool includes each team's history-backfill prior games (needed for the rolling
window). **Cost is trivial** — ~2.3k requests ≈ 0.016 days of the 150k/day quota,
far above the `APISPORTS_MIN_REMAINING=5` floor. Cost is NOT the constraint.

### 3. Evaluable sample (post-backfill, the actual constraint)
Assume every candidate FT fixture gets deep stats. A **bettable** test fixture must
be *correlated* (carry odds, to grade vs the market) AND have **both teams with ≥5
prior candidate-set stat-games**:

| Span | correlated test fixtures | evaluable (bettable) | **evaluable match-days** |
|---|---|---|---|
| most recent season | 424 | 95 | **11** |
| most recent 2 seasons | 424 | 126 | **11** |

Current pre-backfill bettable evaluable sample: **0** (only 130 stat fixtures exist,
none with 5 prior stat-games for both teams). Post-backfill it rises to ~95–126
fixtures — **but over only 11 distinct match-days.** The odds exist only in the
13-day window, so **bettable match-days are hard-capped at ~13 no matter how much
we backfill.** The C3 gate needs **≥30 independent match-days**; 11 is far short,
and no fetch closes that gap — only calendar time does.

### 5. Recommendation — DON'T FUND (yet)
- **Not a cost problem:** the backfill is ~2.3k requests (1.6% of one day's quota).
- **It's a depth problem:** the bettable, market-gradable backtest tops out at
  ~11 match-days (< the 30-day C3 bar), capped by the 13-day odds window — backfill
  cannot manufacture more bettable days.
- **It may not even be an xG problem we can solve:** xG is available but absent from
  our high-volume tippable leagues; a backfill could return shots-only there.
- **Concrete proposal:** (a) keep running the pipeline to **accrue ≥30 EAT odds-days**
  (free, ~3 more weeks) — this is the true prerequisite; (b) run a **1-2 call
  xG-availability probe** on historical fixtures of the *tippable, non-friendly*
  leagues we actually bet (e.g. Sweden Allsvenskan, Brazil Serie B, plus a couple of
  the Argentine/Brazilian divisions that dominate our board) to confirm the API
  returns `expected_goals` for them; (c) **only if both pass**, fund the cheap
  statistics backfill for the xG-confirmed tippable leagues and run C2/C3. **Until
  the warehouse has ≥30 odds-days, the spike cannot clear its own gate — do not fund
  it now.**

(`audit-07-spike-scoping.mjs` → `tmp/audit-06/spike-scoping.json`; `audit-07-probe.mjs`)

---

## 7. Cross-links
- Premise evidence: `docs/research/fair-comparison-and-false-positives.md`
- Provenance & honest claims: `docs/research/data-independence.md`
- Correctness baseline: `docs/research/data-integrity-and-signal-audit.md`
- Prior prediction study (with corrected "+EV" framing): `docs/research/sure-win-analysis.md`
