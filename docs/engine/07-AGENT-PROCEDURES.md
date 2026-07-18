# 07 — AI-agent engagement procedures

This chapter ROUTES; it does not restate. Hard invariants live in `AGENTS.md` (root);
verified operational playbooks live in `docs/agents/toolset.md`. If you find yourself
copying content into this chapter, you are in the wrong file.

## Where things live

| You need | Go to |
|---|---|
| Architecture, per-file notes, commands with full semantics | `CLAUDE.md` (root — authoritative) |
| Hard invariants + cross-harness entry point | `AGENTS.md` (root) |
| HOW to operate the toolchain (test/serve/E2E/DB/release playbooks, ops issue KB) | `docs/agents/toolset.md` |
| System *behavior* — modes, algorithms, formulas | `docs/engine/` chapters 01–06 |
| Command/routine sequences, warnings, definitions | root `QUICK-REFERENCE.md` |
| History, resolved issues, AI regime-switch log | `docs/memory-bank.md` |

## Before changing X, read Y and verify with Z

| Change | Required pre-read | Required verification |
|---|---|---|
| `DEFAULT_SAFE` / safe gates | `05-RANKING.md` | fresh `scripts/analyze-safe-tips.js` run (LODO grid) — mandatory |
| Hot-pick gates/thresholds/lines | `04-PREDICTIONS.md` | `scripts/backtest-hotpicks.js [--line]` replay |
| Tip families/blend/floors/book guards | `04-PREDICTIONS.md` | offline suite + `scripts/mine-patterns.js` regime warning check |
| Strategies/calibration/sure/sure-bets | `05-RANKING.md` | `simulateStrategies` LODO replay (`scripts/analyze-sure-live.js`, `scripts/backtest-sure-tips.js`) |
| AI prompts/models/tags | `06-AI.md` | regime-neutral (bytes + tags identical) or bump the tag same-commit; `scripts/ai-scorecard.js` after |
| Pipeline steps/schedulers/cadence | `01-SYSTEM.md` | offline suite (auto-rules tests) + one observed light pass in `logs/auto-refresh.log` |
| Data invariants (freeze/fetch-once/settle) | `02-DATA-PIPELINE.md` | do NOT — these are load-bearing; propose to the user first |
| A new ops recipe discovered | — | dated VERIFIED append to `docs/agents/toolset.md` (its protocol) |

Two standing meta-rules: (1) live generation knobs (`TIP_MIN_PRICE`, `SAFE_*`, …) never
move mid-experiment without a dated note — a silent move partitions the measurement ledger
(the 2026-07-10 lesson); (2) settled negatives in `toolset.md` §4 are not re-litigated
without NEW data.

## Doc updates are part of the change

The update-triggers table in `00-README.md` maps every behavior change to the chapter that
must move in the SAME commit; command/routine changes update root `QUICK-REFERENCE.md` the
same way. A PR that changes behavior but not its chapter is incomplete.

---
*Update this chapter when: a new change-category needs a routing row, or the doc topology
itself moves.*
