# Sure-Win analysis — what the data actually says (2026-07-13)

*A full visual + warehouse + live-odds study of our prediction accuracy, the
adversarial data-science review that corrected it, and the changes shipped.
Numbers are measured from our own warehouse (24,210 finished fixtures) and the
838 live settled tips over 2026-07-03 → 07-12. Re-run the scripts named below
before trusting any figure as the sample grows.*

> **⚠ CORRECTION (2026-07-14).** A fair, **selection-bias-corrected** re-test on a
> pre-selection board (22,213 fixture×market rows, not just tipped games), robust
> to out-of-sample recalibration and recency-aware (timeliness) stats, **refutes
> the "X2 +EV" finding below** (§"What actually wins"). On the fair board X2 is
> **−12.8% flat-stake EV**, and its tipped Wilson floor (67.1%) is now *below*
> break-even (70.1%) → **unresolved, not +EV**. Treat every "+EV" / "established
> +EV" / "X2 (+) resolved" statement below as **SUPERSEDED — no market is
> positive-EV.** See `docs/fair-comparison-and-false-positives.md` and
> `docs/data-independence.md`. The rest of this study (no +EV sure-win; the
> price-blind precision trap; `sure` = win-probability, not profit) **stands and
> is reinforced.**

## The one-paragraph truth

**There is no positive-EV "sure-win" on these markets, and the data proves it.**
The bookmaker is efficient exactly where you can bet: the markets with the
highest *precision* (near-certain Unders, team totals) are priced below our 1.20
floor, and the slice that clears the floor has ~zero edge. Even the best-designed
selection is about **−3% flat-stake EV** — the vig. What we *can* do, and now do,
is **rank by what genuinely wins on real odds and hide the thin-evidence bets**,
which maximizes hit-rate and slip survival and stops us from over-betting the
proven losers. That is a real, honest improvement — not a money printer.

## How the study was run

1. **Visual pass** — browsed each date 07-05 → 07-13 in the app, screenshots in
   `tmp/sure-win/`. Confirmed the shape; the rigorous per-date analysis is the
   `scripts/recon-warehouse.js` table below (more reliable than eyeballing).
2. **Warehouse baselines** — `scripts/recon-warehouse.js`: marginal hit-rate of
   every settle-able market over 24,210 finished fixtures + the real
   `odds_markets` menu + the thin-evidence population.
3. **Stats-only pattern search** — `scripts/backtest-sure-tips.js`: replay all
   15,096 fixtures with leak-free rolling/H2H aggregates, per-market precision +
   Wilson lower bound + a temporal train/test split.
4. **Live cross-validation** — `scripts/analyze-sure-live.js` +
   `scripts/analyze-safe-tips.js`: the same markets/gates on the 838 live settled
   tips where **real prices** exist (the only place ROI is measurable).
5. **Adversarial review** — a 5-agent data-science workflow queried the linked
   odds and killed a trap (below). Its verdicts are in
   `tmp/sure-win/review-synthesis.txt`.

## What the warehouse said (and why it was a trap)

Stats-only, the "unbeaten patterns" over 15,096 fixtures looked spectacular and
held out-of-sample (train 70% → test newest 30%):

| Market | OOS precision (wLo) | Looked like |
|---|---|---|
| AU 2.5 (away <3 goals) | 87.1% (85.6) | the holy grail |
| U 4.5 (total <5) | 85.3% (83.6) | rock solid |
| O 1.5, HU 2.5, 1X, 12, U 3.5 | 76–83% | all "safe" |

**The trap (the review's central finding, on ~1,000 linked matches with real
stored odds):** precision without price is meaningless. AU 2.5 hits 81% overall
but its **median offered price is 1.11** and only 34% of games clear the 1.20
floor. The *bettable* slice (price ≥ 1.20) hits **64.3%** vs the market's own
devigged **64.0%** — a **+0.4pp edge, i.e. zero**, at **−9.4% ROI**. The 87%
lived entirely in sub-1.20 games you cannot profitably bet. Team-total Unders and
BTTS are the same story or worse (BTTS is efficiently priced, ~−6% ROI).

> Ranking markets by warehouse precision would systematically **up-weight the
> money-losers**. The static `safePrior` table built that way was scrapped.

## What actually wins (live, on real odds — 838 tips)

| Market | live hit | ROI | verdict |
|---|---|---|---|
| **X2** (n=67) | 83.6% | +15.2% | ~~Wilson floor 72.9% > break-even → only established +EV~~ **SUPERSEDED 2026-07-14: fair-board X2 −12.8% EV, tipped Wilson floor 67.1% < break-even 70.1% → unresolved, NOT +EV (see top banner)** |
| O 2.5 (n=75) | 74.7% | +5.3% | promising, unresolved |
| 1X (n=87) | 78.2% | +0.2% | marginal, unresolved |
| **12** (n=192) | 71.9% | **−8.3%** | Wilson ceiling 77.8% < break-even → **established −EV, our biggest-volume loser** |
| O 1.5 / U 3.5 / U 4.5 | 64–73% | −6 to −10% | warehouse-high, **live losers** |

The **market-blend result markets win**; the price-blind "high-precision" Unders
lose. The 0.6-weight devigged-odds component adds edge the stats-only warehouse
can't see: X2 warehouse 70% → **live 84%**; U 4.5 warehouse 87% → **live 69%**.

Also live-confirmed: **sufficient-stats tips beat thin ones (74.8% vs 70.7%)**,
**3 blend components beat 2 (76.0% vs 70.9%)**, agreement sweet-spot **0.65–0.70**.

## What shipped

### 1. `sure` — the default sort ("Most likely to win")
`src/db/magic-rules.js`: a new `STRATEGIES` entry, seeded as the default sort
(`web/src/App.jsx` `_loadSort`; existing user chains preserved).

```
sure_score(tip, cal) = safePrior(tip.market, cal) × tip.confidence
safePrior(m, cal)   = (liveHits[m] + k·WAREHOUSE_WLO[m]) / (liveN[m] + k),  k = 20
```

`safePrior` is the market's **live** hit-rate beta-shrunk toward its warehouse
anchor. This *resolves the reversal*: X2's weak warehouse (0.669) shrinks **up**
to ~0.80 from its strong live 83.6%; U 4.5's strong warehouse (0.868) shrinks
**down** to ~0.72 from its weak live 69.3%. So the sort favours what wins on real
odds and **self-corrects as data grows** — no manual market blacklist. In the
leave-one-day-out bake-off it lifted top-3 daily precision **76.7% → 93.3%** and
gave the **best streak of every strategy (avg 4.2, best 10 straight from the
top)**. Swapping the Safe-pool ranker `market → sure` lifted its leg-rate
**81.5% → 88.9%** at the same volume.

### 2. Risk gate — "Hide risky games" (auto-applied, tunable)
`hasSufficientStats()` (shared server+client) drops thin-evidence fixtures
(rolling sample / H2H below the safe policy floors, or no tip) whenever a magic
sort or Safe-only is active. Default ON, shows a "✓ Sufficient stats" subset
pill, tunable via Settings → *Min form games* / *Min H2H games*
(`SAFE_MIN_SAMPLES` / `SAFE_MIN_H2H`).

### 3. Three risk tiers
`SAFE_TIERS` presets (Settings → Tier): **max-precision** (agree≥0.72, price≤1.5,
2/day) · **balanced** = the shipped default, zero regression · **volume**
(agree≥0.60, price≤2.0, 5/day). Only agreement/price/per-day vary — `minParts`,
`minSamples`, `minH2H` are pinned (varying `minParts` to 3 is a double-chance-only
confound that starves the pool).

### What did NOT ship (and why)
- **Team-total Unders (AU/HU) + BTTS (GG/NG) tips** — unanimous −EV on real odds
  (precision is a sub-1.20 mirage; bettable slice ~0 edge, −6 to −9% ROI). The
  settlement math is correct and documented; if ever revisited it needs a
  per-team scored-over aggregate, its own `marketGroup`, a `markets.js` registry
  entry, and — non-negotiable — **live break-even confirmation, never warehouse
  precision.**
- **Draw-No-Bet** — a draw is a push; the hit/miss enum can't hold a void
  (naive push=miss distorts ROI from −5% to −31%).

## Honesty notes / caveats (read before betting)
- `sure` maximizes **win probability / slip survival, not profit.** Overall
  flat-stake EV ≈ **−3.2%**. A 3-fold of ~−6% legs is ~−17% EV even at high leg
  survival. **Never treat this as +EV.** A true value product would be a separate
  "value" sort (edge = conf×price−1) concentrated on X2/O 2.5.
- The live sample is **~10 days / 838 tips**; per-market n < 130 for most. Only
  **X2 (+)** and **12 (−)** are statistically resolved. Keep `k ≥ 20`
  (warehouse-dominant) until > 30 replay days; keep slips **2–3 legs** (safePrior
  depth is noisy; parlay survival is overstated because same-day legs correlate).
- The temporal train/test split proves **stability**, not the absence of
  selection bias (gates were scanned on the full grid; 360-cell multiple
  comparisons). The real anti-overfit evidence is the **monotone-across-thresholds
  ramp**, independently verified.
- The safest realistic use is still the **Safety Net Protocol**
  (`docs/safety-net-protocol.md`): flat 1–2% stakes, 2–3 leg slips, never chase.
  `sure` makes the top of that pool better; it does not change the arithmetic.

## Reproduce
```
node scripts/recon-warehouse.js       # baselines + market menu + thin population
node scripts/backtest-sure-tips.js    # warehouse stats-only precision + OOS split
node scripts/analyze-sure-live.js     # live sufficiency + ranking bake-off
node scripts/analyze-safe-tips.js     # safe-gate grid incl. the 'sure' ranker (weekly)
```
