# Data-Integrity & Signal-Reliance Audit (2026-07-14)

*Read-only audit of the live `oddspro` warehouse. Every number below was computed
by querying the live MySQL DB or running the project's own analysis scripts;
the query/script behind each claim is cited inline. Scripts written for this
audit live in `tmp/audit-0*.mjs` (gitignored, read-only). No warehouse data,
migration, or production code was modified.*

---

## Executive summary

- **Settlement ledgers are honest — 0 mismatches.** Recomputing every settled
  outcome from canonical final scores with the pure `tipHit` logic: **998/998
  settled tips** and **130/130 settled hot picks** match their stored outcome
  exactly. No settled row lacks a canonical score; every settled row sits on a
  final-status fixture. (`tmp/audit-02-correctness.mjs`)
- **The warehouse is internally consistent.** No duplicate prediction keys,
  every tip carries a price + confidence, none priced below the 1.20 floor,
  0.79% of odds rows stale, no post-kickoff settlement drift (4 tips computed
  1–7 min after kickoff — a boundary race, not a leak). (`audit-02`)
- **Sample is small and concentrated — this bounds every conclusion.** Only
  **998 settled tips over 12 EAT days** (2026-07-03→07-14), and **75.8% of them
  fall on just 4 days** (07-04/05/11/12). Hot picks: **130 settled**. Treat all
  rates as indicative, not established. (`audit-01`, `recon-warehouse.js`)
- **Yes, predictions lean heavily on the bookmaker — by design and in
  practice.** Effective market weight is **0.64 average** (0.667 on O/U tips,
  0.60 on result tips), market is present on **100%** of tips, and it is the
  dominant *predictive* carrier: partial correlation with the realized outcome
  is **market 0.078 vs stats 0.021** (controlling for each other).
  (`audit-03-signals.mjs`)
- **But the market is genuinely the sharpest signal, so the reliance is
  currently justified.** Market-only Brier **0.2034** beats stats-only **0.2136**
  and API-only **0.2229**; the full blend (**0.2031**) improves on market-only by
  only **0.0003 Brier / 0.0007 log-loss** — inside the noise. Stats-alone and
  API-alone are *over-confident*, not sharper. (`audit-03`)
- **When stats disagrees with the market, the market is right.** In the 378
  tips where stats is ≥0.10 more bullish than the market (stats mean 0.851,
  market mean 0.679), the realized hit-rate is **70.6% — it tracks the market,
  not the stats.** The "bookmaker misleads" hypothesis is **not supported**; the
  coarse stats signal is the less reliable of the two here. (`audit-03`)
- **Independent signal does exist in the raw data — just not where it pays.**
  The warehouse stats-only backtest (16,518 leak-free fixtures, no odds) hits
  **79–88% precision on double-chance/Under gates and holds out-of-sample**
  (AU 2.5 88.4%→87.3% test, U 4.5→85.6%, 1X→85.7%, across 232 leagues). The
  catch (confirmed by the prior study): those high-precision markets are priced
  below the 1.20 floor, so the bettable slice has ~zero edge.
  (`backtest-sure-tips.js`)
- **No positive-EV market and no viable market-independent model on current
  data.** Flat-stake ROI is **−4.1% (tips)** / **−10.3% (hot picks)**; the one
  market previously called +EV (X2) has **regressed from established-+EV to
  unresolved** as the sample grew (83.6%→76.2%, Wilson floor 67.1% now *below*
  break-even 70.1%). Richer independent features aren't available at scale
  (deep stats cover 100/998 tip fixtures and are post-match; rank/form present
  on ~60%). (`performance` CLI, `audit-04`, `audit-05`)

---

## 1. Data-correctness findings

### 1.1 Settlement honesty — PASS (0 mismatches)
`tmp/audit-02-correctness.mjs` pulled every settled prediction row joined to
`fixtures`, recomputed the expected outcome from `COALESCE(ft_home,goals_home)` /
`COALESCE(ft_away,goals_away)` using the production pure logic, and compared:

| Ledger | Settled checked | Mismatches | Settled w/o canonical score |
|---|---|---|---|
| Tips (`tipHit(tip_market, h, a)`) | 998 | **0** | 0 |
| Hot picks (over 2.5 → `h+a>2.5`) | 130 | **0** | 0 |

All 146 `hot` rows carry `market='O 2.5'`. No settled row is on a non-final
fixture (`settledButStatusNotFinal: 0`). The scoreboard is honest by
construction, exactly as the freeze/settle invariants intend.

### 1.2 Freeze integrity — PASS (with 4 boundary races)
`computed_at` (compute-pass timestamp, which only runs while `kickoff > NOW()`)
is ≤ kickoff for 994/998 settled tips. **4 rows** have `computed_at` 1–7 min
*after* kickoff (e.g. fixture 1493563: computed 02:36:46 vs kickoff 02:30:00) —
a pipeline run that selected the fixture while upcoming but whose write landed
just after kickoff. This does not corrupt outcomes (settlement is independent)
and affects 0.4% of rows; noting for completeness only. (`audit-02`)

### 1.3 Internal consistency — PASS
(`audit-02`) tips with market but no price: **0**; no confidence: **0**; priced
below the 1.20 floor: **0**; duplicate `fixture_predictions` keys: **0**.

### 1.4 Coverage / staleness / sample sizes
- Warehouse: 26,789 fixtures (25,507 FT), 12,503 matches, **2,279,528 odds
  rows** (0.79% stale — healthy), 1,507 prediction rows, 1,602 prematch
  snapshots. (`audit-01`, `audit-02`)
- **Non-terminal past-kickoff fixtures:** 51 `NS` + 58 `PST`. The `PST`
  (postponed) set is expected (retired from the results poll after 7 days per
  `RESULTS_MAX_AGE_DAYS`); the 51 stuck `NS` are minor upstream zombies. (`audit-02`)
- **Settled-tip volume by day** (bounds everything): 07-04 **268**, 07-05 173,
  07-12 163, 07-11 152, then 07-06→07-10 and 07-13/14 all ≤58. Effective
  independent-day count is ~4–5. (`audit-01`)
- Tip-fixture feature coverage (`audit-05`): prematch snapshot **998/998**;
  both standings ranks present **60.5%**; H2H ≥3 meetings **62.0%**; rolling
  sample ≥6/side **99.9%**; deep post-match stats **100/998**.

### 1.5 Recomputed headline rates
Raw hit-rate tips **713/998 = 71.4%**, hot picks **88/130 = 67.7%**
(`audit-02`). Flat-stake performance (`node src/index.js performance`,
vetoed excluded from headline):

| Ledger | Picks (settled) | Hit-rate | Avg price | Break-even | **ROI** |
|---|---|---|---|---|---|
| Tips (all) | 965 | 71.4% | 1.350 | 74.1% | **−4.1%** |
| Hot picks (all) | 130 | 67.7% | 1.336 | 74.9% | **−10.3%** |

Hit-rate < break-even in both — the vig is not being beaten in aggregate.

---

## 2. Signal decomposition & per-signal predictive value

Computed over the **985 settled tips carrying `tip_breakdown`** (of 998; 13
pre-breakdown rows excluded). `market_prob`/`stats_prob`/`api_prob` are the
blend components for the *chosen* market; outcome is hit=1/miss=0. All figures
`tmp/audit-03-signals.mjs`.

### 2.1 How much of the blend is bookmaker?
| Component | Present on | Avg effective weight |
|---|---|---|
| Market (devigged odds) | **100%** (985) | **0.6385** |
| Rolling-stats | 100% (985) | 0.3192 |
| API-Football % | 42.3% (417, result markets only) | 0.1000 |

Effective market weight is exactly **0.667** on the 568 O/U tips (no API part)
and **0.60** on the 417 result tips. So the bookmaker is 60–67% of every tip's
confidence *by construction*.

### 2.2 Does the independent signal move the pick, or echo it?
Among the stored candidate set (chosen tip + up to 2 runners-up), the chosen tip
is **also the market favourite 67.6%** of the time; the blend **promoted a
lower-market candidate 32.4%** of the time (stats/API overrode the market
favourite). Those overrides hit **72.4% (231/319)** vs **70.9% (472/666)** for
the market-favourite picks — the independent signal moving the pick is **at
worst neutral, marginally positive**, but within the noise band on 319 samples.
So a third of picks are genuinely re-ordered by non-bookmaker signal, yet it
doesn't demonstrably improve them.

### 2.3 Per-signal predictive value (lower Brier / log-loss = sharper)
Each component treated as a probability forecast that the chosen tip hits.

**Full support (985 tips; API where present):**
| Signal | n | mean prob | hit-rate | Brier | log-loss |
|---|---|---|---|---|---|
| **Market only** | 985 | 0.699 | 0.714 | **0.2034** | **0.5964** |
| Stats only | 985 | 0.769 | 0.714 | 0.2136 | 0.6432 |
| **Blend** | 985 | 0.721 | 0.714 | **0.2031** | **0.5957** |

**Common support — all three present (417 result-market tips):**
| Signal | Brier | log-loss |
|---|---|---|
| Market | 0.1968 | 0.5818 |
| Stats | 0.2080 | 0.6181 |
| API | **0.2229** | **0.7360** |
| Blend | **0.1962** | **0.5802** |

Readings:
- **Market is the single sharpest signal.** Stats-only and API-only are both
  *worse* than market-only, driven by over-confidence (stats mean prob 0.769
  and API 0.708 vs 0.714 realized).
- **The blend barely beats the market** (Brier −0.0003 full / −0.0006 tri;
  log-loss −0.0007 / −0.0016). The independent signals add value, but a
  vanishingly small amount on top of the odds.
- By group, the tiny blend edge lives entirely in **double-chance** (blend
  0.1960 vs market 0.1968); on **O/U** the blend (0.2082) and market (0.2083)
  are identical — stats add nothing there.

### 2.4 Independent value — partial correlations with outcome
On the 985 market+stats tips (`audit-03`):

| Correlation | value |
|---|---|
| market ↔ outcome | 0.0877 |
| stats ↔ outcome | 0.0458 |
| market ↔ stats | 0.2932 |
| **partial(stats \| market)** | **0.0211** |
| **partial(market \| stats)** | **0.0778** |

Market carries ~2× the raw outcome correlation of stats, and **retains almost
all of it after controlling for stats (0.078)**, while **stats retains almost
nothing after controlling for market (0.021)**. API (tri-support, n=417):
partial(api|market)=0.0703 but raw api↔outcome is only 0.033 and market↔api is
*negative* (−0.27) — this is noise on a 417-sample slate, not a reliable edge.

### 2.5 Disagreement test — who is right when they disagree?
Bucketed by `stats_prob − market_prob` (`audit-03`):

| Bucket | n | realized hit-rate | market mean | stats mean |
|---|---|---|---|---|
| stats ≫ market (+0.10+) | 378 | **70.6%** | 0.679 | 0.851 |
| stats > market (+0.03–0.10) | 265 | 70.2% | 0.709 | 0.773 |
| agree (±0.03) | 193 | 73.6% | 0.711 | 0.714 |
| stats < market (−0.03–−0.10) | 98 | 74.5% | 0.710 | 0.650 |
| stats ≪ market (−0.10+) | 51 | 68.6% | 0.728 | 0.575 |

**The decisive result for the user's concern:** where stats is far more bullish
than the market (378 tips, stats says 85%, market says 68%), reality lands at
**70.6% — essentially the market's number.** The market is *not* the misleader;
strong stats-bullish disagreement is over-confidence. Best-performing bucket is
*agreement* / *mild stats-bearishness*, i.e. when stats corroborates or gently
tempers the market — not when it contradicts it.

Consistent within-market-band split: only the **0.60–0.70 market band** shows
stats sorting outcomes the right way (high-stats 71.7% vs low-stats 66.2%,
n=435); in the 0.70–0.80 band stats sorts slightly *backwards* (73.5% vs 75.5%).

### 2.6 Calibration
Blend is reasonably calibrated with mild top-end over-confidence (bin 0.70–0.80
predicts 0.749, realizes 0.729; 0.80+ predicts 0.815, realizes 0.797). The raw
devigged market is mildly *under*-confident in low bins (0.65–0.70 predicts
0.676, realizes 0.706) — partly a selection effect (we only tip what the blend
already likes). The blend does **not** out-calibrate the market in any bin
enough to matter. (`audit-03` reliability tables)

---

## 3. Direct answer: are we over-dependent on bookmaker odds, and can we fix it?

**Are we over-dependent?** Structurally yes — 60–67% design weight, 100%
presence — and empirically the market is the load-bearing signal (partial
correlation 0.078 vs 0.021). **But on the current data that dependence is
correct, not a flaw.** The market is the sharpest, best-calibrated single signal
available; the two independent signals as currently engineered are *over-confident
and less accurate*, and when they contradict the market, the market wins. Down-
weighting the odds in favour of today's stats/API components would **raise
Brier/log-loss and lower hit-rate**. The premise that "bookmaker data misleads"
is not borne out here — if anything the coarse stats signal is the misleading one.

**Can the reliance be reduced without hurting accuracy?** Not on the current
feature set and current sample. Three things have to be true first, and only the
first is true today:

1. **Independent signal must exist in the data — it does.** The warehouse
   stats-only backtest (no odds at all) reaches 79–88% precision on double-
   chance/Under gates and *holds out-of-sample across 232 leagues*
   (`backtest-sure-tips.js`). The raw data is not signal-free.
2. **The market must not already price it — but it largely does.** That is
   exactly why the blend fails to beat market-only: the odds have absorbed most
   of what the rolling rates know. And where stats is *most* precise (near-
   certain Unders / team-total Unders), the book is efficient and the price sits
   below the 1.20 floor — the "price-blind precision" trap the prior adversarial
   review already documented.
3. **Richer independent features must be available at scale — they are not.**
   The features that *could* carry signal the market misprices are thin:
   - **Deep match stats** (shots, xG, possession) exist for only **130 fixtures
     total / 100 of 998 tip fixtures**, and they are *post-match realized values*,
     not pre-match inputs — unusable as predictors without a per-team
     historical-aggregate pipeline that doesn't exist yet.
   - **Standings rank/form** is present on only ~60% of tip fixtures (summer /
     minor leagues have no table).
   - **H2H ≥3 meetings** on only 62%.

So a genuinely market-independent or stats-forward model is **not viable on the
current data** — and even if built, the profit ceiling is the vig: no
re-weighting turns these books +EV (**−4% to −10% ROI measured**), and the one
market that looked +EV (X2) **decayed to break-even as the sample grew** — the
clearest warning against acting on 12 days of data.

---

## 4. Prioritized recommendations

1. **Keep the market as the primary signal; stop implying independence.** The
   data earns the 0.6 weight. Any user-facing "not dependent on bookmakers"
   framing is unsupported — the honest claim is "market-anchored, stats-
   corroborated." (Evidence: §2.3–2.5.)
2. **Exploit the *agreement* structure, not contradiction.** Tips where stats
   corroborates or mildly tempers the market hit best (73.6% / 74.5%); strong
   stats-bullish disagreement is noise (70.6%). This is already partly captured
   by `tipAgreement`/the Safe gate's `minAgreement`; consider *discounting*
   confidence when `stats_prob − market_prob` is large-positive rather than
   treating high stats as a plus. (Evidence: §2.5.)
3. **Do not act on per-market "edge" from this sample.** Re-run
   `analyze-sure-live.js` / `analyze-safe-tips.js` weekly and gate any market
   claim on a **Wilson lower bound above break-even**, which currently **no
   market satisfies** (X2 regressed out of it). Update `docs/research/sure-win-analysis.md`
   — its X2 "+EV" headline is now stale at the larger sample. (Evidence: §1.5, `audit-04`.)
4. **If independence is a real goal, invest in feature *coverage* before model
   changes.** Concretely: (a) backfill standings so rank/form covers >90% of tip
   fixtures (currently 60%); (b) build a *pre-match* per-team rolling aggregate of
   deep stats (shots/xG conceded-created) — the only plausible source of signal
   the odds may misprice — which first requires far wider `fixture_statistics`
   coverage than 130 fixtures. Only then re-test whether a stats-forward blend
   beats the market out-of-sample. (Evidence: §1.4, §3.3.)
5. **Grow the settled sample before any re-weighting.** 998 tips / ~4 effective
   days is too thin to move blend weights on; the partial-correlation and
   disagreement conclusions should be re-confirmed at ≥30 independent days.
   (Evidence: §1.4.)
6. **Minor data hygiene:** investigate the 51 stuck `NS` past-kickoff fixtures
   and the 4 post-kickoff `computed_at` boundary races (tighten the compute
   selection to `kickoff > NOW() + safety_margin`). Neither affects settled
   integrity. (Evidence: §1.2, §1.4.)

---

### Method note / reproducibility
Scripts (read-only, `tmp/`): `audit-01-recon.mjs` (schema + counts),
`audit-02-correctness.mjs` (settlement/freeze/consistency),
`audit-03-signals.mjs` (decomposition, Brier/log-loss, partial corr,
disagreement, calibration), `audit-04-market-ev.mjs` (per-market Wilson/ROI),
`audit-05-coverage.mjs` (feature coverage). Project scripts run:
`node src/index.js performance`, `scripts/recon-warehouse.js`,
`scripts/backtest-sure-tips.js`. All figures are from the live DB on
2026-07-14; re-run before trusting any figure as the sample grows.
