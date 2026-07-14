# Data Independence & Honest Prediction Claims

*The durable, plain-language statement of where our data comes from, where the
bookmaker enters, and exactly what we may and may not claim about it. Evidence
lives in `docs/data-integrity-and-signal-audit.md` (correctness + signal
decomposition) and `docs/fair-comparison-and-false-positives.md` (the fair,
selection-corrected re-test). Last verified 2026-07-14 on 13 EAT match-days —
re-confirm at ≥30 days before treating any rate as established.*

---

## TL;DR

- **The football statistics are independently sourced.** They come from
  API-Football (canonical fixtures / results / stats), never from bookmaker odds.
  No odds value feeds any statistic. **Concern answered: the stats are not prone
  to bookmaker bias.**
- **The *predictions* are deliberately bookmaker-anchored** — the tip confidence
  blend is ~64% devigged market odds by construction. That is **correct, not a
  flaw**: on a fair, selection-corrected board the market is the *sharper* signal,
  so leaning on it raises accuracy.
- **Honest framing = "market-anchored, stats-corroborated."** Never "independent
  of / not reliant on bookmakers."
- **No market is positive-EV.** The ceiling is the vig (≈ −3% to −13% flat-stake
  by market). We maximize *win probability*, not profit.

---

## 1. Data provenance — two independent sources

| Signal | Source | Bookmaker-derived? |
|---|---|---|
| Fixtures, final scores, standings, lineups, deep match stats (shots/xG/possession), H2H | **API-Football** (api-sports.io) | **No** |
| Pre-match snapshots (rank, form, H2H, rolling goals) | Computed from API-Football canonical data | **No** |
| Odds / implied probabilities | Scraped from **BetPawa / Betika** | Yes (this *is* the bookmaker) |

The statistics pipeline and the odds pipeline are physically separate ingestion
paths that meet only at `matches.fixture_id` (the link). **A bookmaker price
never becomes an input to a statistic.** Settlement is computed from canonical
final scores alone — the audit recomputed all 998 settled tips + 130 hot picks
and found **0 mismatches**.

## 2. The one place the bookmaker enters: the tip confidence blend

Predictions (`bestTip` / hot picks) blend three components into a confidence:

- **Devigged market probability** — ~**0.64 effective weight** (0.667 on O/U,
  0.60 on result markets), present on **100%** of tips.
- Rolling-stats support (~0.32) — independent, from API-Football.
- API-Football percentages (~0.10, result markets only) — independent.

So the bookmaker is **60–67% of every tip's confidence by construction**, and it
is the load-bearing signal (partial correlation with outcome 0.078 market vs
0.021 stats).

## 3. What the fair test established (survivors)

The fair re-test graded market vs stats on a **common, pre-selection board**
(22,213 fixture×market rows over 1,445 settled FT fixtures — not just the 998
blend-tipped games), using AUC (immune to over-confidence) and leave-one-day-out
recalibrated Brier, with day-clustered bootstrap CIs.

- **The market is the sharper *discriminator* in every market group**, with CIs
  excluding zero — 1X2 AUC 0.717 vs 0.606, DC 0.712 vs 0.603, O/U 0.825 vs 0.809.
  It **stays ahead after out-of-sample recalibration**, so this is genuine
  discrimination, not fixable over-confidence. *(SURVIVES, strengthened.)*
- **When the two disagree, reality is the market's number.** Where stats is
  ≥0.10 more bullish (n=4,233): stats says 64.6%, market 47.0%, realized **47.1%**.
  *(Direction SURVIVES; see §4 for the retracted "70.6%".)*
- **The independent signal is real but fully priced.** Stats-only gates hit
  79–88% precision out-of-sample across 232 leagues — but sit at median price
  ~1.13–1.15, **below the 1.20 bettable floor**, and collapse to ~73–78%
  (negative-EV) on the bettable slice. *(Raw precision SURVIVES; the "bettable
  edge" implication is REFUTED.)*
- **No liquid market is positive-EV** on the fair board (X2 −12.8%, 12 −8.0%,
  O 2.5 −5.5%, 1X −4.1%, U 4.5 −3.0%).
- **Timeliness doesn't rescue stats.** Recency-aware stats (45/90-day caps,
  30/45-day decay) did not close the AUC gap and left every bettable segment
  non-surviving; recency-*weighting* slightly *hurt* stats — the market has
  already priced current form. *(fair-comparison §5b.)*

> **Caveat:** all rates are from **13 EAT match-days** — indicative, not
> established. Re-confirm at ≥30 days before treating any figure as settled.

## 4. What was refuted — do not re-cite these (false positives removed)

The fair test retired several earlier claims. **These must not reappear in docs,
UI, or reasoning:**

| Retired claim | Why it fell |
|---|---|
| "X2 is +EV / the only established +EV market / +15%" | Selection artifact. Fair board X2 = **−12.8% EV**; tipped Wilson floor 67.1% < break-even 70.1% → **unresolved / regressed**. |
| "The blend beats market-only (~0.0003 Brier)" | **Not established** — CI [−0.0023, +0.0010] crosses zero. |
| "Market is right 70.6% when stats disagrees bullishly" | The **70.6% was a tipped-selection artifact**; fair figure is ~47% (still the market's number, effect starker). |
| "Blend overrides hit 72.4% vs 70.9%" | **Not established** — CI crosses zero. |
| "The 0.60–0.70 band shows stats sorting correctly" | **Not established** — CI crosses zero. |
| "Stats-only high-precision gates are a bettable edge" | **Refuted** — priced below the 1.20 floor, −EV where bettable. |

## 5. Honest-claims checklist

**We MAY say:**
- The football statistics are sourced independently of the bookmakers; no odds
  feed the stats.
- Predictions are **market-anchored, stats-corroborated** (~64% devigged market
  weight, by design and justified by the data).
- The market is the sharper single signal on a fair board; relying on it is
  correct on current data.
- The independent stats signal is real but the book has already priced it.
- No market is positive-EV; `sure` maximizes win probability / slip survival,
  not profit. Sample is 13 match-days — indicative, not established.

**We MUST NOT say:**
- "Our predictions are independent of / not reliant on bookmakers." (False — and
  making them so would *lower* accuracy.)
- Any "+EV" / "sure-win" / "beat the bookmaker" claim on current data.
- Any retired claim from §4.

## 6. Pointers

- Evidence: `docs/data-integrity-and-signal-audit.md`,
  `docs/fair-comparison-and-false-positives.md`.
- The (currently NO-GO) path to an independent edge:
  `docs/beat-the-book-roadmap.md`.
- Superseded "+EV" framing corrected in `docs/sure-win-analysis.md` and
  `CLAUDE.md` (the `sure` architecture note).
