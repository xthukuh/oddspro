# The goal model, and why beating the market is not the job

**Date:** 2026-07-26 (session 4)
**Branch:** `feat/engine-v2` - `main` untouched.
**Built:** `src/db/goal-model.js`, Banker column in the web table, demo DB stripped to
observations only, model wired through `scripts/simulate.js` as a switchable stats source.
**Tests:** 993 total, 991 pass (2 are 20 MB snapshot fixtures excluded from transfer;
170/170 verified on the dev box).

---

## 0. The demo database now contains observations only

`oddspro_demo` had `fixture_predictions`, `fixture_prematch` and `fixture_ai_insights` in it - all output of a previous engine. A simulation could in principle read one of those as if it were
data. All three are truncated. What remains is what actually happened:

| kept (observed / third-party) | rows |
|---|---|
| fixtures - scores, kickoff, venue | 33,703 |
| odds_markets - bookmaker prices | 2,973,906 |
| matches - provider ↔ fixture link | 16,244 |
| fixture_events / statistics / lineups | 22,087 |
| standings, teams, leagues | 7,635 |
| fixture_api_predictions (third-party model) | 2,037 |

`scripts/simulate.js` reads none of the dropped tables, and produces **identical numbers before
and after the truncation** - which is the proof, not the claim, that it never used them.

---

## 1. What was built

The blend's stats component asked each market a separate question: *what share of this team's last
six games went over 2.5?* Over a six-game window the answer can only be one of {0, 1/6, 2/6, …} - a seventeen-point grid - and each line was counted independently, so the engine could
simultaneously believe P(O 1.5) = 0.67 and P(O 2.5) = 0.83. That is not a noisy probability. It is
not a probability distribution at all.

`goal-model.js` asks one question - how many goals will each side score? - and reads every market
off the answer. Independent Poisson with the Dixon-Coles low-score correction; team attack and
defence estimated as shrunk exposure ratios with exponential time decay (180-day half-life);
per-league baselines that borrow from the global mean when a league is thin. Closed-form, not an
optimiser: on the 5-40 matches a team actually has here, a ratio estimator cannot silently
return a bad fit.

Three properties the empirical rates could not offer: **coherence** (P(O 1.5) ≥ P(O 2.5) by
construction), **pooling** (every goal informs every line), and **reach** (markets with no
empirical counterpart fall out for free).

---

## 2. It is a better predictor

Brier and log-loss against realised outcomes, 1,818 fixtures, model fitted fresh each day on
history strictly before that day:

| market | empirical rates | **goal model** | devigged market |
|---|---|---|---|
| O 1.5 | 0.1776 / 0.5735 | **0.1768 / 0.5445** | 0.1751 / 0.5318 |
| O 2.5 | 0.2515 / 0.7126 | **0.2493 / 0.6984** | 0.2333 / 0.6593 |
| GG | 0.2538 / 0.7046 | **0.2507 / 0.6960** | 0.2401 / 0.6728 |
| 1 | 0.2470 / 0.6933 | **0.2424 / 0.6843** | 0.2079 / 0.6014 |
| X | 0.1942 / 0.5973 | **0.1838 / 0.5540** | 0.1807 / 0.5449 |
| 2 | 0.2142 / 0.6182 | **0.2043 / 0.5978** | 0.1791 / 0.5350 |

The model beats the rates on log-loss in **9 of 10 markets**. It is a real improvement in
prediction.

**And the market beats both, on every single market.**

---

## 3. It is a worse bettor

| modelWeight | tip hit-rate | flat ROI |
|---|---|---|
| **0** (rates only) | **76.4%** | **−4.1%** |
| 0.5 | 75.0% | −6.2% |
| 1 (model only) | 75.1% | −5.7% |

Betting the model's *disagreements* with the price is worse still, and - this is the part that
settles it - **monotonically** worse:

| model minus devigged price | n | hit-rate | flat ROI | 95% CI |
|---|---|---|---|---|
| > 0.00 | 27,603 | 53.2% | −9.4% | [−11.1, −7.2] |
| > 0.05 | 16,370 | 52.7% | −9.9% | [−12.0, −7.1] |
| > 0.12 | 7,094 | 46.1% | −10.4% | [−15.1, −4.7] |
| > 0.25 | 1,440 | 34.3% | **−15.9%** | [−26.1, −6.7] |

55,234 comparisons. Every interval excludes zero. **The more strongly the model disagrees with
the price, the more money it loses.** Those disagreements are model error, not market error.

---

## 4. What this means for the engine

The price is the best available estimate of every outcome, and nothing built from this data beats
it. It follows that a more accurate stats term simply agrees with the price more often - and
agreeing with the price means paying the vig for the privilege.

The corollary is uncomfortable and load-bearing:

| blend weights (market / stats / api) | hit-rate | ROI |
|---|---|---|
| 0.6 / 0.3 / 0.1 (shipped) | 76.4% | **−4.1%** |
| 0.7 / 0.2 / 0.1 | 76.7% | −4.4% |
| 0.9 / 0.0 / 0.1 | 76.9% | −4.5% |
| 1.0 / 0.0 / 0.0 (pure market) | 76.1% | −5.6% |

**The stats component is not earning its 0.3 weight by predicting. It earns it by decorrelating
the pick from the price.** Removing it moves the selection onto the shortest prices, which carry
the most margin. Noise that pulls the engine off the favourite helps; accuracy does not.

So the model ships at `modelWeight: 0` - kept, documented, tested, and switched off. It is the
right foundation and any future work needs it. Raising that weight requires beating −4.1% on
`scripts/simulate.js --tipeval`, not an argument.

### The strategic conclusion

Three sessions of evidence now point one way. **The engine cannot win by predicting better.** The
levers that remain are the ones that do not require beating the book:

1. **Selection** - which of the markets the book offers to take. This is what the Banker does, and
   why it reaches 98.1% while the Tip sits at 76.4%: it uses the book's own best number instead of
   arguing with it.
2. **Abstention** - publishing nothing when nothing clears the bar. Already live in
   `bankerSelection`; a day with no qualifying leg prints an empty list rather than its least-bad
   one.
3. **Coherence and presentation** - never showing a user two picks that cannot both win.

---

## 5. Frontend

`Banker` is now a real column beside `Tip`: the safest market the book offers, its devigged win
probability, a ⭐ when it clears the Sure Bets bar, and the settled ✓/✗. It sorts and filters on
`tip_banker_prob` - the same number the selection ranks by and the cell displays, so all three
agree by construction.

The column reads honestly. On 2026-07-11 the Tip column shows red on rows 10, 13 and 14 while the
Banker beside them reads 83-94% and green.

---

## 6. Open

- `bestTip` accepts `modelProbs` but nothing in the live pipeline passes it - only the simulator
  does. Wiring it into `hotpicks.js` is trivial and pointless until the weight is non-zero.
- The Sure Bets **list view** (as opposed to the ⭐ marker) is not built.
- The `hot` flag still evaluates Over 2.5 in the pipeline; `hotTip()` exists but nothing calls it.
- Model hyper-parameters (half-life 180d, shrink k=4, rho −0.05) are conventional values, not
  fitted. Fitting them on 15 days would be noise. Revisit past ~60 days of ledger.
