# Plan: QUICK-REFERENCE.md + docs/engine/ bible + timestamp-prefix convention

> 2026-07-18. First dev-pipeline file under the new naming convention
> (`YYYY-MM-DD-HHmm-<topic>.md`, all-hyphen, 24h local; a plan and its checklist share the
> SAME stamp). Companion checklist:
> `docs/dev/checklists/2026-07-18-0324-quickref-engine-docs-checklist.md`.

## Context

Three deliverables (user request, 2026-07-18):

- **(A) Root `QUICK-REFERENCE.md`** — terse command/action sequences isolated by environment
  (Development, Production), plus a consolidated critical-warnings table, routine cadences
  with execution order, and a tabulated Definitions glossary (betting/prediction/dev lingo).
  No lengthy explainers. Any future command/routine change updates it in the SAME commit.
- **(B) `docs/engine/`** — numbered-chapter system bible (`00`–`07`): operating modes,
  execution stages, the logic behind the prediction calculations, the repo's first mermaid
  diagrams, and AI-agent engagement procedures. Updated only when related features change.
- **(C) Permanent convention** — dev-pipeline files (specs, plans, checklists) get the
  full-timestamp prefix `YYYY-MM-DD-HHmm-<topic>.md`; related files share the identical
  stamp; forward-only (never rename existing dated files).

User-confirmed decisions: root `README.md` `## Commands` slims to a pointer (QUICK-REFERENCE
becomes the single command list); the prefix applies to all three dev-pipeline kinds;
all-hyphen format over the underscore variant.

Code-verified corrections shipping with the docs: `src/db/magic-rules.js` has **11**
strategies (CLAUDE.md said 10 — fixed here); overround/book-integrity lives in
`src/db/tip-rules.js` (not goals-rules); prematch snapshot windows are 5/5 vs the hot-pick
evaluation window 7 (intentional — documented, not "fixed"); no `engines` field and no
canonical Docker container exist (documented as gaps, not invented); `?refresh=1` exists
only on `GET /api/magic-sort`.

## Files

New: root `QUICK-REFERENCE.md`; `docs/engine/00-README.md` (index + honesty contract + THE
update-triggers table), `01-SYSTEM.md`, `02-DATA-PIPELINE.md`, `03-LINKING.md`,
`04-PREDICTIONS.md`, `05-RANKING.md`, `06-AI.md`, `07-AGENT-PROCEDURES.md`; this plan + its
checklist.

Edited: `docs/README.md` (index + routing table + convention), `CLAUDE.md` (docs-layout
bullet + 10→11 strategies fix), `AGENTS.md` (read-order routing sentence),
`docs/agents/toolset.md` (dated §6 append + §7 update-log line), root `README.md`
(Commands → pointer).

## Anti-duplication rules (baked into the docs)

QUICK-REFERENCE never explains WHY (engine chapters do); engine never lists command
sequences (QUICK-REFERENCE does); invariants get one line + pointer (`AGENTS.md` owns
them); user-facing term wording is owned solely by `web/src/glossary.js` (test-enforced) —
the Definitions table indexes it and adds dev-only lingo.

## Execution order

1. This plan + checklist (convention prior art).
2. Engine chapters 01→06 (every number re-verified against source), then 07, then 00 last.
3. Root `QUICK-REFERENCE.md`.
4. Convention edits: `docs/README.md` → `CLAUDE.md` → `AGENTS.md` → toolset append →
   README slim.
5. Verify, tick checklist, commit (`docs:` conventional style, on `main`).

## Verification

- `npm test` unaffected (docs-only; `web/src/glossary.js` untouched).
- Relative-link check over all new/edited files (scratchpad script).
- Mermaid sanity for all 7 diagrams (first mermaid in the repo).
- Numbers audit: every quoted threshold re-grepped against code (0.85/0.05 margin, blend
  0.6/0.3/0.1, 1.2, 4.5, [1.01, 1.30], 0.15, k=20, 0.52, {2.5}, cap 20/day, 60s tick,
  `DEFAULT_SAFE` values, 11 strategy ids).
- `git status` shows only additions + the 5 edited files, zero renames (forward-only).
- Pointer sweep: every promised cross-link landed; `docs/README.md` enumerates every
  existing docs dir.
