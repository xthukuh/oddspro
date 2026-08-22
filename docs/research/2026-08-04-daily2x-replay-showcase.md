# Daily 2x card: hindsight-free replay showcase

**Date:** 2026-08-04 · **Branch:** `feat/engine-v2` · **Environment:** `oddspro-v2`
**Objective:** measure the north-star product (an assured constant daily ~2x win, per the
owner's stated bar) on real historical data, with every hindsight channel closed.

## Why this replay is trustworthy

- **`oddspro-v2` carries observations only**: real fixtures, scores, 5.5M pre-kickoff odds
  rows, teams/leagues/standings/stats copied from the warehouse; every engine-output table
  (`fixture_predictions`, `fixture_prematch`, `fixture_ai_insights`) started EMPTY, so no
  stored prediction could leak into the replay. The ledger rows now in v2 were written BY
  this replay, stamped `computed_at` = kickoff.
- **Information cutoffs**: odds used only if written before their fixture's kickoff;
  rolling stats strictly before each kickoff; the walk-forward calibrator uses only days
  strictly before the card's day. Window: 2026-07-02 → 2026-08-04, 34 days, 3,943
  eligible fixtures, 120,936 settled menu legs.
- **Construction is parameter-free** except two disclosed a-priori choices (shrink k=50;
  card pool capped at price ≤ 1.35, the region where the favourite-longshot bias runs FOR
  the bettor per the same-day calibration audit and the classic literature).
- Reproduce: `node scripts/replay-daily2x.js --db oddspro-v2` (~1 min) and
  `node scripts/simulate.js --db oddspro-v2` (the baseline construction).

## Results (34 days)

| construction | green days | leg acc | flat P&L | best streak |
|---|---|---|---|---|
| **Top-10 banker card** (combined ~1.4-2.3x, varies) | **24/34 = 70.6%** | 96.8% | −2.0% ROI | 7 |
| Calibrated 1.5x-target card (efficiency greedy) | 21/34 = 61.8% | - | **+2.35u** | 7 |
| Calibrated 2.0x-target card | 13/34 = 38.2% | - | −3.76u | 2 |
| Calibrated 3.0x-target card | 6/34 = 17.6% | - | −13.68u | 2 |
| Naive devig-trust 1.5x card (no calibration) | 5/15 = 33.3% | - | −7.26u | 2 |
| Naive devig-trust 2.0x card | 1/7 = 14.3% | - | −4.82u | 1 |

Fair-odds reference points (what a perfectly-priced book would allow): a 1.5x card ~67%
of days, a 2.0x card ~50%, before vig. The calibrated 1.5x card sits just under fair WITH
positive flat P&L (+6.9% per staked unit over the window, n=34 - encouraging, not proof);
the top-10 banker card BEATS its own implied survival by compounding the measured
favourite-longshot edge leg by leg.

## The discovery that made the difference

The naive construction failed (33% green) because the book's cheapest "sure things" are
systematically the WORST-calibrated cells: `O 0.5` at 1.01 implies 99% but goalless days
happen far more often (the breakers were almost all `O 0.5`, `TT U`, `U 5.5` at
1.01-1.05). The same-day calibration audit predicted exactly this (every Over-side key
carries negative edge; Unders and home-side result markets positive). Feeding a
walk-forward per-cell calibration (market-group × price-band realized rates, prior days
only) into leg selection nearly doubled the green rate (33% → 62% at 1.5x) and flipped
flat P&L positive. **The research layer is now demonstrably load-bearing in the
product.** A first attempt with a coarse price-band map also taught its own lesson: a
band that lumps 1.7x with 30x legs lets longshots inherit short-leg hit rates and turns
the card into a lottery (kept in git history as the cautionary diff).

## What this licenses and forbids

- License: the daily card product line, led by the top-10 banker construction (70.6%
  green days at n=34, matching the earlier 13/16 finding on an independent window) with
  the calibrated fixed-target variant as the tunable arm. Report day survival + streaks
  first, per the owner's bar.
- License: shipping the calibration layer into leg-probability estimates everywhere
  (slip survival meter, banker prob, sure bets) - measured, walk-forward, honest.
- Forbid: claiming the 2x-every-day guarantee is reached - current evidence: ~70% green
  at ~1.5-1.8x combined, ~38% at a strict 2.0x target. The GAP is the work queue:
  coverage/hedged constructions, per-league cell refinement, and larger windows as data
  accumulates under the now-stable config. No ceiling is asserted; the next experiments
  are defined.

## Viewing the showcase

Point the app at the replay environment and browse it like production:
`DB_DATABASE=oddspro-v2 npm run serve` → the table shows the replayed Tip and Banker
columns with settled outcomes for the whole window (3,943 ledger rows, frozen at their
kickoff stamps). The production warehouse (`oddspro`) is untouched.

## Next experiments (pre-registered, in order)

1. Re-run both constructions weekly as data accumulates; the calibrator's cells tighten
   and the 2.0x-target green rate is expected to rise - measure, don't assume.
2. Correlation-aware legs: same-league caps are crude; model shared-day dependence.
3. Hedged coverage: pair each card with a cheap cover leg on its most fragile member
   (the ladder relation lattice makes mutually-exclusive coverage constructible).
4. Fold the audit's home-side and Under-side tilts into the per-cell prior instead of
   the flat devig anchor.
