# Fair Market-vs-Stats Comparison & False-Positive Ledger (2026-07-14)

*The **C0 premise check** for a possible beat-the-book program. Read-only
extension of `docs/research/data-integrity-and-signal-audit.md`. Every number below
traces to the live `oddspro` MySQL warehouse or a project script; the
script/query is cited inline. Audit scripts live in `tmp/audit-06-*.mjs`
(gitignored, read-only). No warehouse table, migration, or production code was
modified.*

---

## Why this pass exists

The prior audit graded **market vs stats only on the 998 blend-TIPPED games**.
But the blend is 60–67% market by construction, so the market was judged on its
own selections and the stats signal never got to choose its own board. That is a
selection bias that can flatter *either* side. This pass removes it: **both
signals are graded on a COMMON, PRE-SELECTION board** — every settled FT fixture
that carries pre-kickoff odds, not just the tipped ones — using the project's own
production signal math, then subjected to discrimination/calibration metrics,
day-clustered significance testing, and a multiple-comparison segment scan.

---

## Executive summary

- **Common board built, leak-free and faithful.** 22,213 (fixture × market)
  grading rows over **1,445 settled FT fixtures across 13 EAT days**
  (2026-07-02 → 07-14) — vs the prior audit's 998 tipped rows. Reconstruction
  reproduces the frozen production values (market_prob matches stored
  `tip_breakdown` at **94.3% within 0.02**, mean abs diff **0.0029**) and the
  warehouse backtest's stats precision band — triple-confirming no leak.
  (`audit-06-board.mjs`)
- **The market wins the fair fight decisively — and it is genuine
  discrimination, not just over-confidence.** On the pre-selection board the
  market out-discriminates stats in **every** market group with day-clustered
  CIs that exclude zero, and — critically — it stays ahead **after out-of-sample
  recalibration**:

  | Group | Market AUC | Stats AUC | AUC diff (mkt−stats) 95% CI | Cal-Brier diff (mkt−stats) 95% CI |
  |---|---|---|---|---|
  | ALL (n=22,213) | **0.808** | 0.774 | [+0.031, +0.039] | [−0.021, −0.017] |
  | 1X2 (n=4,335) | **0.717** | 0.606 | [+0.089, +0.131] | [−0.031, −0.020] |
  | DC (n=4,272) | **0.712** | 0.603 | [+0.088, +0.130] | [−0.029, −0.020] |
  | O/U (n=13,606) | **0.825** | 0.809 | [+0.010, +0.025] | [−0.017, −0.011] |

  Every CI excludes zero in the market's favour. Recalibrating stats leave-one-
  day-out does **not** close the gap (stats cal-Brier stays worse), so "stats is
  worse" is real discrimination loss, not miscalibration. (`audit-06-metrics.mjs`)
- **Segment scan: 0 of 14 bettable segments show stats ≥ market.** Across
  market-group × price-band, **not one** segment has stats AUC ≥ market AUC with
  a CI excluding zero. In every segment the point estimate is stats **below**
  market. There is no price pocket where the independent signal discriminates
  better. (`audit-06-metrics.mjs §segmentScan`)
- **When the two disagree, reality is the MARKET's number — much more starkly
  than the tipped slice showed.** On the fair board, where stats is ≥0.10 more
  bullish than the market (n=4,233), stats says 64.6%, market says 47.0%, and
  realized is **47.1%** — the market's figure. The audit's "70.6%" for this
  bucket was a tipped-selection artifact; the direction of the conclusion
  survives and is *strengthened*. (`audit-06-metrics.mjs §disagreement_fairBoard`)
- **The price-blind precision trap is confirmed with real odds.** The stats-only
  gates that look 80–88% precise (1X, U 4.5, O 1.5) sit at **median price
  ~1.13–1.15 — below the 1.20 bettable floor** — and collapse to ~73–78% on the
  bettable (price ≥ 1.20) subset. Warehouse stats precision **holds out-of-
  sample** (backtest: AU 2.5 88.4%→87.3%, U 4.5 88.3%→85.6%, 232 leagues) but is
  fully priced. (`audit-06-metrics.mjs §statsGatePrecisionAndPrice`,
  `scripts/backtest-sure-tips.js`)
- **No positive-EV market on the fair board.** Every liquid market is negative
  flat-stake EV (the vig). **X2 is −12.8% price-blind** on the full board — its
  tipped-slice "+EV" impression is a selection artifact, and the tipped X2 Wilson
  floor (67.1%) is *below* break-even (70.1%): unresolved, not +EV.
- **Timeliness does not rescue stats.** A recency-aware re-test (stats rebuilt
  from only recent games — 45/90-day caps — and time-decay weighted, τ=30/45d)
  does **not** close the AUC gap: the best variant leaves it ~0.034 and
  recency-weighting *widens* it (stats AUC 0.756–0.760 < the count-based 0.774);
  **0 of 14 bettable segments flip under any variant**, and the strict 45-day cap
  costs 36% of fixtures for no gain. (§5b, `audit-06-recency.mjs`)
- **C0 verdict: NO-GO** (unchanged under recency-aware stats). There is no
  market-independent signal with genuine discrimination the market underweights
  in any bettable price segment on the current data. The independent signal that
  exists is fully priced and negative-EV where bettable.

---

## 1. The common evaluation board (leakage-controlled)

### 1.1 Construction (`tmp/audit-06-board.mjs`)
For every settled FT fixture (`status IN FINAL_STATUSES`, non-null FT score) that
has a linked bookmaker match, both signals are reconstructed **point-in-time with
a strict kickoff cutoff**, reusing the production math verbatim:

- **Stats** — `teamOutcomeAggregates` / `h2hOutcomeAggregates` from
  `src/db/tip-rules.js` over the SAME leak-free history the live writer sees
  (finished fixtures strictly before kickoff, vs-others semantics, **fairness
  pairing** capped at the smaller side), windows = production config
  (`TEAM_WINDOW=7`, `H2H_WINDOW=5`, `MIN_GAMES=5`, `H2H_MIN=3`). `stats_prob` per
  market is assembled exactly as `bestTip()` does (lines 209–224).
- **Market** — vig-removed implied probability via `bestTip`'s `_devig`
  (1X2/DC/O-U groups; DC derived from the 1X2 book when present), using the
  **last pre-kickoff price** (`odds_markets.is_stale=0 AND
  odds_markets.updated_at < fixtures.kickoff`) = the closing-ish line. Closing
  odds are the market's sharpest form, so this **gives the market its best shot**
  (conservative for "can stats beat the market?").
- Each (fixture × market) row is graded hit=1/miss=0 against the final score via
  the production `tipHit`.

Target markets: **1, X, 2, 1X, X2, 12** and **every O/U line that has odds**
(0.5–6.5; 1.5/2.5/3.5 always present). A row enters the board only where **both**
signals are defined.

### 1.2 Leakage control — the #1 risk, handled three ways
1. **Pre-kickoff-only odds.** `odds_markets.updated_at` is the per-row last-seen
   time (the diff layer delete+inserts on every refresh, so the stored row is the
   last snapshot that still listed the market). Empirically **99.92% of fresh
   odds rows are strictly pre-kickoff**; the 0.08% at/after kickoff are excluded.
   (`tmp/audit-06-probe.mjs` — note `matches.updated_at` is useless here: it is
   bumped by the post-match settle pass, so 100% land after kickoff.)
2. **Faithfulness cross-check vs frozen production values.** Reconstructed
   `market_prob` matches the stored `tip_breakdown` at **94.3% within 0.02**
   (mean abs diff **0.0029**); `stats_prob` mean abs diff **0.0141** (the residual
   is benign: the warehouse now holds *more complete* pre-kickoff history after
   later backfills — still strictly before kickoff, so leak-free, if anything
   giving stats a slightly better shot). (`audit-06-board.mjs §leakCheck`)
3. **Precision-band cross-check vs the backtest.** The independent stats-gate
   precision reproduced below (73–88% at `stat≥0.85`) lands in the same band as
   `scripts/backtest-sure-tips.js` (79–88% on DC/Under gates) — an independent
   reconstruction reaching the same numbers confirms the signal definition and
   the absence of leakage.

### 1.3 Board size & composition
| | Value |
|---|---|
| Grading rows | **22,213** |
| Distinct fixtures | **1,445** |
| EAT match-days | **13** (2026-07-02 → 07-14) |
| By group | 1X2 4,335 · DC 4,272 · O/U 13,606 |
| Per-market counts | 1/X/2 = 1,445 each; 1X/X2/12 = 1,424 each; O/U 2.5 = 1,414; other O/U lines 83–1,414 |

---

## 2. Discrimination, calibration & significance

Per signal, per group (`audit-06-metrics.mjs`). AUC is the Mann-Whitney
probability that a random hit outranks a random miss (immune to over/under-
confidence). Brier/log-loss continue the audit. **Cal-Brier** is Brier after
leave-one-DAY-out logistic (Platt) recalibration — the direct test of whether
"stats is worse" is genuine discrimination or mere over-confidence.

### 2.1 Point metrics
| Group | Signal | AUC | Brier | log-loss | Cal-Brier |
|---|---|---|---|---|---|
| ALL | market | **0.8083** | **0.1787** | **0.5342** | **0.1787** |
| ALL | stats | 0.7738 | 0.1951 | 0.6241 | 0.1972 |
| 1X2 | market | **0.7169** | **0.1906** | **0.5640** | **0.1906** |
| 1X2 | stats | 0.6058 | 0.2194 | 0.6488 | 0.2160 |
| DC | market | **0.7124** | **0.1919** | **0.5669** | **0.1919** |
| DC | stats | 0.6025 | 0.2200 | 0.6479 | 0.2162 |
| O/U | market | **0.8254** | **0.1708** | **0.5145** | **0.1707** |
| O/U | stats | 0.8087 | 0.1795 | 0.6087 | 0.1841 |

Readings:
- **Market is the sharper *discriminator* everywhere** (higher AUC), by a large
  margin on result markets (1X2/DC ≈ 0.71–0.72 vs 0.60–0.61) and a small margin
  on O/U (0.825 vs 0.809).
- **Recalibration does not rescue stats.** The market is already well-calibrated
  (Brier unchanged by recalibration). Stats' Brier does *not* improve to the
  market's level under LODO recalibration — on O/U it gets slightly worse
  (0.1795→0.1841). Over-confidence is *not* the whole story; the ordering itself
  is weaker.

### 2.2 Day-clustered bootstrap CIs on the PAIRED differences
Resample the 13 distinct EAT match-days with replacement (2,000 iters), recompute
the paired difference on the pooled rows. **CI excluding zero ⇒ established.**

| Group | AUC (market−stats) 95% CI | Verdict | Cal-Brier (market−stats) 95% CI | Verdict |
|---|---|---|---|---|
| ALL | **[+0.0305, +0.0387]** | market > stats | **[−0.0207, −0.0169]** | market better |
| 1X2 | **[+0.0891, +0.1310]** | market > stats | **[−0.0306, −0.0203]** | market better |
| DC | **[+0.0875, +0.1301]** | market > stats | **[−0.0292, −0.0200]** | market better |
| O/U | **[+0.0103, +0.0249]** | market > stats | **[−0.0166, −0.0111]** | market better |

**Every** paired CI excludes zero in the market's favour, on both discrimination
and calibrated Brier. This is the fair-comparison headline: the market is the
sharper signal *on a board neither signal was allowed to pre-select*.

---

## 3. Segment scan — where (if anywhere) does independent signal live?

Market-group × price-band; for each segment with ≥100 rows over ≥4 days, compute
market AUC, stats AUC, and the day-clustered CI on **(stats − market) AUC**. A
segment "survives" only if stats ≥ market with the CI lower bound **> 0**.
(`audit-06-metrics.mjs §segmentScan`)

| Segment | n | hit-rate | market AUC | stats AUC | (stats−market) 95% CI | survives |
|---|---|---|---|---|---|---|
| 1X2 [1.2,1.5) | 246 | 71.1% | 0.527 | 0.439 | [−0.211, +0.022] | no |
| 1X2 [1.5,2) | 553 | 54.1% | 0.581 | 0.480 | [−0.163, −0.041] | no |
| 1X2 [2,3) | 978 | 38.8% | 0.582 | 0.483 | [−0.134, −0.049] | no |
| 1X2 [3,∞) | 2,485 | 21.2% | 0.608 | 0.504 | [−0.152, −0.062] | no |
| DC [1,1.2) | 894 | 85.3% | 0.634 | 0.521 | [−0.169, −0.057] | no |
| DC [1.2,1.5) | 2,096 | 72.4% | 0.563 | 0.504 | [−0.095, −0.027] | no |
| DC [1.5,2) | 761 | 53.2% | 0.564 | 0.465 | [−0.124, −0.070] | no |
| DC [2,3) | 392 | 34.7% | 0.572 | 0.468 | [−0.175, −0.010] | no |
| DC [3,∞) | 129 | 20.9% | 0.670 | 0.489 | [−0.327, −0.041] | no |
| O/U [1,1.2) | 2,710 | 89.1% | 0.640 | 0.605 | [−0.075, +0.006] | no |
| O/U [1.2,1.5) | 2,411 | 70.9% | 0.568 | 0.542 | [−0.053, −0.002] | no |
| O/U [1.5,2) | 2,061 | 55.0% | 0.560 | 0.539 | [−0.049, +0.008] | no |
| O/U [2,3) | 2,232 | 39.2% | 0.556 | 0.535 | [−0.049, +0.003] | no |
| O/U [3,∞) | 4,192 | 16.0% | 0.668 | 0.629 | [−0.062, −0.020] | no |

**Segments tested: 14. Survivors: 0.** Stats never out-discriminates the market
in any price band; where the CI crosses zero the point estimate is still stats
*below* market. There is no bettable pocket of market-underweighted independent
signal. (Multiple-comparisons note: even the loosest "point estimate positive"
screen finds zero candidates, so no correction is needed.)

---

## 4. The price-blind precision trap (real-odds re-test of "independent signal exists")

Applying a stats-only gate (`stat ≥ 0.85`) on the fair board and reading the
**price** of what it selects (`audit-06-metrics.mjs §statsGatePrecisionAndPrice`):

| Gate | n | precision | median price | % bettable (≥1.20) | precision (bettable only) |
|---|---|---|---|---|---|
| 1X | 97 | 87.6% | **1.130** | 27.8% | **77.8%** (n=27) |
| U 4.5 | 496 | 88.5% | **1.130** | 27.6% | **77.4%** (n=137) |
| O 1.5 | 368 | 80.4% | **1.150** | 32.1% | **72.9%** (n=118) |
| 12 | 379 | 76.5% | 1.220 | 63.3% | 73.3% (n=240) |
| U 3.5 | 174 | 77.6% | 1.220 | 61.5% | 72.9% (n=107) |
| X2 | 83 | 73.5% | 1.280 | 61.4% | 64.7% (n=51) |
| O 2.5 | 56 | 71.4% | 1.310 | 85.7% | 70.8% (n=48) |

The apparently "elite" gates (1X 87.6%, U 4.5 88.5%, O 1.5 80.4%) are precisely
the ones priced **below the 1.20 floor** (median ~1.13–1.15), and their precision
**collapses ~10pp** on the bettable subset. The warehouse backtest confirms the
raw precision *holds out-of-sample* (AU 2.5 88.4%→87.3%, U 4.5 88.3%→85.6%, 1X
84.2%→85.7%, 12 78.7%→79.3%, across 232 leagues — `scripts/backtest-sure-tips.js`),
so the independent signal is *real* — but the book has already priced it, exactly
where it is most precise.

**Per-market fair-board EV** (price-aware, selection-free): every liquid market is
negative flat-stake EV — e.g. **X2 −12.8%**, 12 −8.0%, O 2.5 −5.5%, 1X −4.1%,
U 4.5 −3.0%. No market clears the vig. (`audit-06-metrics.mjs §perMarketFairEdge`)

---

## 5. False-positive ledger

Each prior-audit conclusion re-tested on the selection-corrected board and/or
with day-clustered significance. **SURVIVES / SOFTEN / DROP.**

| # | Claim (prior audit) | Selection-corrected + significance-tested result | CI | Verdict |
|---|---|---|---|---|
| 1 | "Market is the single sharpest signal" | Fair-board market AUC > stats AUC in ALL/1X2/DC/OU; cal-Brier market better in all | AUC diffs [+0.031,+0.039]…[+0.089,+0.131]; cal-Brier diffs all <0, CI excl. 0 | **SURVIVES** (strengthened; now also true after recalibration & pre-selection) |
| 2 | "Blend beats market-only (~0.0003 Brier)" | Tipped rows: blend 0.2031 vs market 0.2034 (point −0.0003 reproduced) | Brier diff **[−0.0023, +0.0010]** (crosses 0); AUC diff [−0.016, +0.022] | **SOFTEN → NOT ESTABLISHED** (blend not worse, but not proven better) |
| 3 | "When stats disagrees bullishly, market is right (70.6%)" | Fair board stats≫market (+0.10+, n=4,233): stats 64.6%, market 47.0%, realized **47.1%** | realized tracks market mean, not stats | **SURVIVES (direction) / DROP the 70.6% number** (that figure was a tipped-selection artifact; effect is starker fairly) |
| 4 | "Blend overrides hit 72.4% vs market-fav 70.9%" | Tipped: 72.4% (n=319) vs 70.9% (n=666), diff +1.5pp | diff **[−0.044, +0.096]** (crosses 0) | **SOFTEN → NOT ESTABLISHED** (noise; audit already hedged) |
| 5 | "The 0.60–0.70 band shows stats sorting correctly" | Fair board band 0.60–0.70: high-stats 66.8% vs low-stats 64.7%, +2.1pp | diff **[−0.015, +0.046]** (crosses 0) | **DROP → NOT ESTABLISHED** |
| 6 | "X2 was +EV then regressed" | Fair board X2 **−12.8% EV** (price-blind); tipped X2 76.2%, Wilson floor **67.1% < break-even 70.1%** | Wilson [67.1%, 83.5%] | **the "+EV" claim DROPS** (never robust; selection artifact) / **"regressed to unresolved" SURVIVES** |
| 7 | "Stats-only 79–88% precision holds OOS" | Backtest OOS reproduced (AU 2.5 88.4%→87.3%, U 4.5 88.3%→85.6%, 232 leagues) | wLo 84–86% | **SURVIVES (raw precision)** — but bettable-edge implication **REFUTED** (§4: priced <1.20, −EV where bettable) |

---

## 5b. Recency-aware re-test (timeliness)

The main board reconstructed stats with the production **COUNT-based** windows
(last 7 games, last 5 H2H), which can admit STALE games — a "last 7" spanning
months/seasons, or years-old H2H with different squads — while the market always
reflects current information. To rule out that this unfairly handicaps stats,
`tmp/audit-06-recency.mjs` rebuilds `stats_prob` with recency-aware selection/
weighting and re-tests against the **same market signal, prices and outcomes**
(only the stats game-selection/weighting changes; strictly leak-free — recent =
finished strictly before kickoff). Each team's full pre-kickoff game list is
fetched once and all variants derive from it.

- **V1 recency-capped** — team games within the last **D ∈ {45, 90}** days
  (still ≤ 7-game count); H2H only meetings within the last **730 days** (else
  the H2H term is dropped).
- **V2 recency-weighted** — the count-based candidate games weighted by
  exponential time-decay `w = exp(−Δdays/τ)`, **τ ∈ {30, 45}** days (the
  coordinator's *halflife* parameter; weight ≈ 0.37 at τ days); preserves coverage.

### Result — recency does NOT close the gap or flip any segment
| Variant | ALL stats AUC | ALL market AUC | gap (mkt−stats) | AUC (market−stats) 95% CI | fixtures w/ stat | rows |
|---|---|---|---|---|---|---|
| count (baseline) | 0.7738 | 0.8083 | 0.0345 | [+0.030, +0.039] | 1,445 | 22,213 |
| V1-D45 | 0.7664 | 0.8066 | 0.0402 | [+0.030, +0.049] | **925 (−36%)** | 14,383 (−35%) |
| V1-D90 | 0.7762 | 0.8102 | 0.0340 | [+0.029, +0.039] | 1,321 (−9%) | 20,472 (−8%) |
| V2-hl30 | 0.7561 | 0.8083 | 0.0522 | [+0.045, +0.059] | 1,445 | 22,213 |
| V2-hl45 | 0.7595 | 0.8083 | 0.0488 | [+0.042, +0.055] | 1,445 | 22,213 |

- **(a) The ALL-group AUC gap does not close.** The best variant (V1-D90) nudges
  stats AUC by only **+0.0024** (0.7738 → 0.7762) but the market rises in lockstep
  (0.8083 → 0.8102), so the gap stays ~0.034. **Recency-WEIGHTING actively HURTS**
  stats discrimination (V2 stats AUC 0.756–0.760 < the count-based 0.774) —
  down-weighting older games sheds sample and adds variance without adding signal
  the odds haven't already absorbed. Every variant's paired AUC CI still excludes
  zero in the market's favour, in **every** group (1X2/DC/OU), and the calibrated-
  Brier CI likewise favours the market for every variant.
- **(b) No bettable segment flips.** The 14-segment group×price scan yields
  **0 survivors under every variant** (V1-D45 tests 13, coverage-thinned). The
  least-negative segment in each variant is OU [2,3), still stats **below** market
  (best case V1-D90: stats 0.540 vs market 0.555, CI [−0.050, +0.021] — crosses
  zero, i.e. not even a significant *tie*, let alone a win).
- **(4) Coverage cost of timeliness.** The strict 45-day cap drops **520 of 1,445
  fixtures (36%)** and 35% of grading rows — a heavy price — *and* discriminates
  no better. The 90-day cap costs ~9% of fixtures for a null effect. The
  timeliness/coverage tradeoff is strictly unfavourable on this data.
- **(c) C0 does not flip.** Under recency-capped and recency-weighted stats alike,
  the market remains the strictly sharper signal everywhere and no bettable
  segment reaches parity. **The NO-GO verdict HOLDS.**

(`audit-06-recency.mjs` → `tmp/audit-06/recency.json`)

---

## 6. C0 verdict — GO / NO-GO

> **Is there a market-independent signal with genuine discrimination the market
> underweights, in a BETTABLE price segment (above the ~1.20 floor)?**

**NO-GO.** (Unchanged under recency-aware stats — see §5b.)

- The market out-discriminates the independent stats signal on a fair, pre-
  selection board in **every** market group, with day-clustered CIs excluding
  zero, and **remains ahead after out-of-sample recalibration** — the deficit is
  genuine discrimination loss, not fixable over-confidence.
- The **segment scan finds 0 of 14** bettable group×price segments where stats
  reaches parity with the market, let alone beats it — and **still 0** under every
  recency-aware stats variant (§5b).
- **Timeliness is not the missing ingredient.** Recency-capping/weighting the
  stats signal does not close the AUC gap (best case leaves it ~0.034) and
  recency-weighting widens it; the strict 45-day cap costs 36% of fixtures for no
  discrimination gain.
- The genuinely-real independent signal (warehouse stats precision, 79–88% OOS)
  is **fully priced**: it concentrates below the 1.20 floor and collapses to
  ~73–78% (negative-EV) on the bettable slice.
- **No liquid market is positive-EV** on the fair board; the one prior "+EV"
  candidate (X2) is −12.8% price-blind and unresolved even on its tipped slice.

A beat-the-book program cannot be founded on the current warehouse + odds data.
The dependence on bookmaker odds is *correct*, not a flaw — the market has
absorbed the independent signal wherever it is bettable. The only paths that
could change this verdict are **new features the market may misprice at scale**
(pre-match per-team rolling *deep* stats — shots/xG conceded-created — which today
cover ~130 fixtures and are post-match only; >90% standings coverage) tested
out-of-sample over **≥30 independent match-days**, not 13. Until such a feature
demonstrates market-beating discrimination in a bettable segment with a CI
excluding zero, the answer is NO-GO.

---

### Method note / reproducibility
Scripts (read-only, `tmp/`): `audit-06-probe.mjs` (schema + odds-timing leakage
quantification), `audit-06-board.mjs` (common board reconstruction →
`tmp/audit-06/board.json`), `audit-06-metrics.mjs` (AUC/Brier/log-loss,
LODO-Platt recalibration, day-clustered bootstrap CIs, segment scan, disagreement,
per-market EV, tipped re-tests → `tmp/audit-06/metrics.json`),
`audit-06-recency.mjs` (recency-capped/weighted stats variants + re-run of the
AUC/cal-Brier/segment-scan → `tmp/audit-06/recency.json`). Project scripts:
`scripts/backtest-sure-tips.js`. Production logic reused verbatim from
`src/db/tip-rules.js` (`teamOutcomeAggregates`, `h2hOutcomeAggregates`, `_devig`
assembly mirrored from `bestTip`, `tipHit`) and `src/db/connection.js`. All
figures from the live DB on 2026-07-14; re-run before trusting any figure as the
sample grows past 13 days.
