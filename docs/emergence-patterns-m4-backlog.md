# Emergence Patterns — Strategic Enhancement (M4 candidate backlog)

> Captured 2026-07-16 from user notes (mid-M3). Status: BACKLOG — needs its own
> brainstorm → spec → plan cycle after M3 merges. Nothing here is committed scope.

## The idea (user's observations, ~v1.0.1 era)

1. **O/U cascade precursor:** a majority of fixtures tipped `O 3.5` or `O 2.5`
   end up clearing `O 1.5` — tiered over-lines may be exploitable as a
   safer-landing fallback ladder.
2. **Runner-up configuration precursor:** when `O 3.5` and `U 3.5` sit at
   runner-up positions 2 and 3 (e.g. `2:O 3.5`, `3:U 3.5`), the fixture tends
   to end high-scoring. Runner-up *configurations* (not just the winning tip)
   may encode outcome signals.
3. **Miss-commonality mining:** find what the majority of settled misses share
   (league context, market family, price band, sample thinness, signal
   disagreement…) and turn it into avoid-rules.
4. **Self-healing accuracy loop:** the system should learn from its own misses
   continuously — "what to avoid next time" — optionally with an AI review pass
   over recent misses proposing mitigations.
5. **Golden-opportunity spotter:** bookmakers occasionally misprice/boost
   engagement games (e.g. home win at 20x that lands). Detect longshot
   anomalies and make them conspicuous (display-layer flag, like 🔥 hot picks).
6. Custom filters (already shipped) remain the manual pattern-catching surface;
   this milestone automates the retrospection.
7. **Contrarian / fade-the-consensus thesis (user, 2026-07-16):** in the user's
   experience, Gemini research tends to agree with bookmakers + public analysis
   and fails a majority of the time; the majority-favored tip often lands the
   OPPOSITE outcome. The user does not rule out books shading or influencing
   outcomes when public money concentrates ("the house always wins" bias) and
   wants that used AGAINST them: identify consensus-trap configurations and
   mitigate/fade them. Evidence artifact: a real winning multi curated from a
   custom Safe-only filter of 2026-07-10 games
   (`docs/visuals/betika-won-slip-2026-07-10.png`, local file). The user has
   applied this strategy and won — this thesis is the founding vision of the
   project.
   *Testability note:* causation (outcome influence) is unprovable from our
   data, but the measurable claim doesn't need it — "public/AI-consensus
   alignment is an anti-signal" is directly minable: condition settled-tip hit
   rates on AI-verdict agreement (persisted in `tip_ai_review`/`ai_review`
   since phase 13), on favorite-status/price shortness, and on
   market-vs-stats agreement (`tipAgreement` parts). Prior support already in
   the ledger: v1 adjudicator contradiction-vetoes measured NET-NEGATIVE
   (why prompts were de-anchored in v2) — i.e. the market-agreeing AI was
   wrong often enough to cost money. Pre-register the split, then let the
   replay decide.

## Raw material that ALREADY exists (no new collection needed)

- `fixture_predictions.tip_breakdown` JSON — full blend + **runners_up
  persisted verbatim** on every tip since phase 14 → hypothesis 2 is minable
  today via a replay script.
- Per-line `overRates[0.5..6.5]` on team/H2H aggregates (M3 Task 7) +
  `LINE_THRESHOLDS`/`scoreOverLine` → substrate for hypothesis 1.
- `computeCalibration` cells (band × market group × price band, beta-shrunk) +
  `cal.markets[key].profit/staked` live ROI (M3 Task 8) → the "learn from
  settled history" engine already runs live.
- perf-rules edge buckets (confidence×price − 1) — "where false positives
  live" — plus `tip_ai_review`/`ai_review` JSON verdicts → hypothesis 3/4 joins.
- Admin data-viz lab (pre-binned aggregates over frozen snapshots) → manual
  exploration surface for pattern hunting.
- LODO/temporal-OOS harnesses: `scripts/analyze-safe-tips.js`,
  `scripts/backtest-sure-tips.js`, `scripts/backtest-hotpicks.js --line`.

## Non-negotiable guardrails (learned the hard way)

- **Multiple-comparisons honesty:** pattern mining over many candidate
  configurations WILL surface false positives. Every mined pattern must
  survive temporal-OOS / LODO replay with selection correction before it
  touches live ranking. Precedents: the X2 "+15% EV" claim was REFUTED by the
  fair re-test (`docs/fair-comparison-and-false-positives.md`); the runner-up
  swap was backtested net-negative (+108/−128). Mine freely, ship skeptically.
- **Frozen ledger:** settled/past-kickoff rows are never rewritten. Self-healing
  = live recalibration (safePrior-style) + replay-gated rule changes, never
  history edits.
- **Price-blind ≠ bettable:** a pattern must survive at real odds (break-even
  rate vs realized rate), not just hit often. Warehouse precision alone has
  already proven anti-correlated with live ROI once.
- **AI adjudication stays veto/flag-only** (never promotes), per the existing
  hot-picks/tips design.

## North star (user, 2026-07-16 — verbatim intent)

The main goal of improving the tip prediction algorithm and pipeline is
**bookmaker-trick immunity**: books sometimes employ clever tricks like unfair
odds allocation to throw off automated systems and inexperienced gamblers.
Gemini AI at our disposal should be a harnessable superpower for accurately
spotting free (easy) wins. **System objective met when:** an unbreakable
multi-bet selection filter of sure-bets — over 99% hit probability (or other
reasonable threshold) — at a ≥ 2.5x combined multi-bet multiplier.

*Honest-measurement note beside the north star:* 99% survival at 2.5x implies
≈ +147% EV per slip; the warehouse's measured reality so far is ≈ −3% flat-stake
EV (no +EV market survived the fair re-tests). So the objective is directional:
maximize the (slip-survival × multiplier) frontier and track it honestly —
current best Safe-pool leg rate 88.9% (sure ranker). M3's book-integrity guards
(overround window 1.01–1.30, cross-book divergence veto 0.15) are the first
purpose-built bookmaker-trick defenses; the golden-opportunity spotter (above)
is the "free wins" lens; Gemini adjudication stays veto/flag-only until a
promotion path earns its way in via replay evidence.

## Suggested M4 shape (to be refined in brainstorm)

- Phase A: read-only pattern-mining scripts over settled history (hypotheses
  1–3 as pre-registered tests + a bounded automated config-search with OOS
  validation); a "miss post-mortem" report generator.
- Phase B: whatever survives → live surfacing (calibration extension, avoid
  flags in TipPopover, golden-opportunity badge with honest hit-rate label).
- Phase C (only if A/B earn it): AI "what to avoid next time" reviewer over
  recent misses, output as advisory flags.
