# Checklist: QUICK-REFERENCE + docs/engine + timestamp convention (2026-07-18)

Plan: `docs/dev/plans/2026-07-18-0324-quickref-engine-docs.md` (same stamp — convention demo).

- [x] Plan + checklist created under the new `YYYY-MM-DD-HHmm-` naming (this pair)
- [x] `docs/engine/01-SYSTEM.md` — modes, 12-step pipeline (flowchart), light/full/manual (sequence diagram), serve behavior, access tiers pointer
- [x] `docs/engine/02-DATA-PIPELINE.md` — sources, canonical fixtures, lifecycle (state diagram), invariants with WHY, prematch freeze + 5-vs-7 window note
- [x] `docs/engine/03-LINKING.md` — scorer formulas, 0.85 + 0.05-margin acceptance (flowchart), alias learning
- [x] `docs/engine/04-PREDICTIONS.md` — 9-gate hot cascade (flowchart) + thresholds, tips (eligibility, 7 families, 0.6/0.3/0.1 blend, book guards), settlement hit/miss/void
- [x] `docs/engine/05-RANKING.md` — calibration + shrinkage, 11 strategies, LODO, sure score, DEFAULT_SAFE, Sure-Bets-vs-sure trap, funnel flowchart
- [x] `docs/engine/06-AI.md` — adjudicators, worker + daily cap, enrich 3-call design, callStructured guard chain (sequence diagram), regime discipline pointer
- [x] `docs/engine/07-AGENT-PROCEDURES.md` — where-things-live map, change-type → pre-read + verification table
- [x] `docs/engine/00-README.md` — index, honesty contract, reading paths, maintenance rules, THE update-triggers table (written LAST)
- [x] Root `QUICK-REFERENCE.md` — §1 Development, §2 Production, §3 Warnings, §4 Definitions
- [x] `docs/README.md` — index + routing-table rows + timestamp convention (forward-only)
- [x] `CLAUDE.md` — docs-layout bullet extended; "10 `STRATEGIES`" → 11 fix
- [x] `AGENTS.md` — read-order routing sentence (engine/ + QUICK-REFERENCE)
- [x] `docs/agents/toolset.md` — dated §6 topology append + §7 update-log line
- [x] Root `README.md` — `## Commands` slimmed to pointer
- [x] Verify: `npm test` passes; link check; mermaid sanity ×7; numbers audit; git status additions-only; pointer sweep
- [x] Commit (`docs:` conventional, on `main`)
