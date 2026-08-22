# Visual investigation: 15 days, 1,199 tips, row by row

**Date:** 2026-07-26
**Method:** a full local instance of oddspro (restored warehouse, production `.env` engine knobs,
signed in as admin for ungated data), driven through its own UI, plus seven parallel agents each
inspecting every settled row on their assigned dates.
**Ledger:** 1,199 settled tips, 2026-07-03 → 07-17. 1,842 finished fixtures carry real pre-match prices.

---

## 0. Two things that had to be fixed before any number meant anything

**The pipeline could not be refreshed.** No route exists from this sandbox to api-sports or the
bookmakers - verified, not assumed. The warehouse is the 2026-07-17 dump. Everything below is
that window.

**`.env` silently overrides the code defaults, and by more than I knew.** Production runs:

| knob | production | code default |
|---|---|---|
| `TIP_MIN_PRICE` | **1.35** | 1.20 |
| `TIP_MIN_CONFIDENCE` | **0.60** | 0.50 |
| `TIP_MIN_UNDER_LINE` | **3.5** | 4.5 |
| `HOTPICK_TEAM_WINDOW` | **6** | 7 |
| `SAFE_MIN_PARTS` | **3** | 2 |
| `SAFE_MIN_AGREEMENT` | **0.70** | 0.65 |

The local instance was configured from the production file so the engine under study is the
engine you actually run. Two of these deserve their own note:

- **`SAFE_MIN_PARTS=3` contradicts the code.** `magic-rules.js` pins it at 2 and states why:
  *"parts==3 is a double-chance-only confound (O/U tips carry no api part), which starves the
  pool."* Running 3 in production means your Safe pool is structurally restricted to
  double-chance tips. That is almost certainly not what you intended.
- **`TIP_MIN_UNDER_LINE=3.5`** re-admits `U 3.5`, which the code default excludes.

---

## 1. The ledger's biggest day is a different engine

**2026-07-04 is 268 of 1,199 tips (22%) and 81 of them are friendlies/youth fixtures the context
gate now blocks.** The gate shipped on 07-05 and has been perfect since:

| date | tips that leaked through | correctly skipped |
|---|---|---|
| 2026-07-04 | **81** | 0 |
| 2026-07-05 → 07-19 | **0** | 397 |

One agent flagged this as a live bug. It is not - the regex matches, the gate fires. But it means
**every pooled statistic over this ledger is 22% contaminated by a pre-gate regime**, and those
friendly tips ran 65.0% at −17.7% ROI. All headline numbers below exclude 07-04.

**Current-engine baseline: 931 tips, 14 days, 70.0% hit-rate, −3.1% flat ROI.**

---

## 2. Your hunch was right, and it is the best thing in the data

You said: *fixtures showing `2:O 2.5` or `3:O 2.5` or `O 3.5` tend to go over 1.5, so the safest
tip should have been `O 1.5`.* Those `2:` / `3:` prefixes are runner-up ranks. So the claim is
about the **candidate set**, not the pick.

It is correct, at a scale that surprised me:

| | fixtures | went over 1.5 |
|---|---|---|
| candidate set contains `O 2.5` or `O 3.5` | 504 | **84.1%** |
| it does not | 695 | **71.1%** |

Six of seven agents tested it independently. Four confirmed it, two killed it on single days; the
full ledger settles it at p < 1e-5. **The signal lives in the runners-up, not in the tip** - when
the tip itself is an Over, the effect vanishes. A candidate set that reaches up the ladder and
then settles somewhere else is describing a goal-rich fixture, and the engine was computing that
and throwing it away.

Betting the bottom rung on the signal (current-engine regime, day-clustered 95% CIs):

| bet | n | hit-rate | flat ROI | 95% CI |
|---|---|---|---|---|
| `O 1.5` blind on every tipped fixture | 841 | 74.8% | −5.0% | [−8.3, −2.3] |
| **`O 1.5` when the set reaches up** | 356 | **83.1%** | **−2.3%** | [−8.0, +2.9] |
| **...and `O 1.5` is not itself a candidate** | 305 | **84.6%** | −2.5% | [−7.5, +2.5] |
| `O 1.5` when the set does NOT reach up | 485 | 68.7% | **−7.0%** | [−12.3, −4.0] |

**+9.8pp of accuracy and +2.5pp of ROI over betting `O 1.5` blind.** The ROI CI still spans zero,
so this is a reliability gain, not a proven edge - but the *inverse* is firm: when the set does
not reach up, an Over is a confidently bad bet (CI excludes zero).

Out-of-sample it degrades but keeps its sign: train 87.8%, test 81.2%.

---

## 3. The most reliable thing the engine can produce

Ranking each day's picks safest-first and taking the top N:

| construction | whole pool | top-3/day | top-5/day | perfect days | ROI (top-5) |
|---|---|---|---|---|---|
| engine tip (today) | 70.0% | 83.3% | 81.4% | 5/14 | +4.9% |
| banker (safest offered) | 92.6% | 97.6% | 97.1% | 12/14 | −1.8% |
| **banker, on goal-rich fixtures** | 91.3% | **100%** | **100%** | **13/13** | **+1.2%** |
| ladder `O 1.5` | 83.1% | 94.9% | 92.3% | 10/13 | +0.1% |

**Banker top-5 on goal-rich fixtures went 65/65 across 14 days - a clean sweep every single day - and it holds in both halves of a temporal split (train 35/35, test 30/30).**

Per day:

```
07-05  5/5   07-06  5/5   07-07  5/5   07-08  5/5   07-09  5/5
07-10  5/5   07-11  5/5   07-12  5/5   07-13  5/5   07-14  5/5
07-15  5/5   07-16  5/5   07-17  5/5   07-03  1/1
```

**Three honest caveats, all of which matter:**

1. **Average price is 1.010.** These are the floor. As a reliability demonstration it is
   remarkable; as an income stream it is nearly worthless on its own.
2. **The goal-rich filter's incremental value is two fixtures.** Banker top-5 unfiltered was
   68/70; the filter turns 2 misses into 0. That difference is not statistically established.
   The reliable finding is **banker top-N ≈ 96-97%**; the filter is a plausible refinement to
   monitor, nothing more.
3. Selected from ~18 construction × N combinations. 65/65 has a naive p ≈ 0.007 and a
   multiplicity-corrected one around 0.12.

The markets it actually picks are `O 0.5`, `TT:A:U 2.5`, `TT:H:U 2.5`, `U 5.5`, occasionally
`1X`/`X2` - i.e. "at least one goal", "the away side won't score three".

---

## 4. Where the engine is actually losing money

One cell has a confidence interval that excludes zero on the losing side:

| | n | hit-rate | flat ROI | 95% CI |
|---|---|---|---|---|
| **UNDER-direction tip with `h2h_n ≥ 5`** | 154 | **63.6%** | **−10.7%** | **[−25.5, −3.9]** |

Suppressing just that cell moves the whole book from −3.1% to **−1.7%** - the largest single
improvement found in either session.

**The mechanism was verified, not assumed.** One agent measured the H2H goal average as a
predictor of actual total goals: MAE **1.79 for H2H history** vs **1.55 for rolling form** vs
**1.65 for simply guessing the league mean**. On the rich-H2H subset, H2H is *worse than a
constant* - yet that is exactly the subset where the blend gives it weight. The engine is
weighting its least informative input most heavily where it has most of it.

By direction overall (current regime): OVER 72.2% / **+0.6%** · UNDER 68.3% / −3.8% ·
RESULT 69.7% / −5.8%. Only the UNDER+rich-H2H intersection clears significance; blanket UNDER
suppression does not, on this window.

---

## 5. What the agents found that did NOT survive

Reported so nobody re-mines them:

- **Ladder position** (`tip is / is not the safest rung of its own family`). Looked like the
  finding of the study on 07-04: 82.4% vs 63.8%, p=0.0040. On the full ledger it is
  **73.1% vs 68.3%** with heavily overlapping CIs. A one-day artefact.
- **The `stats_prob` "dead zone" [0.70, 0.81)** - 52.2% vs 74.5% on 07-12, replicating inside
  every partition that agent could build. Does not generalise.
- **Confidence-gap / decisiveness** (tip minus runner-up #1). Strong and monotone on 07-05
  (87.5% → 57.7%), flat or reversed on four other agents' dates.
- **Candidate-set coherence and directional agreement.** Six agents, all null. One found why:
  the top-3 is empirically a **hedge set, not a consensus set** - when both runners-up miss, the
  tip hits 86.1%; when both hit, the tip hits 61.7%. Asking "do the candidates agree?" is the
  wrong question of this structure.
- **Form-string shape, rank gap, kickoff hour, round, menu size, provider divergence.** Null in
  every report. Cross-provider price divergence on the tip market was ≥8% on **zero** of 117
  two-provider fixtures - BetPawa and Betika are effectively one book.
- **Thin-day vs big-card performance.** Within price regime, ≤1.5pp. Nothing.

---

## 6. Genuine defects worth fixing, found by reading rows

1. **The engine contradicts itself on the same row.** `hot = true` (over-2.5 gate passed) while
   the tip is an Under. HK Kopavogur - IR Reykjavik 07-14: `hot` fired, tip was `U 4.5` @1.39,
   final 5-1. Lansing City - Flint City 07-07: `hot_score` 0.84, tip `U 5.5`, final 2-6. Nothing
   in `bestTip` reads `hot`.
2. **`stats_prob` reaches exactly 1.000 off five games and is never shrunk.** Petrocub - Milsami
   `U 3.5` at stats 1.000 → 5-0. Crvena Zvezda - Macva `U 4.5` at stats 1.000 → 5-0. Mjallby - Vasteraas
   `TT:A:O 0.5` at stats 1.000 → 0-0. A 5-game sample should never assert certainty; every other
   rate in the codebase is beta-shrunk, this one is not.
3. **The blend does not read a blowout price as a warning.** West Torrens Birkalla - Para Hills
   07-17: favourite priced **1.05**, away side LLLLL having conceded 34 in 5 - tip `U 5.5`, final
   **11-0**. Where the shortest 1X2 price is under 1.20, mean total goals is 4.25 against 2.3-3.4
   everywhere else, and the engine tipped an Under on 11 of 12 such fixtures.
4. **Form strings carry non-W/D/L characters.** `"WOWOWOWL"`, `"LOLLOWL"` in MLS Next Pro / USL - shootout results, lengths 1 to 8. Anything downstream assuming 5×W/D/L will misparse.
5. **`12` is adversely selected onto draws.** Fixtures tipped `12` carry mean implied draw
   probability 0.277 vs 0.243 elsewhere, and realized 31.6% vs 23.9%. Substituting the double
   chance covering the market favourite on the same fixtures: +10.5pp, ROI −11.8% → +1.0%.
6. **Fixture 1525244** (Christos - Loudoun 2, 07-08) exists in `fixture_predictions` but never
   appears in `/api/records` on any date. A linking or read-layer gap.

---

## 7. What I would do differently

In descending order of evidence.

**Ship now**

1. **Expose the goal-rich ladder as its own pick.** `reachesUpTheLadder()` + `ladderPick()` are
   implemented and tested. 84.6% at −2.5% against the tip's 70.0% at −3.1%.
2. **Suppress UNDER tips when `h2h_n ≥ 5`.** Only cell whose CI excludes zero. Book goes −3.1% →
   −1.7%. Mechanism verified independently.
3. **Fix `SAFE_MIN_PARTS` in production.** It is 3; the code pins 2 and documents why 3 starves
   the pool.
4. **Sure Bets = banker top-N, not the current `sure` ranking.** 97% at N=5 versus 81%.

**Fix the defects in §6** - each is cheap and two of them (self-contradiction, unshrunk 1.000)
are visibly indefensible to anyone reading a row.

**Stop doing**

5. **Drop the API-Football component.** +0.02 sd on hit/miss for a 0.1 blend weight, and it is
   perfectly collinear with market family (present on every result tip, absent on every O/U tip).
6. **Re-weight or drop H2H.** Worse than a constant at predicting totals on the subset where it
   carries most weight.

**Measure, do not ship**

7. Everything in §5. And re-test §2's ROI once the ledger holds ≥800 tips under one unchanged
   config - with `TIP_MIN_PRICE` having moved twice inside this window, no price-correlated
   result here is safe to pool.

---

## 8. The honest summary

The engine's ranking works - top-3 by day beats bottom, tip beats runner-up #1 beats runner-up
#2, consistently. What it lacks is a *reliable* product, and that turns out to be sitting in data
it already computes and discards: the shape of its own candidate set, and the bottom rung of the
ladder it climbed past.

**No configuration tested is positive-EV.** The best achievable on this window is roughly −1.7%
on the tip book and 96-97% reliability on a top-5 banker list priced near 1.01. Your instinct
about `O 1.5` was the single most productive lead in either session - it is real, it replicates,
and it is worth ~10pp of accuracy. It is not free money, because the book has already read most
of it into the price.
