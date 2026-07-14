# Precursor-pattern mine — what pre-match conditions actually precede results (2026-07-14)

*A read-only, leak-free search for pre-match precursor patterns (rolling
goals/outcome aggregates, standings/form, H2H, market-derived signals,
league/day context) that reliably precede specific match results — built to
**refute** false positives, not manufacture them. Extends the prior audits
(`docs/sure-win-analysis.md`). Every number is reproducible from the scripts
named at the bottom. No warehouse table was written, no API was called.*

## One-paragraph truth

**Dozens of stats precursors genuinely beat the unconditional base rate
out-of-sample — but that is expected and worthless for betting, because it is
exactly what the bookmaker's odds already price.** When each surviving pattern
is re-tested against the *devigged market probability* and at a *bettable price*
(≥ 1.20), the edge collapses: **not one pattern family clears break-even on its
bettable slice** (best is BTTS/GG at −1.3% and 1X-strong-favorite at −0.6% flat
EV). The patterns that appear to beat the market (1X +3.6pp, U 4.5 +4.2pp,
GG +3.3pp over devig) do so only in **sub-1.20 territory you cannot profitably
bet**. The single positive live-EV market, **X2 (+6.8% over 101 settled tips)**,
has a day-clustered EV confidence interval of **[−4.5%, +23.1%] — it straddles
zero, so it is promising but statistically UNRESOLVED**, and the overall live
book is a **resolved −4.3% loser (CI [−6.9%, −1.8%])**. So the deliverable is a
handful of real **win-probability boosters** (they raise hit-rate / slip
survival and can tighten the existing `sure`/Safe-only pool) and **zero bettable
+EV edges** — confirming, not refuting, the prior audits.

## Method (built to kill false positives)

Two tiers, mirroring the project's own leak-free reconstruction
(`teamShape` mirrors `scripts/backtest-sure-tips.js`; `h2hOutcomeAggregates`
imported verbatim from `src/db/tip-rules.js`; settlement mirrors `tipHit`).

**Tier A — deep, price-blind pattern mine.** 25,952 finished fixtures;
**16,518** had leak-free history on *both* sides and were reconstructed. All
features are strict point-in-time: each team's last-7 games **before kickoff**,
vs opponents *other than* today's (the project's vs-others semantics), plus the
last-5 H2H, PPG-form gap, and league-context flag. **Candidate grid = 203
enumerated patterns** — per market: blended support ≥ T (T ∈ {0.6…0.8}),
support + concurrence (both team streams agree), support + competitive-league,
support + H2H-agreement, explicit PPG form-gap, and explicit both-teams
over/under gates. Markets: 1 / X / 2 / 1X / X2 / 12 / O1.5 / O2.5 / U3.5 / U4.5 /
GG / NG / HU2.5 / AU2.5.

Controls applied to every candidate:
1. **Leak-free** point-in-time features only (kickoff cutoff, vs-others window).
2. **Temporal OOS holdout** — train = oldest 70% (11,562 fixtures, 2011→2026-06-07),
   test = **newest 30%** (4,956, 2026-06-07→07-14). A pattern is kept only if
   test precision ≥ train − 5pp.
3. **Day-clustered bootstrap** (resample whole kickoff-dates, 1,000 draws) for a
   cluster-robust 95% CI on test precision and on the **lift over the base rate**.
4. **Multiple comparisons** — 155 of the 203 candidates cleared the volume floor
   (train ≥ 200, test ≥ 80) and were formally tested; **Benjamini–Hochberg FDR at
   q = 0.10** (rejection threshold p ≤ 0.015) applied to the bootstrap one-sided
   p-values. A pattern "survives Tier A" only if OOS holds **AND** its lift-CI
   lower bound > 0 **AND** it passes BH-FDR. **149 survived.**
5. **Baseline** — Tier A compares to the *unconditional base rate*; Tier B adds
   the *devigged market probability* (baseline that says "the odds already know").
6. **Price-aware** — Tier B (below).

**Tier B — shallow, price-aware.** The only finished fixtures with real stored
odds are those linked to a scraped bookmaker match: **1,465 fixtures over ~13 EAT
days (2026-07-02 → 07-14)**. For each surviving family I attach the **best (max)
offered price across books** (the most favourable line — deliberately optimistic,
so a negative EV here is conservative), the fixture's own **devigged market
probability** for that outcome, and the **bettable-slice (price ≥ 1.20)**
precision + flat-stake EV. Ground-truth ROI comes from the **998 live settled
tips over 12 days** (real prices, day-clustered EV bootstrap, 2,000 draws).

> **The multiple-comparison control is NOT the binding constraint here.** The
> deep warehouse gives so much power that real stats effects over the base rate
> are hugely significant (bootstrap p ≈ 0). The binding constraint is **price**:
> Tier B is where almost all of the 149 "survivors" die.

## Surviving patterns — Tier A OOS meets Tier B price

Distinct families (base/concurrence variants that select the same set are
collapsed). *Test* = OOS precision; *lift CI* = day-clustered 95% CI of lift over
the unconditional base rate; *devig* = mean devigged market prob on the priced
slice; *lift/mkt* = precision − devig; *bett EV* = flat-stake EV on the ≥1.20
slice.

| # | Precursor family | Mkt | Base | Train | **Test (OOS)** | Lift-CI /base | Priced n | Prec | Med price | Devig | Lift /mkt | Bettable EV | Class |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1X support ≥ 0.8 | 1X | 67.6% | 80.5% | **83.6%** | +16.0 [13.1,19.3] | 180 | 84.4% | 1.16 | 80.8% | **+3.6pp** | −0.6% | **Booster (sub-1.20)** |
| 2 | Home PPG-gap ≥ +1.0 → 1X | 1X | 67.6% | 79.9% | **83.2%** | +15.5 [11.2,18.6] | 187 | 82.4% | 1.17 | 78.1% | **+4.3pp** | −8.9% | **Booster (sub-1.20)** |
| 3 | O 2.5 support ≥ 0.75, competitive | O2.5 | 58.5% | 65.8% | **73.4%** | +14.9 [11.8,19.1] | 150 | 68.0% | 1.34 | 69.2% | −1.2pp | −6.3% | **Booster (marginal)** |
| 4 | U 3.5 support ≥ 0.7 | U3.5 | 61.5% | 75.2% | **71.2%** | +9.7 [7.9,11.3] | 590 | 72.4% | 1.33 | 69.6% | **+2.8pp** | −3.8% | **Booster** |
| 5 | AU 2.5 (away<3) support ≥ 0.75 | AU2.5 | 81.8% | 88.1% | **87.0%** | +5.2 [4.1,6.5] | — | — | (no fresh book / ~1.1x) | — | — | — | **Paper booster, unbettable** |
| 6 | U 4.5 support ≥ 0.8 | U4.5 | 78.2% | 87.6% | **84.7%** | +6.5 [5.2,7.6] | 618 | 85.3% | 1.15 | 81.1% | **+4.2pp** | −5.4% | **Booster (sub-1.20 trap; live loser)** |
| 7 | X2 support ≥ 0.8 | X2 | 55.8% | 66.9% | 69.8% | +14.0 [11.3,17.6] | 185 | 69.2% | 1.31 | 70.5% | −1.3pp | −10.1% | **Re-finds market** |
| 8 | 12 support ≥ 0.8 | 12 | 76.6% | 77.9% | 79.2% | +2.6 [0.7,4.6] | 572 | 76.9% | 1.23 | 77.6% | −0.7pp | −6.3% | **Re-finds market; live −10.3% loser** |
| 9 | Away PPG-gap ≥ +1.0 → X2 | X2 | 55.8% | 65.4% | 73.6% | +17.8 [12.7,23.3] | 165 | 68.5% | 1.25 | 71.7% | −3.2pp | −13.4% | **Re-finds market** |
| 10 | GG (BTTS) support ≥ 0.6 | GG | 55.5% | 55.2% | 64.2% | +8.7 [6.9,10.7] | 473 | 63.2% | 1.56 | 60.0% | **+3.3pp** | −1.3% | **Booster; best bettable EV (still −)** |
| 11 | 2 (away win) support ≥ 0.65 | 2 | 32.4% | 54.9% | 58.3% | +25.9 [20.5,31.8] | 92 | 50.0% | 1.65 | 57.4% | **−7.4pp** | −24.2% | **Stats WORSE than market** |

Rows 1–2 are the same underlying signal (strong home favourite); 5/6 the same
(deep-Unders). Row 11 is a warning: on *away* favourites the rolling-stats
support is **below** the devigged market — the market prices away form better
than our aggregates do, so a naive "high away support" gate would lose money
faster than blind betting.

### The price test, in one line per family

Every family's **bettable slice (≥ 1.20) flat EV is negative** — best GG −1.3%,
1X −0.6%. The families that beat the *devigged market* (1X +3.6pp, U 4.5 +4.2pp,
GG +3.3pp, U 3.5 +2.8pp) all carry a **median price ≤ 1.33 and their lift lives
below 1.20**; restrict to the bettable slice and the lift is gone.

## Live ground truth (998 settled tips, day-clustered EV CI)

| Market | n | Hit% | Flat EV | **EV 95% CI** | P(EV ≤ 0) | Read |
|---|---|---|---|---|---|---|
| 12 | 210 | 70.0% | −10.3% | **[−18.8%, −3.9%]** | 0.998 | **resolved LOSER** |
| O 1.5 | 187 | 71.7% | −5.4% | [−13.6%, +1.0%] | 0.945 | likely loser |
| U 4.5 | 138 | 70.3% | −7.8% | [−14.2%, +3.1%] | 0.905 | likely loser |
| U 3.5 | 116 | 65.5% | −6.7% | [−17.5%, +4.2%] | 0.886 | likely loser |
| 1X | 100 | 74.0% | −4.3% | [−22.5%, +11.3%] | 0.684 | unresolved, ~flat |
| **X2** | 101 | 76.2% | **+6.8%** | **[−4.5%, +23.1%]** | 0.150 | **positive but UNRESOLVED (CI spans 0)** |
| O 2.5 | 88 | 71.6% | +1.6% | [−16.1%, +16.6%] | 0.398 | ~zero |
| **ALL** | 998 | 71.4% | **−4.3%** | **[−6.9%, −1.8%]** | 1.000 | **whole book a resolved net loser (the vig)** |

X2's positive point estimate matches the earlier hit-rate-based finding, but the
**day-clustered EV interval includes zero** — with only ~13 correlated days it is
not yet an established edge. The whole book being a resolved −4.3% loser is the
honest headline.

## Verdict

### (i) Genuine WIN-PROBABILITY boosters (raise hit-rate / slip survival)

These hold OOS with CI-confirmed lift over the base rate and are worth folding
into the existing `sure`/Safe-only pool as **eligibility/ranking gates** (they do
**not** add profit — they raise the *probability* a leg lands, which is exactly
what `sure` and the Safety-Net protocol optimize):

1. **Strong-home-favourite gate — OOS 1X 83.2% (n=475), lift +15.5pp
   [+11.2, +18.6]; even +3.6pp over the devigged market.** Trigger: home last-7
   PPG − away last-7 PPG **≥ 1.0**, equivalently blended 1X support ≥ 0.8.
   *Concrete gate:* in `src/db/magic-rules.js`, extend `safeQualifies` /
   `hasSufficientStats` to admit (or up-rank) double-chance-home legs when the
   form-gap ≥ 1.0 — the aggregates already exist via
   `teamOutcomeAggregates`. Raises 1X leg survival ~68% → ~83%.
2. **Competitive-league O 2.5 gate — OOS 73.4% (n=590), lift +14.9pp
   [+11.8, +19.1]** on the one result-Over with non-negative live EV (+1.6%).
   *Concrete gate:* require `!TIP_CONTEXT_EXCLUDE(league)` **and** both teams'
   over-2.5 rate ≥ 0.75 before an O 2.5 leg enters the Safe pool — this is
   essentially the existing `scoreOver25` hot-pick `hot` flag; wire it into the
   pool's O 2.5 eligibility.
3. **Deep-Under gate — OOS U 3.5 71.2% (n=1892), lift +9.7pp [+7.9, +11.3];
   +2.8pp over the devigged market.** *Concrete gate:* admit U 3.5 legs only at
   blended U 3.5 support ≥ 0.7 (raises 61.5% → 71%).
   *Honourable mention (do NOT ship):* AU 2.5 ≥ 0.75 (87.0% OOS) and U 4.5 ≥ 0.8
   (84.7% OOS) have the **highest paper precision of all**, but their price sits
   at ~1.1–1.15 (unbettable) and U 4.5 is a live loser — the classic
   "precise-but-sub-1.20" trap. Paper boosters only.

### (ii) Any genuine BETTABLE +EV edge? **No — confirmed, not refuted.**

- **No precursor family clears break-even on its bettable (≥ 1.20) slice.** The
  closest are GG (−1.3%) and 1X-strong-favourite (−0.6%) — both still negative
  even using the *best* price across books.
- The only positive *live* EV is the **X2 market (+6.8%)**, but its day-clustered
  EV CI **[−4.5%, +23.1%] includes zero** → promising, **unresolved**. And note
  the value in X2 lives at the *higher-priced* end: the high-stats-support X2
  precursor pushes toward the cheap sub-1.20 tail where its own bettable EV is
  **−10.1%**. A future "value" sort would target *mid-priced* X2/O 2.5, not high
  stats support.
- The overall live book is a **statistically resolved −4.3% net loser**, and
  **12 is a resolved −10.3% loser** — the biggest-volume trap, exactly as
  `docs/sure-win-analysis.md` reported.

## Sample-size caveats (read before acting)

- **Tier A (stats precision) is well-powered** — 16,518 leak-free fixtures back
  to 2011; the boosters' OOS lift is robust to day-clustered resampling.
- **Tier B (price / EV) is thin** — the odds window is **~13 EAT days
  (1,465 fixtures)** and the live ROI sample is **998 tips / 12 days**. Per-family
  priced n ranges 83–618; per-day legs are correlated. X2 and O 2.5 cannot be
  resolved as +EV or −EV without deeper price history.
- The OOS *test* window (Jun 7 – Jul 14 2026, ~5 weeks) shares season/round
  structure with the train tail; it proves temporal *stability*, not the absence
  of all selection bias. The strongest anti-overfit evidence remains the
  **monotone precision ramp across thresholds** (higher support → higher
  precision, every market), which noise cannot fake.
- Best-price-across-books was used for EV — optimistic. That every bettable slice
  is still −EV only strengthens the "no edge" conclusion.

## Reproduce

```
node tmp/precursor-probe.mjs      # data volumes
node tmp/precursor-mine.mjs       # Tier A (OOS + day-clustered CI + BH-FDR) + Tier B price attach
node tmp/precursor-ev-ci.mjs      # day-clustered bootstrap CI on live per-market EV
```
(Analysis scripts live in `tmp/` — gitignored, read-only. They reuse
`src/db/connection.js`, `src/db/tip-rules.js`, `src/markets.js`,
`src/apisports.js` verbatim.)
