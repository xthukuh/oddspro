# docs/engine/ — the system bible

How oddspro BEHAVES: operating modes, execution stages, and the logic behind every
prediction calculation. Division of labor: **this folder = behavior and why**; root
`QUICK-REFERENCE.md` = command sequences; `CLAUDE.md` = per-file architecture (authoritative
and denser); `docs/memory-bank.md` = history and hard-won lessons. Chapters are behavior
docs, never changelogs.

> ## The honesty contract
> **No positive-EV market exists on our books — flat-stake EV ≈ −3% (the vig).** The
> `sure` sort, safe pool and sure-bets list maximize **win probability and slip
> survival, NOT profit.** Every ranking or selection claim in these chapters is subject
> to this. Evidence: `../research/sure-win-analysis.md`,
> `../research/fair-comparison-and-false-positives.md`.

## Chapters

| # | File | Scope |
|---|---|---|
| 01 | `01-SYSTEM.md` | Operating modes (CLI / serve / cron), the 12-step sweep, light vs full vs manual, serve behavior |
| 02 | `02-DATA-PIPELINE.md` | Sources, canonical fixtures, lifecycle, the warehouse invariants and WHY |
| 03 | `03-LINKING.md` | Fuzzy correlation formulas, acceptance thresholds, alias learning |
| 04 | `04-PREDICTIONS.md` | Hot-pick 9-gate cascade, tip families + confidence blend, book guards, settlement |
| 05 | `05-RANKING.md` | Calibration + shrinkage, the 11 strategies, LODO replay, `sure`, safe pool, sure bets |
| 06 | `06-AI.md` | Adjudicators (veto-only), the worker + budget, enrichment, the guard chain |
| 07 | `07-AGENT-PROCEDURES.md` | Agent engagement routing: where things live, change → pre-read → verification |

Reading paths — new developer: 01 → 02 → 04 → 05; AI agent: `AGENTS.md` → 07 → 01;
"why did it tip that?": 04 → 05.

## Maintenance

- A behavior change updates its chapter **in the same commit** — the triggers table below
  says which. Diagrams must match code; a stale diagram is worse than none.
- Chapters state current behavior only. Dated history belongs in `docs/memory-bank.md`;
  findings in `docs/research/`.
- New chapters: next number, add a row to both tables here and to `docs/README.md`.

## Update triggers

| Change in | Update |
|---|---|
| `src/pipeline.js` step order; `src/auto-refresh.js` schedulers/cadence; serve boot | `01-SYSTEM.md` |
| Data sources, fetch-once/freeze/settle invariants, market identity, snapshot windows | `02-DATA-PIPELINE.md` |
| `src/link.js` similarity/thresholds/aliases | `03-LINKING.md` |
| Hot gates (`goals-rules`), tip families/blend/guards (`tip-rules`), settlement | `04-PREDICTIONS.md` |
| `STRATEGIES`, calibration, `WAREHOUSE_WLO`, `DEFAULT_SAFE`, sure bets (`magic-rules`) | `05-RANKING.md` |
| AI prompts/tags/caps/guards/DARK switches | `06-AI.md` |
| New agent procedure or change-category | `AGENTS.md`/`toolset.md` (dated append) + a `07` routing row |
| Any command, routine sequence, warning, or env knob | root `QUICK-REFERENCE.md` (same commit) |
| User-facing term added/changed | `web/src/glossary.js` FIRST (tests enforce wording), then a QUICK-REFERENCE §4 row |
