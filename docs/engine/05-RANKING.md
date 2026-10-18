# 05 - Ranking & selection: calibration, strategies, sure, safe

> **Honesty contract** (full statement: `00-README.md`): no market is +EV on our books;
> flat-stake EV ≈ −3%. Everything below maximizes *win probability and slip survival*,
> never profit. Evidence: the 2026-07-13/14 sure-win + fair-comparison studies
> (pruned 2026-08-04 - git history).

All logic in `src/db/magic-rules.js` - pure except for the perf-rules bucket labellers it
imports, so the suite still runs offline, and shared VERBATIM by the server loader and the
web table (one scorer, no client/server drift). Vite serves the out-of-root import in dev via
`server.fs.allow ['..']`; the production build follows the relative import natively.

```mermaid
flowchart TD
    L["Settled tip ledger"] --> C["computeCalibration - shrunk hit-rate buckets: band / group / band-x-group cell / O-U line / price band / market"]
    C --> S["11 strategies score each tip"]
    S --> R["LODO replay ranks the strategies (slip survival, then top-quartile rate, then ROI)"]
    C --> D["Default sort: sure = safePrior(market) x confidence"]
    D --> SAFE["Safe pool: safeQualifies gates, top 3 per day"]
    SAFE --> SB["Sure bets: same gates, ranked by estimateLegProb, top 10 per day"]
```

## Calibration

`computeCalibration` digests every settled tip into empirical hit-rate buckets. Thin cells
can't dominate because every rate is **beta-shrunk** toward the global rate:

```
shrunkRate = (bucket.hits + k * globalRate) / (bucket.n + k)     // k = shrink_k pseudo-counts
```

Voids are skipped from rate buckets; per-market buckets also carry flat-stake
`staked`/`profit` (the per-market honesty line in the UI).

The engine-v2 **leg-cell calibrator** (`loadCalibrator` in `src/daily-slip.js`, served as
`calibration.leg_cells` on `/api/magic-sort` and feeding the Daily MultiBet) is built from
every offered menu leg of every settled fixture in a 90-day window. Its `odds_markets`
load is chunked per 200 fixtures (2026-08-23): the single `IN (...)` statement it used to
issue covered ~10k fixtures and ~7M rows, which the shared live host killed every time
("lost connection during query", the error behind the 2026-08-19 full-sweep failure) and
which peaked at 1.5 GB RSS where it did run. Chunking keeps the output byte-identical
(sha-verified) at a 443 MB peak, and live carried `leg_cells` for the first time that day.
Since 2026-10-18 the `/api/magic-sort` copy is built once per EAT day and kept in
`meta.leg_cells` (`src/magic.js#todaysLegCells`, the `pick_cells` idiom), because this load
was 261 s of a 288 s cold request locally and every restart or extra instance repeated it;
the cells are the same walk-forward export, only stored (chapter 01, "Serve behavior notes").

## The 11 strategies

| id | Scores by |
|---|---|
| `sure` | **default sort** - `safePrior(market, cal) × confidence` |
| `confidence` | raw blend confidence (baseline) |
| `market` | devigged market probability |
| `stats` | rolling-stats support |
| `agreement` | weakest present blend component (min of parts) |
| `edge` | EV proxy `confidence × price − 1` (ordering only - NOT a profit claim) |
| `price_band` | shrunk hit-rate of the tip's price band |
| `bucket` | band×group cell posterior (exploits the observed 0.60-0.69 > 0.80+ inversion) |
| `line` | O/U-line (or market-group) shrunk rate |
| `cal_conf` | `√(posterior × confidence)` geometric blend |
| `cal_market` | `market × (posterior / globalRate)`, clamped |

Every scorer is total via fallback chains ending at blend confidence (rows written before
2026-07-04 lack `tip_breakdown`). `simulateStrategies` replays each strategy per settled day - 
top-4 slip at real prices, **leave-one-day-out** calibration so calibrated strategies never
grade their own answers - ranked by slip survival → pooled top-quartile hit rate → ROI, with
the user-selected policy applied to the `days >= minDays` tier first. Its stats also carry
`streak {days, avg, best}`, the depth before the first miss from the top of each day's
ranking; that number is **display-only** and does not move ranking policy until there are
more than 30 replay days. Live lesson worth remembering: **raw confidence is NOT monotonic
with winning**; the calibrated strategies are the "gets better as data grows" part.

`magicSortRows` orders by score descending with stable ties, sinking tipless and skipped
rows. **AI-vetoed rows deliberately do NOT sink** - `scoreTip` never consults
`tip_ai_verdict` (M4.1 spec section 3.8; the settled evidence is in chapter 06).
`slipSummary` and `estimateLegProb` back the web table and the betslip playground, so the
survival number a slip shows is the same one the ranking used.

## The v2 menu (2026-08-06, engine-v2 Phase 3)

The UI strategy menu is now the calibration trio, filtered into the payload by `V2_MENU` in
`src/magic.js`:

| id | Scores by |
|---|---|
| `banker` | **default sort**, labelled "Tip (most likely first)" since 2026-10-16 - the row's Pick by OUR calibrated win chance (`bankerProb` = `tip_banker_cal` through `pickView`), scored through `rowScore` so a row with a Pick but no stats tip ranks instead of sinking. The id stays `banker` so stored sort chains keep working |
| `target` | efficiency: survival cost per unit of log-odds - the odds-bearing arm |
| `value` | calibrated edge `p × price − 1` - an ordering signal, NOT an EV claim |

The legacy 11 stay exported, replayable and API-callable; they simply leave the payload.
`/api/magic-sort` carries the walk-forward menu-leg calibration cells as
`calibration.leg_cells` (the `loadCalibrator` export, about 77 cells - the layer the
2026-08-06 daily-slip grids proved load-bearing), so client and server score off ONE layer,
and `estimateLegProb` prefers a leg cell with n >= 30 over the tip-bucket posterior.
**Sure Bets (shown as "Top picks" since 2026-10-16) are the day's Picks** ranked by
`tip_banker_cal`; the old stats-tip fallback through `safeQualifies` was removed with the
switch, because it admitted 1.35-1.49 tips below the 1.50 floor.

## The Pick and the Top-3 picks card (2026-10-16, current)

Owner directive 2026-10-16: tips must be obvious, priced at 1.50 or more, never an Over 0.5
filler, chosen by our own data and computations (no bookmaker bonus, no tax modelling), and
the daily card must stop reading "Lost" while showing its winning path.

**What it replaced.** The Banker was the shortest price on the board (floor 1.01). Over
28,843 settled fixtures (2026-07-02..10-15) it hit 90.6% at -4.1% flat ROI, but O 0.5 was
30% of all Bankers at an average 1.03 and it carried no information of ours. The old Daily
MultiBet tiers lost most days by construction: Hunter 4 won / 44 lost, top-3 11/26, Sharp
5 of 14 backfilled days.

**The Pick** (`src/db/pick-rules.js`, written by `hotpicks.js` into `tip_banker_market`/
`_price`/`_prob` plus the new `tip_banker_cal`, migration 20261016000001): per game, among
markets priced 1.50-2.20 and not Draw No Bet, the one with the highest calibrated win
chance. Calibration is the **residual** form, walk-forward over 90 days of pre-kickoff
prices (`src/picks.js`, cells cached once a day in `meta.pick_cells`):

    P(leg) = clamp(devig + sum(hit - devig) / (n + 300), 0.005, 0.995)   per group|band cell

The shared leg-cell calibrator was tried first and rejected for this job: it replaces a
leg's number with its cell's average, so inside the wide 1.60-2.20 band a 2.15 leg rates like
a 1.61 leg, the Pick drifts to the longest price and over-claims (claimed 60.5%, realized
57.4%). The residual form keeps each leg's own price information.

**Top-3 picks** (`buildDailySlip` v3, `ALGO_VERSION v3.0-picks-2026-10-16`): the day's
three games with the highest `tip_banker_cal`, read from the stored Picks so the card always
equals the table. Each is a single stake (`kind: 'pick'`, one card index each), shown in
kickoff order. The settle pass scores the day with `picksDayScore`: units = sum of
(price - 1) per hit and -1 per miss; the day is `won` when units > 0. `legs_hit` and
`cards_won` carry the pick record.

**Measured** (`node scripts/replay-picks.js`, the production functions over the local
settled extract, train 2026-07-16..09-13 / untouched test 09-14..10-15):

| | train (60 days) | test (32 days) |
|---|---|---|
| every game's Pick: hit / claimed | 59.4% / 59.4% | 59.4% / 59.2% |
| every game's Pick: avg price, flat ROI | 1.58, -6.3% | 1.58, -6.4% |
| Top 3: picks hit | 59.4% | 63.5% |
| Top 3: days with 2+ of 3 won | 61.7% | 65.6% |
| Top 3: days in profit | 50.0% | 65.6% |
| picks below 1.50 | 0 | 0 |

Honest reading: a 1.50+ price caps a single pick near 65%, so the card can never be
guaranteed, and flat ROI stays negative (no positive-EV market is established on our books).
What changed is what the user sees: one obvious tip per game, a score per day instead of a
verdict word, and the path of which picks won. Not modelled in the replay: the live
`errorBoost`.

**The daily slip (2026-10-16, owner wizard: fewest legs, 2.5x minimum).** Below the Top-3
singles, `buildDailySlip` adds one parlay card (`kind: 'slip'`, `combined_odds` = its
price): exactly 2 legs, one per game, each a 1.50-2.20 market (not DNB), chosen by
`pick-rules.js` `selectSlip` to maximize the product of our calibrated chances subject to
combined odds >= 2.5x. Candidates are every qualifying market of the day's games (menus
from non-stale prices, chances from the cached Pick calibrator), minus any leg that
contradicts its game's Pick. The settle pass counts a won slip in `cards_won`; the day
verdict stays the picks score unless a day has no picks. Replay (`node
scripts/replay-slips.js`, the same selector, one slip a day):

| Design | train won | test won | avg odds | flat ROI train / test |
|---|---|---|---|---|
| **2 legs >= 2.5x (shipped)** | 46.7% | 56.3% | 2.56x | +21% / +42% |
| 2 legs >= 3x | 35.0% | 40.6% | 3.03x | +7% / +23% |
| 3 legs >= 4x | 25.0% | 34.4% | 4.13x | +4.5% / +38.7% |
| 2 legs >= 4x | 21.7% | 12.5% | 4.09x | -12% / -50% |

Samples are 60 and 32 days, so the ROI is early evidence, not an established edge. Gating
days on the claimed pair chance did not separate winners from losers, so every day
publishes. A first version of the replay sorted its candidate pool backwards and kept the
40 least efficient legs (it reported ~30% won); the selector now lives in `pick-rules.js`
and the replay calls it, so the two cannot drift again.

**Stats shadow (2026-10-16).** `src/db/shadow-rules.js` logs the one rule family that survived
the 2026-10-16 four-analyst study (tmp/analysis/*.md: strength gaps, per-fixture goal
profiles and API-Football/H2H signals found no edge the price does not already hold):
combined **shots-on-target volume**. V = mean of (both sides' shots on target per game) over
each team's last 8 earlier stat games, averaged across the two teams, both teams needing >= 3
such games (no league-average stand-in). GG fires at V >= 10.25 and O 2.5 at V >= 10.13, at
1.50+. Shadow legs ride the daily_slips row as `kind: 'shadow'`: graded by the settle pass,
never shown, never counted in legs/cards, so the record accrues without risking the card.
A full-slip comparison on identical days kept the shipped slip as headline (only it held a
positive 95% interval and it publishes every day; the stats-only slip found a slip on about
half the days).

**One selection, live and backfill.** `composeCard` (Top picks + slip + shadow from loaded
data) and `cardLegs` (the stored records) are the single definition `buildDailySlip` and
`scripts/backfill-algo.js` both call. The backfill recomputes only derived rows for past days
(the Pick in `tip_banker_*` and `daily_slips`, `backfilled = 1`), walk-forward over pre-kickoff
prices with the live 90-day window, grades through the normal settle passes, and writes
`tmp/backfill-algo-<stamp>.json` first (`--restore` undoes it). Local run over 2026-07-16..
10-15 on the fully synced warehouse: daily slip won 43 / lost 48 (47.3%), +19.49 units at
1 unit a day; Top picks 174 / 100 (63.5%); shadow 403 / 226 (64.1%).

The GEN-2 ladder, Hunter singles and the Sharp 4x card below are **no longer built**; their
sections stay as the record of what the historical `daily_slips` rows contain.

## Daily MultiBet: the GEN-2 value ladder (2026-08-08, retired 2026-10-16)

`buildDailySlip` v2.0 ships four tier cards per day: the **anchor** at 1.5x (the day
verdict), a **double** at 2x, a **top-3** card whose legs are each >= 1.5 odds, and an
EV-gated **grand** at 5x. The card set is **coherent by construction** - no leg contradicts
another taken leg or the fixture's own tip - and only tip-eligible fixtures are drawn from.
`errorBoost` is x2, so a published miss teaches the calibration cells harder than an
unpublished one.

The generation was baked from **313 walk-forward generations** (`scripts/evolve-gen2.js`,
both-windows rule) and the timeline was honestly backfilled by
`scripts/backfill-gen2-timeline.js`: **24/37 anchor-green, 31/37 any-card**, with the
backfilled days tagged as such in the UI.

Two same-session fixes belong with it: the daily-slip settle pass no longer keeps grading
legs on a day that is already decided, and a fixture that dies is voided after 7 days; the
magic-sort memo is warmed at boot, which removed a 25s stall on the first hit.

## Sharp 4x: the BetPawa Win Bonus card (2026-10-15, retired 2026-10-16)

Retired the day after it shipped by owner directive ("we only trust our data and
computations"): the card was built on BetPawa's own probability and its Win Bonus. Its
14-day live backfill stays in `daily_slips`; `scripts/backfill-sharp.js --restore <file>`
remains the undo path.

One extra card on the daily slip: **one BetPawa slip of exactly 3 legs, each priced
1.30-2.00, combined odds >= 4, priced with BetPawa's own Win Bonus**
(`src/db/sharp-rules.js`, `src/db/betpawa-bonus-rules.js`; research record
`docs/research/2026-10-15-sharp-4x.md`).

How it works, in order:

1. **BetPawa's own probability is the input.** BetPawa stores a win probability `q` on every
   price (`odds_markets.probability`; Betika has none). Its Win Bonus is computed FROM `q`:
   80% of a compressed house edge is given back as extra odds, capped by leg count (1.05x at
   3 legs, 1.08x at 4, 1.35x at 10, 13.5x at 60). With `q` correct, the bonus can never make
   a slip profitable; it pays only where the punter's probability beats `q`.
2. **Where `q` runs low.** Over 763,689 settled pre-kickoff BetPawa prices, realized hit
   rates beat `q` in every band from 1.02 to 3.50 (by 0.4-1.0 points, both halves), and 1X2
   favourites at 1.35-1.60 by about 2.5 points. The calibrator learns that gap walk-forward:
   `P = q + sum(hit - q) / (n + 300)` per `groupOf(market) | bandOf(price)` cell, observing
   only fixtures settled before the build day and only prices written before kickoff.
3. **Selection.** Exact-3 group knapsack maximizing `sum ln P` with `sum ln price >= ln 4`,
   one leg per fixture, never contradicting a leg already taken on that fixture or its tip.
   The pool is ranked by efficiency `ln P / ln price`, never by raw `P` (a raw pool fills with
   1.3x legs that cannot reach 4x, the silent zero-publish trap: measured 57/85 days
   published before the fix, 85/85 after).
4. **No upkeep.** Cells re-fit from settled results on every build; the bonus configuration
   is read from BetPawa's public brand data (`fetchBetpawaBonusConfig`, 6h memo) with the
   site-verified constants as fallback.

Draw No Bet is excluded: BetPawa's `q` for DNB is the unconditional win chance and its
calculator adds the draw back through a `voidProbability` the warehouse does not store.
The Sharp card never decides the day verdict (the anchor still does).

**Measured, not promised.** Replay 2026-07-23..10-15, one slip a day: published 85/85, won
24 (28.2%) against BetPawa's own 23.2%, average 4.19x with the bonus, +18% gross (halves
+29% / +7%), about 0% net of the 20% withholding on winnings. Leg-level edge against `q`:
4.5% +/- 2.2%. **A 4x slip can win at most EV/4 of days**, so with this edge the ceiling is
about 27-28% of days: the card is a positive-expectation bet that wins about one day in four,
never a daily guarantee. Single-slip ROI swings by about 20 points on small construction
changes (SE about 19 points over 85 days), so the forward record, not the replay, decides it.

## `sure` - the default sort

```
sure_score = safePrior(market, cal, k=20) × confidence
safePrior  = (liveBucket.hits + 20 × anchor) / (liveBucket.n + 20),  anchor = WAREHOUSE_WLO[market]
```

`WAREHOUSE_WLO` holds per-market warehouse temporal-OOS hit-rates - deliberately the
CONSERVATIVE *unconditional* rate (not a gated precision), because warehouse stats-only
precision is price-blind and anti-correlated with live ROI (an "87% precise" Under is priced
below the 1.2 floor, or carries about zero edge where it is bettable). The k=20 live term
dominates as soon as a market accumulates real settled tips. M3 added the new-family anchors
(`GG`/`NG`/`DNB1`/`DNB2`/`ODD`/`EVEN` plus every offered `TT:*` key) over 11,372 eligible
tips on a newest-30% TEST split with DNB voids excluded. Team-total and BTTS Unders look
strong stats-only BY DESIGN - the measure is price-blind - which is exactly why they must
never be the live prior.

`sure` favours the markets that most often win at real odds (double chance broadly). Two
market-level claims are settled and must not be re-litigated without new data: the earlier
"X2 is the only live-established +EV market at +15%" is **REFUTED** by the 2026-07-14 fair,
selection-corrected and recency-robust re-test (X2 is −12.8% price-blind EV and regressed to
unresolved; **no market is +EV**), and `12` remains the biggest live loser at about −8%.
Pinning `sure` as the safe ranker lifted the safe-pool leg rate **81.5% -> 88.9%**
(`DEFAULT_SAFE.strategy` is now `sure`, best streak avg 4.2 / best 10).

**Honesty, restated where it is easiest to forget:** `sure` maximizes win probability and
slip survival, NOT profit - overall flat-stake EV is about −3.2%, the vig. M3 (2026-07-16)
did ship any-market tips, the best-supported market per fixture across all seven families,
but as HONESTLY-LABELLED picks and never as a +EV claim; the per-market honesty line in the
UI says exactly how each market has performed live.

## Safe pool and Sure bets - two different things (naming trap)

- **Safe pool** (`safeQualifies` + `safeSelection`, the 🛡 toggle, shipped 2026-07-09 as the
  Safety Net Protocol): gates each row - ≥ 2 blend components present, the weakest
  (`tipAgreement`) ≥ 0.65, price ≤ 1.6, sufficient stats (`minSamples` 6), one row per
  `api_id`, market maturity ≥ 30 settled tips - then ranks per EAT day by the pinned
  strategy (`SAFE_STRATEGY`, now `sure`; it was `market` when the pool shipped), top
  **3/day**. Env-overridable (`SAFE_*`); NEVER retune without a fresh
  `scripts/analyze-safe-tips.js` run (LODO grid). The 2026-07-09 run replayed **94.4% legs
  at 2.6 picks/day**; the runner-up swap it also tests was backtested net-negative
  (+108/−128), so `bestTip` stays untouched and the script re-tests that hypothesis weekly.
- **Sure bets** (⭐, `sureBetsSelection`, 2026-07-17): returns an ordered `[{row, prob}]`,
  gated by the SAME spec-PINNED `DEFAULT_SAFE` literals (`DEFAULT_SURE_BETS` is
  `maxPerDay: 10`, `slipSize: 3`, and the web passes only that - an env-tightened `SAFE_*`
  policy starves the list, live-verified, so v1 has NO env or user gate tunability), but
  ranked by **`estimateLegProb`** descending - NOT the `sure` strategy, whose top ranks
  underperform in replay (rank #1 realized 63-64% vs ~85% at ranks 8-10). Null-prob rows are
  excluded, the cap is per EAT day. Top **10/day**, 3-leg seed slips. A *survival* claim,
  never EV.

**The market-maturity floor** is `safeQualifies(row, opts, cal)` with `opts.minMarketSettled`
(`SAFE_MIN_MARKET_SETTLED`, default 30, shipped inside the `/api/magic-sort` `safe` object):
a market with fewer than that many settled tips cannot enter the safe pool at all, so a
brand-new family can never be selected before it has a live track record. Live-verified: no
new-family market had a single settled tip when M3 shipped, so all were excluded.

**Stats sufficiency** ("exclude risky bets") is `hasSufficientStats(row, opts)` -
`minSamples`/`minH2H` read off `tip_breakdown.samples`, tolerant of sample-less rows. It is
folded into `safeQualifies` and reused VERBATIM by the web risk-gate filter (`applyRiskGate`
in `filterValues.js`), which auto-applies whenever a magic sort or Safe-only is active,
shows a ViewPills chip and defaults ON. Knobs: `SAFE_MIN_SAMPLES`/`SAFE_MIN_H2H`.

`SAFE_TIERS` (max-precision / balanced / volume) vary only agreement, price and cap;
`minParts` is pinned at 2, because parts = 3 is a double-chance-only confound.

## Per-market honesty line and plain-language labels

`computeCalibration`'s `cal.markets[key]` carries `staked`/`profit` alongside the rate, which
is the flat-stake ROI per market the UI prints as the honesty line (void rows are skipped
from the rate buckets). `tipMarketLabel(market)` turns a stored key into plain language
(`'TT:H:O 1.5'` -> "Home team over 1.5 goals", `'DNB1'` -> "Home (draw no bet)", `'GG'` ->
"Both teams to score: Yes", ...) and falls back to the raw key; the web TipPopover and table
import it VERBATIM so labels can never drift from the engine.

## Pattern mining: read-only, and what it refuted (M4.2)

`src/db/mine-rules.js` + `scripts/mine-patterns.js` are the emergence-pattern mine. It ships
**NO ranking change** - same discipline as M4.1: mine freely, ship skeptically.

The pure module imports only the perf-rules/magic-rules labellers, **never a second
taxonomy**, since a private "market family" would silently diverge from what
`computeCalibration` buckets by. It holds:

- the anti-false-positive controls: `temporalSplit` on whole days; `benjaminiHochberg` step-up
  FDR; `dayClusteredBootstrap`, which **resamples DAYS not rows**, because same-day tips are
  correlated and a row-level CI fakes precision the data has not earned; and a seeded PRNG so
  a mine cannot be re-rolled until it looks good.
- the feature extractors `configSignature`/`hasStraddle` (runner-up configurations),
  `cascadeLadder`, `missProfile`, `consensusProxies` - all **total**, because `tip_breakdown`
  is persisted JSON written by older code versions, i.e. external data.
- `evaluatePattern` and the **closed class vocabulary** `edge` / `booster` / `refuted` /
  `underpowered` / `unbettable`. `booster` (real lift, EV <= 0 - buys survival, not profit)
  versus `edge` (clears break-even at real prices - **none has ever been found**) is the
  honesty contract; `unbettable` (real lift priced under 1.20) stays deliberately distinct
  from `refuted`, because that trap was the biggest lesson of the precursor-patterns mine.
- `PRE_REGISTERED`, the 8 hypotheses committed BEFORE the mine ran. Post-hoc finds are never
  ship-eligible. The script reuses `settledTipRows()` verbatim (zero new DB code, so it
  cannot drift from `analyze-safe-tips.js`).

**Findings (2026-07-16): zero edges, zero boosters.** Only 2 of the 8 hypotheses cleared the
volume floor and BOTH are refuted - PR-2c (confidence gap, −0.5pp at n=220) and PR-4b, the
founding contrarian thesis's sharpest form (the low-spread "consensus trap": +0.7pp, CI
[−5.4, +3.6] at n=335 - market-vs-stats agreement carries no detectable discrimination).

**The mine's most valuable output was a flaw in the ledger, not a signal in it.**
`TIP_MIN_PRICE` is a LIVE knob, and moving it 1.20 -> 1.35 on 2026-07-10 partitioned the
ledger almost exactly on the temporal-OOS boundary, so every price-correlated test was
measuring the config change (PR-4a's 414 rows all sit in train - tips under 1.30 can no
longer be generated). Hence the run-time POLICY-REGIME WARNING and `evaluatePattern`'s
"population absent from the test window" note. **Never move a generation knob mid-experiment
without recording the date.**

Two more closed questions:

- **PR-1 is CLOSED, economically REFUTED** (2026-07-16, `scripts/close-pr1-ladder-ev.js`).
  The descriptive claim held - a tip of `O 2.5` cleared `O 1.5` **85.1%** of the time against
  the tip itself landing 70.3% - but attaching `O 1.5`'s real stored price (72 of 101
  fixtures, median 1.13 against a 1.175 break-even) yields laddered flat EV **−5.9%**: class
  `unbettable`, the sub-1.20 price trap exactly as pre-registered.
- **H5, the golden-longshot spotter, is data-REFUTED and will not be built.** At >= 10x the
  ledger shows **2 wins / 153**, about −79% - favourite-longshot bias. Two positives cannot
  fit a discriminator, and the result corroborates the contrarian thesis aimed the other way.

`scripts/mine-precursors.js` is a different surface with no overlap: the 2026-07-14
Tier-A/Tier-B **warehouse** mine (203 candidates, leak-free reconstruction), rescued verbatim
from gitignored `tmp/`, read-only, about 5 minutes to run. Both study write-ups were pruned;
git history has them.

## The loader (`src/magic.js`)

A thin knex loader behind `GET /api/magic-sort`. `settledTipRows()` selects settled tips plus
a `DATE_FORMAT(kickoff)` day (grouping stays inside the pinned +03:00 SQL session) and the
final-score pair the analysis scripts need; `scripts/analyze-safe-tips.js` shares it so the
two can never drift. The loader runs `simulateStrategies`, resolves the `safe` policy object
from the `SAFE_*` config and ships it in the payload - the browser cannot read `.env`, so
shipping the resolved policy is what keeps client and server from diverging, and
`safeSelection(rows, cal, opts)` merges those opts over `DEFAULT_SAFE`. Results are memoized
per day in process; `?refresh=1` recomputes and a failed compute clears the slot.

## Knobs and the scripts that must run before you move them

| Knob | Default | Meaning |
|---|---|---|
| `SAFE_MAX_PER_DAY` | 3 | safe-pool cap per EAT day |
| `SAFE_STRATEGY` | `sure` | the pinned safe ranker (`DEFAULT_SAFE.strategy`) |
| `SAFE_MIN_PARTS` | 2 | blend components required (pinned - 3 is a double-chance confound) |
| `SAFE_MIN_AGREEMENT` | 0.65 | weakest present blend component |
| `SAFE_MAX_PRICE` | 1.6 | price ceiling |
| `SAFE_MIN_MARKET_SETTLED` | 30 | market-maturity floor for the safe pool |
| `SAFE_MIN_SAMPLES` / `SAFE_MIN_H2H` | see `DEFAULT_SAFE` | the stats-sufficiency gate |

Analysis scripts: `scripts/analyze-safe-tips.js` (LODO grid over the safe gates, mandatory
before a retune), `scripts/backtest-sure-tips.js` (full-warehouse stats-only precision +
temporal OOS + the M3 new-family anchors), `scripts/analyze-sure-live.js` (live cross-val and
ranking bake-off), `scripts/backtest-hotpicks.js` (`--line` O/U sweep),
`scripts/recon-warehouse.js` (baselines + the `odds_markets` menu).

```
estimateLegProb = bucketPosterior(tip, cal) ?? confidence, clamped [0.05, 0.98]
```

 - also the betslip playground's per-leg survival number, so the ⭐ list and the slip UI can
never disagree.

---
*Update this chapter when: a strategy is added/changed, shrinkage or `WAREHOUSE_WLO`
anchors move, `DEFAULT_SAFE`/`SAFE_TIERS`/`DEFAULT_SURE_BETS` change, the v2 menu or the leg
cells change, the Daily MultiBet card set changes, a `SAFE_*` knob moves, a mine hypothesis
is closed, or the replay ranking policy changes (`src/db/magic-rules.js`, `src/magic.js`,
`src/daily-slip.js`, `src/db/mine-rules.js`; retune gates only via
`scripts/analyze-safe-tips.js`).*
