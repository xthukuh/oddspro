# Walk-forward simulator, banker tiers, and why 100% is a trap

**Date:** 2026-07-26 (session 3)
**Built:** `oddspro_demo` database, `scripts/simulate.js`, banker probability tiers,
stats beta-shrink, re-pointed 🔥 flag, 28-key `.env`.
**Tests:** 986/988 (the 2 are 20 MB snapshot fixtures excluded from transfer; 163/163 and
104/104 verified green on the dev box).

---

## 1. What was built

**Demo database.** `oddspro_demo` - full clone of the restored warehouse (33,703 fixtures,
2.97M odds rows). All simulation runs against it; nothing touches the live schema.

**`scripts/simulate.js` - the honest replay.** Every prior measurement in `docs/research/`
read the *stored* tip rows, which were written across at least two config regimes, and then
chose parameters by looking at the same data it scored. The simulator closes both holes:

- **Re-derives** every tip and banker from the pure rules, so one config applies uniformly.
- **Pre-kickoff odds only** (`om.updated_at <= f.kickoff`) - the in-play guard.
- **`--walk-forward`** re-picks the policy each day from prior days only, then scores the day
  it has never seen. That is the parameter leak, and it is the one that matters.

---

## 2. The frontier

Uniform config, no hindsight, 16 days:

| policy | legs/day | leg accuracy | all-green days | ROI |
|---|---|---|---|---|
| banker, fixed top-10 | 10 | 98.1% | 13/16 | −0.7% |
| prob ≥ 0.90 | 44.6 | 95.4% | 3/16 | −2.9% |
| prob ≥ 0.93 | 10.1 | 98.1% | 13/16 | −0.6% |
| **prob ≥ 0.95** | **2.2** | **100%** | **10/10** | **+1.1%** |

**Walk-forward** (threshold chosen only from prior days): **62/64 legs = 96.9%, 8/10 all-green
days, ROI −1.9%.**

### Why 100% and "replenish funds" pull in opposite directions

At prob ≥ 0.95 the average price is **1.0114**.

| | |
|---|---|
| measured | 22 legs, 22 hits, **+1.14%** |
| with one more loss | **−3.46%** |
| a single miss costs | **88 wins** |

The 100% is *"no loss yet"*, not an edge. Twenty-two bets is roughly ten days of exposure at
this threshold; the first loss erases three months of them. Pushing the threshold higher makes
this strictly worse, because the price falls faster than the accuracy rises.

The three red days at N=10 each lost exactly one leg: a 0-0 in Queensland NPL, a seven-goal
Champions League tie, five goals in Botola Pro. There is no feature that predicts a specific
0-0. This is the irreducible floor, not a tuning failure.

**This is why I did not tune until the backtest read 100%.** Any parameter set that produces a
perfect 16/16 on 16 days of data is describing those 16 days, not football.

---

## 3. Changes shipped

### `BANKER_TIERS` - a probability bar, not a fixed list length

```
reliability  minProb 0.95   ~2 legs/day    100%    (shipped default)
balanced     minProb 0.93  ~10 legs/day   98.1%
volume       minProb 0.90  ~45 legs/day   95.4%
```

A fixed top-10 forces the tenth-best leg onto the slip on a thin day. A threshold simply prints
fewer legs, and prints **nothing** on a day where nothing qualifies. That behaviour is now a test.

### Stats beta-shrink (`DEFAULT_TIP.statsShrinkK = 5`)

Every other rate in the codebase is shrunk; this one was not, so a five-game window could assert
`stats_prob = 1.000`. Three such tips lost outright (Petrocub - Milsami 5-0, Crvena Zvezda - Macva
5-0, Mjallby - Vasteraas 0-0). Chosen by A/B, not taste:

| k | hit | ROI | OVER | UNDER | RESULT |
|---|---|---|---|---|---|
| 0 (before) | 75.8% | −4.1% | −4.2% | −3.2% | −4.9% |
| 3 | 75.8% | **−4.6%** | −4.4% | −2.8% | −6.4% |
| **5** | **76.4%** | **−4.1%** | −1.9% | −2.8% | −6.7% |

k=3 is worse than doing nothing. k=5 is ROI-neutral and buys +0.6pp of hit rate. It ships on
**correctness** grounds at no measured cost - it is not a performance win and is not described
as one.

### 🔥 re-pointed at the tip

The legacy flag evaluated Over 2.5 through nine gates and settled against that line - a question
nobody asked, sitting next to a tip that is usually a different market. `hotTip()` now reads the
same calibrated probability the betslip survival meter shows, so icon and number cannot disagree.

### `.env`: 56 keys → 28

Secrets, endpoints and process flags only. Every knob that changes what the engine *predicts*
now lives in code with its evidence in a comment and a test around it. Removed: `TIP_MIN_PRICE`
(1.35→1.20), `TIP_MIN_CONFIDENCE` (0.60→0.50), `TIP_MIN_UNDER_LINE` (3.5→4.5), `SAFE_MIN_PARTS`
(3→2, **fixes a live defect** - the code pins 2 and warns 3 starves the pool),
`SAFE_MIN_AGREEMENT` (0.70→0.65), `HOTPICK_TEAM_WINDOW` (6→7), plus 24 keys already at default.

---

## 4. Two claims I withdrew

**The `hot` + UNDER "contradiction" is not a defect.** I reported it last session as the engine
contradicting itself. Those 34 fixtures settled **28/34 = 82.4%**, well above the 70.9% base
rate. `hot` means "goal-rich"; the tip means "Under 4.5". Both can hold. The guard I proposed is
not being shipped.

**The hot-gate's +4.2% tip ROI does not survive.** I called it the best priced signal of the
session. Temporal split: **train +5.9% (n=91), test −1.7% (n=26)** - sign flip, and the bootstrap
CI spans zero. Only the hit-rate gap survives (76.9% vs 70.2%), which is why 🔥 is labelled
"more likely to win" and never "profitable".

---

## 5. Current state

```
TIP     n=1278  hit 76.4%  ROI −4.1%
BANKER  157/160 legs = 98.1%  |  13/16 all-green days  |  ROI −0.7%
```

Thirteen of sixteen days produce a clean ten-leg card. No configuration tested anywhere in three
sessions is positive-EV, and the sharper the reliability filter, the worse the loss asymmetry.

---

## 6. Not done

- **Web UI.** Banker column, tier switcher and the new 🔥 semantics are backend-only. `/api/records`
  serves `tip_banker_*` and `banker` is sortable; nothing renders it.
- **`hotTip` threshold (0.78) is provisional** - set just above the pooled tip hit rate so the icon
  marks a real step up. Re-tune once the ledger exceeds 15 days.
- **Legacy O-2.5 columns** (`market`, `score`, `signals`, `outcome`) are still written for ledger
  continuity. Deprecate them in a later migration, do not repurpose them - that would rewrite
  settled history.
- **Defects still open:** sub-1.20 favourite price not blocking an UNDER tip (mean total 4.25 in
  those fixtures); `12` adversely selected onto draws; fixture 1525244 invisible to `/api/records`.
