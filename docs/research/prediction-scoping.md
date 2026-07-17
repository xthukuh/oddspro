# Prediction phase — scoping draft (2026-07-03)

Status: **superseded 2026-07-03 (same day) — Phase 12 shipped a different direction.**
The brainstorm settled on **rule-based logical deduction, explicitly no ML training**:
strict AND concurrence gates over leak-free history aggregates (`src/db/goals-rules.js`),
BetPawa vig-removed implied probability as a market gate, API-Football `/predictions` as a
boost/veto signal, and an optional OpenRouter AI adjudicator — all Node, inside the existing
pipeline (see `docs/dev/implementation-plan.md` Phase 12). The Python/XGBoost standards below are
kept for reference only; if an ML phase ever happens, the `fixture_predictions` outcome
ledger (every evaluated fixture with signals + settled hit/miss) is a ready-made evaluation
baseline. Thresholds were tuned by `scripts/backtest-hotpicks.js` (10,678 fixtures replayed
with kickoff cutoffs — empirical validation, not model training): baseline over-2.5 rate
54.3%, shipped gates 73.2% stats-only precision.

Original draft below, unchanged:

Status: **scoping only — not approved for implementation.** This captures what the warehouse
already offers and the decisions to make before any code. To be brainstormed together.

## What the warehouse already provides

- **Leak-free features:** `fixture_prematch` snapshots freeze rank/form/H2H/rolling-goals at
  kickoff — exactly the information available before a match, immune to hindsight drift.
  Growing ~300+/day with daily sweeps (384 rows as of 2026-07-03; snapshots exist only from
  2026-07-02 onward).
- **Targets/labels:** canonical FT scores on `fixtures` (results-are-canonical invariant) —
  1X2 outcome, total goals, both-teams-scored all derivable.
- **Market baseline:** `odds_markets` closing prices per bookmaker (stale rows preserve the
  last-seen price). Bookmaker implied probabilities are the benchmark any model must beat.
- **Aux data:** `fixture_statistics`/`lineups`/`events` (post-match — usable for labels and
  analysis, never as pre-match features), team history (9.7k historical fixtures), standings.

## Standards already settled (user-global CLAUDE.md)

Python 3.12+ with type hints, `black`, `pytest` in `tests/prediction/`, all queries through
`src/prediction/db_loader.py`, XGBoost models serialized as `.ubj` only. `.gitignore` already
carves out `src/prediction/models/`, `experiments/`, `cache/`, `docs/feature-importance.json`.

## Two possible dataset strategies

1. **Snapshot-native (clean, slow):** train only on frozen `fixture_prematch` rows + closing
   odds. Zero leakage risk, but needs weeks of accumulation before meaningful volume.
2. **Backfill-augmented (bigger, odds-less):** reconstruct pre-match features for the 9.7k
   historical fixtures via `prematch-calc` with kickoff cutoffs (same pure functions the
   snapshot writer uses). No historical odds exist for these, so they can train an outcome
   model but not a value model.

## Open questions (need answers before implementation)

1. **Target:** 1X2 multiclass? Over/Under 2.5 binary? Several markets?
2. **Framing:** predict outcomes, or predict *value* (model probability vs bookmaker implied
   probability → bet flags)? Value framing needs odds in the loop and a ROI-based backtest.
3. **Dataset strategy:** snapshot-native, backfill-augmented, or both (pretrain + fine-tune)?
4. **Evaluation:** log-loss/Brier vs closing-odds baseline? Simulated flat-stake ROI? What
   makes the model "good enough" to surface in the web UI?
5. **Scope:** all correlated leagues or a quality-filtered subset (minor leagues have sparse
   stats and noisier odds)?
6. **Cadence:** retrain schedule, and where predictions surface (web column? separate view?).
7. **Volume gate:** minimum snapshot count before the first training run is worth doing?
