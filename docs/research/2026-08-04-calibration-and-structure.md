# The admin's odds-allocation intuition, verified — calibration + menu-structure audit

**Date:** 2026-08-04 · **Branch:** `feat/engine-v2`
**Method:** two INDEPENDENT sub-agent analyses over the full `oddspro` warehouse (4,983
finished provider-linked fixtures, kickoffs 2026-07-02 → 2026-08-02, 32 days, ~221k
devig-complete pre-match observations from 2.3M pre-kickoff odds rows), both barred from
reading `docs/` so no prior conclusion could leak in. Everything measured against realized
outcomes (the only trusted ground truth — the "establish truth first" doctrine); prices
screened for junk (price ≤ 1 excluded), stale rows excluded (sensitivity-checked), devig
inside complete single-provider family books (double chance at fair-mass 2), day-clustered
bootstrap CIs, temporal train/test on whole days.
**Reproduce:** `node scripts/research/calibration-audit.js` (~17 s) and
`node scripts/research/structure-mine.js` (~40 s), both read-only.

---

## 1. The intuition, tested

> *"The lower the odds value, the higher the probability of that odds' market outcome
> to happen — run an analysis on historical records and the majority of final outcomes,
> categorized like this, will prove my conclusion."*

**CONFIRMED, with zero exceptions where the data has power.** Realized hit rate rises
monotonically as price falls in **every** market family — across all adjacent price-bucket
pairs with n ≥ 200 per side, not a single inversion exists. The pooled map:

| price bucket | n | hit | devig-implied | edge | flat ROI |
|---|---|---|---|---|---|
| 1.00–1.10 | 13,593 | **92.1%** | 88.6% | **+3.5pp** | −3.5% |
| 1.10–1.20 | 16,143 | 83.2% | 80.9% | +2.3pp | −4.6% |
| 1.20–1.30 | 18,459 | 76.3% | 74.5% | +1.8pp | −5.1% |
| 1.30–1.50 | 25,532 | 67.5% | 66.9% | +0.7pp | −6.5% |
| 1.50–2.00 | 49,513 | 53.4% | 53.5% | −0.2pp | −7.8% |
| 3.00–5.00 | 34,573 | 23.5% | 25.0% | −1.5pp | −13.0% |
| 5.00+ | 21,214 | 10.3% | 13.0% | −2.7pp | −28.5% |

Three refinements the data adds on top of the intuition:

1. **Favourite–longshot bias: shorts hit MORE often than even their devigged price
   implies** (+3.5pp at ≤1.10; CIs exclude zero at both ends, on both books). The
   intuition is not just right — the books systematically *under*-rate their own
   favourites and over-rate longshots. Loss-rate-minimizing selection (the whole Banker
   concept from the 2026-07-26 sessions) is therefore the correct product shape, and it is
   *better* than the prices say it should be.
2. **Totals are shaded toward Overs** (every Under key beats its implied: U 5.5 +3.8pp,
   TT:A:U 2.5 +4.4pp; every Over undershoots: TT:A:O 2.5 −4.4pp, ROI −33.9%) and **result
   markets are shaded toward the away side** (home-side keys `1`/`1X`/`DNB1` +1.4–2.2pp;
   away-side `2`/`X2`/`DNB2` mirror-negative; `X2` negative all 5 weeks). These are
   directional corrections a probability model can consume TODAY.
3. **The vig still dominates:** the biases are real but smaller than the ~5–9% margin, so
   **every price bucket and family aggregate at n ≥ 200 stays flat-stake ROI-negative** —
   with exactly one surviving exception (§3).

## 2. The menu-structure findings (cross-market "hidden factors")

The second question — *what else does the full menu encode?* — produced 341 tested
band-cells, 93 screened candidates, **17 strict train/test+CI survivors collapsing into
5 correlated clusters** (~17 chance survivors were expected from multiplicity, so cluster
coherence, not count, carries the weight):

| # | rule (all within price bands — never raw hit rate) | size | read |
|---|---|---|---|
| A | **Narrow-menu / high-margin fixture ⇒ back the 1.25–1.50 favourite** | +8…+11pp edge vs off-cells | strongest + most coherent (6 correlated features agree); "low-attention fixtures carry stronger favourite shading" |
| B | **Home favourite > away favourite, after price control** | +5pp in 3 independent target×band cells | most portable; matches §1's home-side shading |
| C | Deep O/U ladder offered ⇒ mid-priced totals legs underperform | −4…−7pp | fade totals where the book is confident enough to hang many lines |
| D | Odd/even offered (full-exotics listing proxy) ⇒ Overs underperform | −6…−7pp | possibly a provider/book-quality artifact |
| E | Goal-rich menu ⇒ >2.00 favourites overperform | +6pp | single-cell class, ~50% fluke risk |

**H-bait (the admin's trap theory) — REFUTED on this data.** Within price bands,
cross-provider generosity predicts slightly *better* realization (+0.6…+2.3pp, CIs exclude
0), i.e. the generous book is closer to fair or lagging a move — value, not bait. Extreme
generosity (≥10% over the sibling book, 1.50–2.00 band) shows **+14pp edge (n=138,
underpowered)** — worth monitoring as a value signal. Zero sub-1.02 "boosted-looking"
family books exist in the warehouse at all (253,692 legs scanned), and the raw fact that
generous legs lose more at flat stakes is pure price-mix (Simpson's paradox) — which is
exactly why every claim here is band-controlled. Deception may exist in this niche, but on
these two books, at this window, it does not take the form of mispriced bait odds.

**Also refuted/null on fresh data:** H-goalrich as originally framed (menu prices high
Overs short ⇒ O 1.5 overperforms — Δ +0.7pp, null; NB the 2026-07-26 *runner-up ladder*
signal is a different, candidate-set-based definition and was NOT retested here),
H-margin (overround level does not predict miscalibration), H-blowout (extreme favourites
do mean ~4.0 goals vs 2.85, but the totals menu already prices it).

## 3. The one surviving positive-ROI cell

**BTTS-No (`NG`) priced 2.00–3.00: +3.9pp edge [CI +1.9,+5.8], +2.2% flat ROI, n=4,298;
train +3.4 → test +4.3; strongest on betpawa (+4.7pp, +4.5% ROI).** The only cell that
clears every bar (power, positive edge CI, positive ROI, OOS survival, both books
directionally). One month, one family, no multiplicity correction — **status:
PRE-REGISTERED HYPOTHESIS, not a bankable edge.** Decision rule for the re-test (commit
BEFORE looking): on the NEXT ≥30 days of settled data, `NG` at devig-complete 2.00–3.00
must show positive edge with a day-clustered CI excluding zero AND positive flat ROI.
Betting it live before that re-test is forbidden by our own discipline.

## 4. How this joins the 2026-07-26 engine-v2 work

The previous sessions built the Banker (safest offered market, price-derived — the
intuition productized), banker tiers (probability bar, not fixed list), the goal model
(better predictor than empirical rates, still loses to the market, shipped at weight 0),
and the coherence guard. This audit *independently re-derives their foundations on fresher
data*: price-monotone calibration ✓, favourite–longshot bias ✓ (they found the same
+0.48pp-at-≥1.15 pocket), "the price is the best free predictor" ✓ (1.50–3.00 band is
essentially perfectly calibrated), no broadly exploitable market ✓.

**What engine v2 should do with it (ordered):**

1. **Consume the calibration corrections** in every probability the engine reports
   (slip survival, banker prob, tips): +2…4pp below 1.30, −1.5…3pp above 3.00, the
   Under-side and home-side tilts. This is measurement, not speculation — it makes our
   *probabilities* honest even though it does not create +EV by itself.
2. **Track the pre-registered hypotheses** (NG @2.00–3.00; clusters A and B; the
   extreme-generosity value signal) on accumulating data with committed decision rules —
   the warehouse now grows under one config regime precisely for this.
3. **Keep the Banker/tier product line** — the data says loss-rate-minimizing selection is
   the only construction that reliably clears 90%+ leg rates, and it beats its own prices.
4. **Do not ship** any "edge" claim from cells that failed OOS (DNB1 @1.30–1.50 died in
   test: +12.0 train → +0.8 test), and never quote a hit rate without its implied baseline.

## 5. Honesty box

- 32 days, one calendar month, two Kenyan books, no league segmentation. All CIs
  day-clustered but family-wise multiplicity is only accounted for narratively.
- Prices are last-pre-kickoff snapshots — sharper than what a bettor obtains earlier.
- The salvaged Aug-3/4 stage window (see memory-bank) is excluded from both analyses.
- Nothing here claims a profitable strategy exists yet. It claims: the intuition's
  calibration core is true, the books' distortions are mapped and consumable, one
  candidate +ROI cell survived every test we could throw at it this month, and the next
  test is already defined.
