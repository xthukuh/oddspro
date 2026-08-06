# The Banker and the ladder: why tip accuracy was capped at ~70%

**Date:** 2026-07-26
**Status:** shipped (Banker + coherence guard); two further rules built but **shipped disabled** - see §7.
**Data:** warehouse dump `oddspro_20260717_215836.sql.gz`. Live tip ledger 1,199 settled tips
(2026-07-03 → 07-17); 1,842 finished fixtures carrying stored bookmaker prices (2026-07-02 → 07-17).

This study was run from scratch, without reusing any conclusion in `docs/research/`, at the
user's explicit instruction. Where it reaches the same place as earlier work it did so
independently; where it disagrees, §7 says so.

---

## 1. Data validity

Stored odds could in principle be in-play prices, which would invalidate everything:

| | rows |
|---|---|
| odds rows with `updated_at <= kickoff` | 848,286 |
| odds rows with `updated_at > kickoff` | **4** |
| fixtures affected | 1 of 1,842 |

Prices used are genuine pre-match, specifically the **last pre-match snapshot** - the sharpest
price of the day. Live betting earlier in the day gets slightly softer numbers, so realized ROI
will run marginally below what is reported here.

---

## 2. The defect

`DEFAULT_TIP.minPrice` was doing two incompatible jobs at once: expressing "worth betting" and
expressing "safe". They are not the same predicate, and one number cannot carry both.

A safe market is priced **below** the floor precisely on the fixtures where it is **most likely
to win**. The floor therefore deletes it from candidacy exactly there, and admits it only where
the book has priced it long - i.e. where it is least likely.

Measured over the live ledger, engine-selected fixtures vs. the same market across the whole
eligible population:

| market | selected implied prob | eligible-pool implied prob | shift |
|---|---|---|---|
| U 4.5 | 75.8% | 83.0% | **−7.2pp** |
| O 1.5 | 75.7% | 79.1% | −3.5pp |
| 12 | 77.8% | 80.2% | −2.4pp |

| market | selected hit-rate | eligible-pool hit-rate | **selection skill** |
|---|---|---|---|
| U 4.5 | 70.2% | 79.6% | **−9.4pp** |
| O 1.5 | 72.0% | 75.5% | −3.5pp |
| 12 | 70.9% | 74.0% | −3.1pp |
| U 3.5 | 64.0% | 64.7% | −0.6pp |
| 1X | 72.5% | 70.2% | +2.3pp |
| O 2.5 | 71.3% | 55.5% | +15.8pp |
| X2 | 73.6% | 55.8% | +17.7pp |

**On its highest-volume markets the engine was worse than picking fixtures at random.** It has
real skill only on the *risky* markets, where the stats component differentiates and the floor
does no damage.

Scale of the loss:

| | |
|---|---|
| settled tips | 1,199 |
| tips with a **safer** market available under the floor | **1,131 (94.3%)** |
| the actual tip hit | 70.4% |
| the **blocked safest market** would have hit | **92.9%** |

Most-blocked markets: `O 0.5` (383×), `TT:A:U 2.5` (169×), `U 5.5` (168×), `TT:H:U 2.5` (77×),
`U 4.5` (69×), `O 1.5` (67×).

### The ladder

| engine tipped | its hit-rate | safer rung | rung hit-rate | offered on |
|---|---|---|---|---|
| O 2.5 | 71.3% | **O 1.5** | **85.0%** | 80/108 |
| O 2.5 | 71.3% | **O 0.5** | **98.4%** | 63/108 |
| O 1.5 | 72.0% | O 0.5 | 89.7% | 165/207 |
| U 3.5 | 64.0% | U 5.5 | **91.8%** | 122/164 |
| U 4.5 | 70.2% | U 5.5 | 84.7% | 118/151 |

---

## 3. The fix: a second output, not a changed one

The Tip keeps its floor and stays the value pick. The **Banker** is a new, separate output: the
safest market the book offers on the fixture, at its own 1.01 floor.

Safety is read off the **price**, not off our stats - because the price is better information.
The book's devigged probability is well calibrated on our own tips:

| devigged bucket | n | realized | predicted | deviation |
|---|---|---|---|---|
| 0.5-0.6 | 77 | 63.6% | 57.0% | +6.7pp |
| 0.6-0.7 | 606 | 68.5% | 65.8% | +2.7pp |
| 0.7-0.8 | 500 | 74.6% | 74.9% | **−0.3pp** |

At the short prices a banker lives at, our stats add nothing on top. The implementation does not
pretend otherwise.

### Floor sweep (1,199 settled tips, day-clustered bootstrap CIs)

| floor | hit-rate | 95% CI | avg price | ROI | 95% CI ROI | days ≥80% |
|---|---|---|---|---|---|---|
| **1.01** | **92.1%** | [90.5, 94.1] | 1.051 | **−3.6%** | [−5.4, −1.6] | **14/14** |
| 1.10 | 84.1% | [81.0, 87.2] | 1.137 | −4.5% | [−8.0, −1.0] | 10/14 |
| 1.15 | 80.5% | [77.5, 83.3] | 1.185 | −4.6% | [−8.1, −1.3] | 9/14 |
| 1.20 | 76.6% | [74.1, 78.9] | 1.233 | −5.6% | [−8.7, −2.8] | 3/14 |
| baseline tip | 70.8% | [67.7, 73.6] | 1.362 | −4.0% | [−6.1, −1.6] | 1/14 |

1.01 was the only setting to clear 80% on every replay day (worst 85.4%, median 93.5%).

---

## 4. End-to-end verification

Every tip re-derived from the warehouse through the **actual shipped code**, under the **live
`.env` config** (`TIP_MIN_PRICE=1.35`, `TIP_MIN_CONFIDENCE=0.60`, `TIP_MIN_UNDER_LINE=3.5` - note these differ from the code defaults, which is itself a finding):

| | n | hit-rate | 95% CI | avg price | ROI | 95% CI |
|---|---|---|---|---|---|---|
| Tip, before | 1,219 | 66.3% | [64.2, 68.6] | 1.435 | −5.1% | [−8.3, −1.4] |
| Tip, after | 1,219 | 66.3% | [64.2, 68.6] | 1.435 | −5.1% | [−8.3, −1.4] |
| **Banker** | 1,288 | **92.1%** | [90.5, 93.8] | 1.060 | **−2.7%** | [−4.2, −1.2] |

**The Tip is byte-identical: 1,228 of 1,228 picks unchanged.** Only the displayed alternatives
moved. The Banker is a pure addition - nothing regressed.

### The daily product

Top-10 bankers per day, ranked by devigged probability:

| | |
|---|---|
| overall | **155/160 = 96.9%** |
| perfect days | **11 of 16** |
| depth before first miss | min 1, **median 19**, mean 23.0, max 84 |

---

## 5. Coherence

The candidate set shown to the user was internally incoherent. Across the tip plus its two
displayed runners-up (3,558 pairs):

| relation | pairs | share |
|---|---|---|
| overlapping | 3,244 | 91.2% |
| **nested / identical** | 223 | 6.3% |
| **contradictory** | 91 | 2.6% |

7.3% of fixtures displayed a logically contradictory pair (`O 2.5` beside `U 2.5`, `X2` beside
`1`); 18.1% displayed a nested pair (`O 1.5` beside `O 2.5` 55×) - the same call at a different
rung, presented as an "alternative".

Incoherence is also a genuine quality signal:

| candidate set | tip hit-rate |
|---|---|
| contains a contradiction | 65.9% (n=88) |
| coherent | 71.2% (n=1,111) |

`ladder-rules.js` derives the relation lattice **from `tipOutcome` itself** over every scoreline
0-6, so the table cannot drift from how markets actually settle. After the guard, in the
end-to-end replay: **contradictory 17 → 0, nested 117 → 0.**

---

## 6. Hits vs misses

849 hits, 350 misses. Standardised effects:

| feature | hits | misses | effect |
|---|---|---|---|
| blend confidence | 0.720 | 0.708 | +0.22 sd |
| **rung gap** (tip price − safest price) | 0.303 | 0.331 | **−0.20 sd** |
| market probability | 0.694 | 0.682 | +0.20 sd |
| rolling sample size | 6.52 | 6.42 | +0.18 sd |
| stats probability | 0.773 | 0.759 | +0.14 sd |
| expected goals | 2.94 | 2.86 | +0.11 sd |
| H2H meetings | 3.07 | 3.21 | −0.07 sd (**wrong sign**) |
| API-Football probability | 0.714 | 0.711 | +0.02 sd (**noise**) |
| rank gap | 4.59 | 4.62 | −0.01 sd (**nothing**) |

No strong discriminator exists in the current feature set; the largest effect is 0.22 sd. Three
things are worth acting on eventually:

1. **`rung_gap` is new and is the strongest non-trivial feature.** Now persisted in
   `tip_breakdown` so it can be measured live.
2. **The API-Football percentage carries a 0.1 blend weight and contributes +0.02 sd.** It is
   buying noise.
3. **H2H meeting count has the wrong sign.** It is dead weight in the blend and the gate.

---

## 7. What did NOT replicate - and is therefore shipped disabled

Two rules looked strong on the live ledger and were built, tested, and then **defaulted off**
because they failed re-derivation.

### Market suppression (`12`, `U 3.5`)

| reading | 12 | U 3.5 | effect on book ROI |
|---|---|---|---|
| live settled ledger | −8.8% CI[−16.9,−1.7] (n=220) | −8.7% CI[−15.6,−1.6] (n=164) | −4.0% → **−2.2%** (better) |
| re-derived, current config | **−0.1%** (n=59) | **−0.4%** (n=165) | −5.1% → **−5.6%** (worse) |
| (everything else, re-derived) | | | −6.2% |

The sign flips. Under re-derivation these become the *best* markets, not the worst.

The live ledger spans **two config regimes** (`TIP_MIN_PRICE` moved 1.20→1.35, and
`TIP_MIN_UNDER_LINE` is 3.5 in `.env` against a 4.5 code default), which is precisely the
ledger-split trap. The re-derivation applies one config uniformly but uses history depth the
engine did not have at decision time. Neither is clean. **A result that flips sign under a
reasonable re-analysis is not a result.**

### Stats-disagreement veto

Live ledger: tips whose stats sat 0.08-0.20 below the market ran 66.7% against a 76.2% implied
(−9.6pp, ROI −12.5%, n=69). Re-derived: −5.1% → −4.9% while discarding 44 fixtures - inside the
noise.

Both mechanisms ship as configuration (`DEFAULT_TIP.suppressedMarkets` = `[]`,
`statsVetoGap` = `null`) with the evidence recorded at the definition site. **Re-test once the
ledger holds ≥800 settled tips generated under one unchanged config.**

---

## 8. On profit

**No selector tested is profitable, and none is close.** Every ROI confidence interval computed
in this study lies below zero.

The two markets that looked profitable do not survive:

| market | bootstrap 95% CI | train (first 60% of days) | test (last 40%) |
|---|---|---|---|
| X2 | [−7.4%, +16.9%] | **+15.8%** | **−9.1%** |
| O 2.5 | [−12.4%, +15.1%] | +3.0% | −0.0% |
| 1X | [−23.1%, +6.1%] | +1.8% | −29.8% |

Both flip sign out-of-sample on a 15-day, ~100-bet sample.

One hypothesis remains open and is **not** shipped as a claim: tips where stats sit well above
the market (`stats − market > +0.15`) ran +1.5% over n=303, CI [−3.0, +6.2]. Pre-register a
decision rule and re-test at n ≥ 800 before letting it touch ranking.

**The honest headline: the Banker wins far more often than the Tip (92.1% vs 66.3%) at a better
ROI (−2.7% vs −5.1%), but it is still −EV. It is a survival product, not a profit product, and
must be labelled that way everywhere it appears.**

---

## 9. Limits

- 15 days, 1,199 settled tips. Enough for the accuracy results (large effects, tight CIs);
  nowhere near enough for a profit claim.
- Prices are the last pre-match snapshot - sharper than what is actually obtainable.
- The Banker's 92.1% is measured on the engine's **eligible** population (past the
  friendly/youth and sample-size gates). It is not a claim about football generally.
- All ladder/banker results are counterfactual replays against stored prices, not live results.
- The dump predates the current warehouse by 9 days (2026-07-17 vs 2026-07-25). Re-validation
  against fresh data is outstanding.
