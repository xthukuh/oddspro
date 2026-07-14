# Beat-the-Book Roadmap (independent-edge research program)

> **STATUS: PARKED at C0 — NO-GO (2026-07-14).** The premise check found no
> market-independent signal with exploitable discrimination in any bettable
> segment on current data — and this held under selection-bias correction,
> out-of-sample recalibration, AND recency-aware (timeliness) stats. **No C1+
> work should start, and no API quota should be spent, until C0 flips** per the
> gate below. Evidence: `docs/fair-comparison-and-false-positives.md`.

*This is a tracked research program, deliberately gated so we never pour quota or
build effort into a dead premise. It is a **research bet that can fail** — and on
current data it has. Cross-linked from `implementation-plan.md`.*

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

From `docs/fair-comparison-and-false-positives.md` (22,213 fixture×market rows,
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

## 7. Cross-links
- Premise evidence: `docs/fair-comparison-and-false-positives.md`
- Provenance & honest claims: `docs/data-independence.md`
- Correctness baseline: `docs/data-integrity-and-signal-audit.md`
- Prior prediction study (with corrected "+EV" framing): `docs/sure-win-analysis.md`
