# Full audit

**Date:** 2026-07-26 · **Scope:** every claim and dataset this project rests on
**Method:** re-derived from primary data; each claim tested against the null hypothesis that
would produce the same result if the effect were absent.

Three of my own headline claims were overturned or resized. They are listed first.

---

## Part 1 - Claims audit

### 1.1 OVERTURNED: "the Banker hits 92% vs the Tip's 70%"

Raw hit rate is a function of **price**, not skill. A market quoted at 1.01 implies 99%; winning
98% on it is arithmetic. The only meaningful measure is **edge = realized − price-implied**.

| | n | realized | implied | **edge** | 95% CI |
|---|---|---|---|---|---|
| Banker (all) | 1,199 | 91.9% | 95.1% | **−3.18pp** | [−4.58, −1.53] |
| Tip | 1,199 | 70.9% | 73.9% | **−3.06pp** | [−4.68, −1.26] |

**Statistically indistinguishable.** The Banker is a risk-preference transformation - the same
edge at shorter odds - not an improvement in selection. Four sessions presented a tautology as an
achievement.

Only non-negative cell in the whole banker book: **price ≥ 1.15, edge +0.48pp** (n=129,
CI [−7.85, +6.67]).

### 1.2 RESIZED: the goal-rich ladder signal, 84.1% vs 71.1% → **+2.01pp of edge**

Control never run at the time: take the same number of fixtures chosen purely by *shortest O 1.5
price*. It scores 85.4% - **better** than the signal's 83.8%. So most of the original gap was price.

Stratifying by price band, the signal does still separate:

| O 1.5 price band | signal edge | no-signal edge | difference |
|---|---|---|---|
| 1.00-1.15 | −3.18pp | −7.76pp | +4.58pp |
| 1.15-1.25 | −3.20pp | −6.37pp | +3.17pp |
| 1.25-1.40 | +2.86pp | +2.24pp | +0.62pp |
| **pooled** | **−2.22pp** | **−4.22pp** | **+2.01pp**, CI [−2.65, +8.24] |

CI spans zero, but the direction is stable out-of-sample (train +2.17pp, test +2.74pp) and
positive in every band. **Real, ~1/6 the size originally claimed.**

### 1.3 VALIDATED but re-described: line shopping, +2.04pp

Two ways it could have been fake, both tested:

- **Mapping artifact?** No. Each provider's own O/U pair devigs to a sane overround (betpawa
  1.067, betika 1.080), **0% outside the 1.00-1.30 band** at every line. The two books' "O 2.5"
  is the same bet.
- **Staleness?** No. **87.4% of fixture pairs are quoted within one minute** of each other, and
  the gain is identical at every window (+2.22pp any gap, +2.04pp at ≤1 min). It does not decay
  as synchronisation tightens.

But the decomposition matters:

| strategy (pairs quoted within 1 min, n=18,752) | ROI |
|---|---|
| worse of the two - **what the engine did** | −9.32% |
| always betika | −9.05% |
| always betpawa | −7.54% |
| **best of the two - line shopping** | **−7.28%** |

**+1.78pp of the gain is simply "stop deliberately choosing the worse price".** Only **+0.26pp**
is genuine shopping. The fix is right and worth keeping; calling it "line shopping unlocks value"
was not. betpawa offers the longer price 66.9% of the time.

---

## Part 2 - Data integrity

### 2.1 Prices

| | |
|---|---|
| total odds rows | 2,973,906 |
| **price ≤ 0** | **51,871 (1.7%)** |
| price between 0 and 1 | 0 |
| price > 500 | 1 |

Concentrated in betika (2.16% of its rows) vs betpawa (0.67%), and in exotics - 1ST HALF TOTAL
(15,392), HANDICAP (10,303), Multigoals (3,036), Correct Score (1,495). Only **236 in Over/Under
Full Time**. `buildTipBooks` and `marketMenu` filter on `price > 1`, so the engine is safe;
ad-hoc analysis scripts are not, and several fake "arbitrages" came from exactly this.

### 2.2 In-play leakage - clean

4 rows of 848,290 written after their fixture kicked off; 0 created after. The pre-kickoff
guarantee holds.

### 2.3 Score fields - explained, one latent bug

178 fixtures where `goals_*` disagrees with `ft_*`. **136 are AET**: `ft_*` is the 90-minute
score, `goals_*` the post-extra-time result. Football settles on 90 minutes, so `ft_*` is
correct - and the engine and simulator both use it.

**Latent bug:** `settleHotPicks` uses `COALESCE(f.ft_home, f.goals_home)`. On an AET fixture with
a null `ft_home` that settles the bet on the extra-time score. One fixture currently qualifies.
13 settled tips sit on mismatched fixtures.

### 2.4 Match linking - my "65% of data discarded" claim was wrong

| | |
|---|---|
| unlinked matches | 12,185 |
| **virtual / zoom / esports (correctly unlinked)** | **10,105** |
| plausibly real | 2,080 |
| …of which have a time-compatible fixture | 2,066 |

Of 1,920,577 stranded odds rows, **1,591,395 are on virtual products** - betika "Zoom" and
Simulated Reality League markets that have no real-world fixture by design. The genuine gap is
**~2,000 matches carrying ~329k odds rows**, concentrated in Club Friendlies, women's leagues,
Kolmonen/Kakkonen and U23 competitions - precisely where team naming is least standardised.

Only 31 are recoverable by exact or normalised name; the rest need alias work
("Renaissance Zemamra" → "CR Khemis Zemamra", "Union Touarga" → "UTS Rabat",
"Bahir Dar Kenema FC" → "Bahardar").

### 2.5 Duplicate provider links

7 fixtures carry two matches from the same provider (4,531 odds rows). `buildTipBooks` folds by
provider so there is no double-count, but prices from two distinct match records get mixed into
one book. Minor; worth a uniqueness constraint.

### 2.6 Demo DB purity - clean

`fixture_predictions`, `fixture_prematch`, `fixture_ai_insights` all 0 rows. The simulator returns
identical numbers before and after the truncation, which proves it never read them.

---

## Part 3 - A regression I introduced

The 28-key `.env` I generated drops **`LINK_MIN_CONFIDENCE=0.8`**, reverting to the code default
of **0.85**. That makes the linker *stricter* and would link fewer matches - the opposite of what
§2.4 wants. Either restore the key or change the code default to 0.80 and record why.

---

## Part 4 - What the audit changes

1. **Every accuracy number in `docs/research/` needs re-baselining on edge.** Raw hit rate
   ranks nothing; it only tells you what price you took.
2. **The Banker is not an accuracy product.** It is the Tip's edge at shorter odds. Its honest
   use is risk shaping, not improvement.
3. **The one non-negative pocket found anywhere** is banker at price ≥ 1.15 (+0.48pp) and the
   ladder signal within price bands (+2.01pp). Both wide-CI, both worth instrumenting.
4. **Execution beat selection.** The only change that moved ROI without arguing with the book was
   correcting the price the engine reports - and most of that was undoing a self-inflicted loss.

## Part 5 - Not verifiable from here

The fetch pipeline cannot run in this container: egress is proxy-filtered to package registries
only (`api-sports`, `betika`, `betpawa`, and `google.com` all fail at connect; DNS resolves).
The only route to fresh data is the ngrok tunnel into your machine, where
`POST /api/refresh?date=` would run the pipeline on **your** instance - which you have asked me
not to touch. So all findings stand on the 2026-07-17 warehouse.
