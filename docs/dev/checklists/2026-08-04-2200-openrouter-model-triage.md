# OpenRouter model triage — implementation checklist

Spec: `docs/dev/specs/2026-08-04-2200-openrouter-model-triage-design.md`
Plan: `docs/dev/plans/2026-08-04-2200-openrouter-model-triage.md`
Branch: worktree `claude/reverent-shirley-9f0895` off `feat/engine-v2`.

**Session close-out note (2026-08-04):** this session was archived mid-effort.
Tasks 1–6 are committed and verified (offline suite 1036/1036 green, 32 new
modeltriage tests). Task 7's web card is committed as written code but
`npm run build:web` was NOT run (the worktree has no `web/node_modules`) —
run a build before merging. Task 8 (docs + merge back to `feat/engine-v2`)
was not started; CLAUDE.md/QUICK-REFERENCE still need their model-triage
lines, and the branch is unmerged by design so the successor session can
integrate on its own terms.

| # | Task | Status |
|---|------|--------|
| 1 | Migration `model_triage` + `TRIAGE_*` config + `ai-triage` settings group + .env.example | completed (bce472c) |
| 2 | `score.js` pure rules + `tests/modeltriage-score.test.js` (17 tests) | completed (838a8b3) |
| 3 | `catalog.js` fetch/normalize + `tests/modeltriage-catalog.test.js` (7 tests) | completed (ad07133) |
| 4 | `qualify.js` probes + `tests/modeltriage-qualify.test.js` (8 tests) | completed (a8fc220) |
| 5 | `store.js` (db-injected) + `index.js` seam (tick/scheduler/state) | completed (ca22e0b) |
| 6 | server.js routes + scheduler wiring + maintenance quiesce note | completed (0b264ab) |
| 7 | web admin Models card (ModelsSection/useAdminRoute/AdminPanel/api.js) | code committed — **build unverified** |
| 8 | docs (CLAUDE.md/QUICK-REFERENCE) + full build verification + merge to `feat/engine-v2` | pending (successor session) |
