# Daily MultiBet: simulation grids and the baked v1 algorithm

**Date:** 2026-08-06 · **Branch:** `feat/engine-v2` · **Data:** `oddspro` warehouse,
35 hindsight-free days (2026-07-02 → 2026-08-05), 4,072 eligible fixtures, 123,360
settled menu legs. Reproduce: `node scripts/simulate-daily-slip.js --db oddspro`.

## Method

Same information discipline as the 2026-08-04 replay showcase: pre-kickoff odds only
(simulate.js load/derive), walk-forward calibration (`src/db/leg-calibration.js`)
observing strictly prior days, settled hit/miss menu legs only. Deterministic end to
end, no RNG, so a grid cannot be re-rolled until it looks good. Winner rule committed
before the first run: among parameter cells publishing on at least 2/3 of days, rank
by green-day rate, then best streak, then flat P&L. Every cell of every round is
printed by the script; nothing was cherry-picked.

## The three rounds

**Round 1** (floors 0.88-0.96, unlimited depth, price/league/cell axes): unlimited
depth collapses survival. Floor 0.90 uncapped = 11.4% green at 55+ legs; floor 0.96
uncapped = 60.0% at ~19 legs. maxLegPrice is inert (a 0.96-floor leg is never priced
1.6) and minCellN 30 is mildly negative everywhere.

**Round 2** (adds the maxLegs depth cap): the cap is load-bearing. Floor 0.96 with a
6-leg cap: **26/30 green = 86.7%, best streak 8, avg 5.5 legs @ 1.07x**. The full
depth ladder at floor 0.96: 6 legs 86.7% → 8 legs 83.3% → 10 legs 80.0% → 12 legs
73.3% → unlimited 60.0%. Depth buys odds and sells survival, smoothly.

**Round 3** (adds efficiency ranking and a minimum leg price): two findings.
1. **The market does not sell calibrated 94%+ at prices 1.08+.** Every minLegPrice
   cell (1.08/1.15 at floors 0.94/0.96) published zero days: the intersection is
   empty by market structure, not by bug. High floors force short prices.
2. Efficiency ranking (survival cost per unit of log-odds, the replay's buildCard
   metric) at floor 0.96 / 6 legs: 83.3% green, **best streak 11**, 1.11x. It trades
   ~3pp of green rate for +4% combined odds and the longest streak observed.

## The survival-vs-odds frontier (floor 0.96 unless noted)

| construction | green days | best streak | avg odds | flat P&L |
|---|---|---|---|---|
| **prob-rank, 6 legs (BAKED v1)** | 26/30 = 86.7% | 8 | 1.07x | −2.18u |
| eff-rank, 6 legs | 25/30 = 83.3% | 11 | 1.11x | −2.35u |
| prob-rank, 10 legs | 24/30 = 80.0% | 8 | 1.12x | −3.28u |
| prob-rank, 12 legs | 22/30 = 73.3% | 8 | 1.14x | −5.17u |
| eff-rank floor 0.94, 10 legs | 18/34 = 52.9% | 5 | 1.45x | −8.29u |
| replay 1.5x-target card (2026-08-04, for reference) | 21/34 = 61.8% | 7 | ~1.5x | +2.35u |

## What was baked (DEFAULT_DAILY_SLIP, algo v1-sim-2026-08-06)

`rankBy: 'prob'`, `probFloor: 0.96`, `maxLegs: 6`, `minLegs: 2`, `maxLegPrice: 1.35`,
`maxPerLeague: 3`, `minCellN: 0`, mood terciles green `{legs: 20, meanProb: 0.970}` /
amber `{legs: 11, meanProb: 0.965}` (pool depth and quality of the winner's published
days). The timeline was backfilled walk-forward over all 35 days (`backfilled = 1`,
26/30 green, current streak 3 at the boundary) and today's live card rebuilt under
the baked algorithm before any user saw the provisional one.

Self-improvement property: the calibration cells recompute from the growing settled
ledger on every build, so the same baked knobs sharpen as data accumulates, with no
manual re-tuning required. Re-run the grid monthly; re-bake only with a dated regime
note (the policy-regime discipline).

## Round 4: error feedback (owner directive, 2026-08-06)

Construction pinned at the baked winner; only the calibrator varied. Two mechanisms
from the owner's "stereotype patterns / heal from bad picks" directive:

| calibrator | played | green | best streak | P&L |
|---|---|---|---|---|
| flat (incumbent control) | 30 | 26 = 86.7% | 8 | −2.18u |
| **recency decay, half-life 30d (BAKED)** | 30 | 26 = 86.7% | 8 | −2.17u |
| recency decay, half-life 14d | 30 | 26 = 86.7% | 8 | −2.21u |
| league layer, k=10 (with/without decay) | 33 | 25 = 75.8% | 8 | −5.9u |
| league layer, k=20 | 33 | 25 = 75.8% | 8 | −6.1u |

- **League-stereotype layer REFUTED**: it drops the green rate 10.9pp. The failure
  mode is instructive: it published on 3 MORE days, meaning thin per-league samples
  INFLATED some leagues above the floor (lucky early hits) rather than only
  discounting bad ones. Hierarchical shrinkage cuts both ways; the global cells are
  the better stereotype at this ledger size. Re-testable later via `leagueK` (the
  plumbing stays, inert).
- **Recency decay ADOPTED at half-life 30** (`v1.1-heal-2026-08-06`): identical
  performance at n=35 days (there is little to forget yet), so it costs nothing
  measured, and it is the healing property itself: as history grows, a cell that
  starts missing is dragged down by fresh errors at full weight while stale wins
  fade at 0.5^(age/30). Re-measure monthly with the standing grid.

## Round 5: iterative evolution (owner directive, 2026-08-06)

`scripts/evolve-daily-slip.js`: deterministic coordinate-descent generations
(champion + every single-knob neighbor, ~17 candidates/generation, converged in 5
generations / ~85 evaluations, no RNG), fitness = the committed rule on a
walk-forward replay, search restricted to the first 2/3 of days (TRAIN), champion
validated on the untouched TEST tail. Searched dimensions included the owner's
streak preferences: unbroken-record cell gates, tail-streak gates, miss cooldown,
market-level taxonomy, streak-first ranking.

**Champion (BAKED as v1.2-streak-2026-08-06):** floor 0.95, top-5 legs,
STREAK-FIRST ranking (unbroken-record cells before everything, by evidence depth;
broken/unknown cells fall back to calibrated prob).

| window | incumbent (v1.1) | champion (v1.2) |
|---|---|---|
| TRAIN (22-23 days) | 15/18 = 83.3%, streak 8 | 20/22 = 90.9%, streak 12 |
| TEST (12 days, untouched) | 11/12 = 91.7% | 11/12 = 91.7% (tie; P&L −0.16u worse) |
| FULL (flat calibrator) | 26/30 = 86.7%, streak 8 | 31/34 = 91.2%, streak 12 |
| FULL (production decay) | — | 30/34 = 88.2%, streak 12 (the live timeline) |

- Hard streak GATES all rejected by the search (they starve publishing); the
  streak PREFERENCE in ranking is what works. The champion also publishes 4 more
  days and wins them (floor 0.95).
- Honest caveats: the champion ties (does not beat) the incumbent on the 12-day
  test tail; and combined with the baked decay the full-window rate is 88.2%, one
  day below the flat-calibrator 91.2% (noise-sized; decay kept for its principled
  healing property rather than re-rolled away).
- The evolution script is a STANDING instrument: re-run monthly; each re-run is
  the owner's "test and tweak until optimal" loop over a bigger ledger.

## Round 6: multi-card day groupings (owner directive, 2026-08-06)

`scripts/grouping-daily-slip.js`: the v1.2 ranked pool dealt into multiple small
cards per day. EVERY split reached **100% any-green days (35/35, best streak =
the whole window)**: one bad leg kills one card, not the day. P&L per staked
unit improved (single −5.3% → splits −2.2%/−3.3%) because surviving cards
recoup stakes. **Baked (v1.3-cards): split-2x2** — top-4 dealt round-robin into
two 2-leg cards — which keeps strict all-cards-green at the single-card 88.6%.
Timeline regenerated: 32/32 settled multi-card days any-green, 28/32 both-green.
Honesty: any-green at ~1.03x/card is a survival record, not profit (still −3.3%
per unit); `outcome` keeps the strict all-cards meaning, `cards_won/total`
carries the survivability record.

## Round 7: value-seeking evolution with real risk (owner directive, 2026-08-06)

`scripts/evolve-value-slip.js`: fitness flipped to PROFIT PER STAKED UNIT at real
odds (target-closing cards, legs to 3.5x, floors to 0.70, edge floors, family
tilts, error-feedback knobs). Two iterations:

1. **Round 1 produced a MIRAGE and the guard caught it**: train +28.8% ROI
   (floor 0.70 + minLegPrice 1.10) collapsed to **−41.6% on the untouched test
   tail**. Recorded as the canonical overfit example.
2. **Round 2 (anti-mirage fitness: a config's score is its WORST-half train
   ROI) found a generalizing emergent**: the seed 1.5x card + **maxCards 2**
   (two efficiency-ranked 1.5x-target cards per day). Full window: 44/72 cards
   = 61.1% at 1.63x avg, **ROI −0.4% (break-even, vs −4.5% single-card)**,
   any-win day streak 11; test tail −4.5% = no collapse. Risk ladder: 2.0x arm
   −2.1% (fair-priced), 2.5x/3.0x arms −17%/−39% (real ceiling at this ledger).

Verdict: at 36 days of data, honest value sits at ~break-even for a two-card
1.5x construction — a genuine 4pp/unit improvement over the single card, no
proven +EV yet. The instrument re-runs monthly; every future claim must clear
the worst-half fitness AND the untouched tail, exactly as these two rounds did.

## What works — validated principles (session close, 2026-08-06)

Eleven replay-tested experiments distilled; build on these, re-derive nothing:

1. Structure beats selection at small samples (caps, splits, targets, floors
   proved on weeks; league/line stereotypes all need months - queued, not dead).
2. One walk-forward calibration layer shared everywhere (the 33% -> 86.7% lift).
3. Diversify the day into small cards: a bad leg kills a card, never the day.
4. Close-at-target construction = fewest legs and max value per leg, no cap needed.
5. Anti-mirage fitness (worst-half train + untouched tail) is what makes hot
   iteration converge - it caught two +28-35% train mirages this session.
6. Preferences beat gates: rank by streaks, never hard-ban.
7. Recency decay = costless healing; daily cell recompute = improvement without re-work.
8. Market structure (measured): no calibrated 88%+ above 1.2 odds; near-Unders
   below break-even yet least-bad; 1.5x targets the out-of-sample value ceiling.
9. Owner intuition -> measurement -> bake-or-ledger: both outcomes advance the engine.
10. Metric honesty (strict vs any-green vs P&L/unit, labeled backfills) keeps the
    timeline a trustworthy judge.

Concluding path: v1.5 accumulates LIVE days from 2026-08-06 forward (the real
verdict); monthly instruments re-audition the graduation queue (2.0x arm first,
then the near-Under split and league layer) as the ledger fattens.

## Honest framing (per the 2026-08-06 charter: report plainly, never stop experimenting)

- 86.7% green days with a best streak of 8 is the strongest day-level survival
  construction measured on this warehouse to date. It is licensed as the Daily
  MultiBet v1 product: survival-first, exactly the owner's brief.
- Flat P&L is still negative (−2.18u over 30 played days): winning 1.07x on 87% of
  days does not yet outrun the vig. The daily-2x-with-profit bar is NOT reached; the
  measured gap between the survival arm (86.7% @ 1.07x) and the replay's calibrated
  1.5x target arm (61.8% @ 1.5x, +2.35u) is where the next experiments live.
- Pre-registered next steps: (1) mood-adaptive depth (extend legs only on green-pool
  days; round 2 says fixed depth extension costs ~3pp per 2 legs, so the question is
  whether pool quality predicts WHICH days can afford it); (2) the eff-rank arm as
  the Phase 3 `target` strategy with user-chosen targets; (3) correlation-aware leg
  selection (same-league caps are crude); (4) monthly grid re-runs as the ledger
  grows.
