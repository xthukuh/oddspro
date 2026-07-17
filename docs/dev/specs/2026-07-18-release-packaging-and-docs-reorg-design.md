# Release Packaging (--export-db + version tag) & Docs Reorganization — Design

> Approved 2026-07-18 (user-reviewed design conversation). Companion plan:
> `2026-07-18-release-packaging-and-docs-reorg.md` (written after this spec is
> approved). This spec file is written at `docs/superpowers/specs/` and MOVES to
> `docs/dev/specs/` as part of its own Part 2.

## Goals

1. **Release packaging**: `npm run package:deploy` gains an optional
   `--export-db` boolean (a gzipped DB dump joins the release files) and an
   idempotent annotated version tag on `main` after every successful package
   run. NEW RULE enforced by the script: **releases are built from `main`
   only; version tags exist only on `main`** — every other branch is feature
   work.
2. **Docs reorganization**: `docs/` separates PROJECT documentation (overview
   index, deployment & setup, issues+fix knowledge base, guides, research
   findings) from DEVELOPMENT-PIPELINE documentation (specs, plans,
   checklists, progress tracking).
3. **Stale-knowledge audit**: close the currency gaps found in the 2026-07-18
   review (CLAUDE.md Commands omissions, stale root README, memory-bank state
   entry, Claude-memory index hooks).
4. **Agent toolset knowledge library** (user, 2026-07-18): a repo-committed,
   harness-agnostic operations reference so ANY model (Opus, Codex, Gemini,
   future Claude) starts with everything that already works — verified
   command playbooks, what-to-use-when guidance, operational issue KB, and
   strict do-not-break guardrails. Exports the transferable parts of the
   incumbent agent's private session memory into the repo. Agent-density
   sanctioned: optimized for agent use, not human skimming.

## Non-goals

- No change to what the two zips contain, `db-export.js`'s standalone CLI
  behavior (still writes `backups/`), the deploy procedure itself
  (`docs/DEPLOYMENT.md` manual cPanel flow), or any runtime/server code.
- No slim/partial DB dump variant (`--export-db` is boolean; the dump is the
  full database exactly as `db-export.js` produces today). YAGNI until a real
  import-size problem shows up.
- No auto-switching branches. The user's initial "or automatically switch"
  idea was reviewed and REJECTED together: a packaging script silently running
  `git checkout` violates least-astonishment and can fail mid-run on a dirty
  tree. The script refuses and tells the user what to run.
- No rewrite of research docs' content; moves + link fixes only. Root
  README.md gets a currency pass, not a rewrite.

---

## Part 1 — `package:deploy`: --export-db + idempotent version tag

### CLI contract

```
npm run package:deploy                      # zips only (as today) + tag step
npm run package:deploy -- --export-db       # + oddspro-db_<stamp>.sql.gz in release/
npm run package:deploy -- --out-dir <dir>   # unchanged, composes with --export-db
```

### Execution order (each step gates the next)

1. **Sanity** (as today): repo root, `web/dist/index.html` present.
2. **Branch guard (NEW, first new behavior):** `git rev-parse --abbrev-ref
   HEAD` must print exactly `main`; anything else (feature branch, detached
   `HEAD`) → `die("releases are built from the main branch - run: git
   checkout main")`. Runs BEFORE any artifact is written.
3. **Dirty-tree warning** (as today, unchanged): warn that the backend zip is
   HEAD, not the working tree.
4. **Backend + frontend zips** (as today), stamp `<ts>` shared by all
   artifacts of the run.
5. **DB export (only with `--export-db`):** call `exportDb({ outPath })` from
   `scripts/db-export.js` with `<outDir>/oddspro-db_<ts>.sql.gz` — the SAME
   stamp as the zips, so one release = one matching artifact set. Failure
   (no Docker, dump error) aborts the run BEFORE tagging.
6. **Version tag (LAST — only after every artifact succeeded):**
   - `version` = root `package.json` `.version`; tag name `v<version>`.
   - Warn (non-fatal) if `web/package.json` version differs from root — the
     two are kept in lockstep by convention.
   - If tag `v<version>` **exists**: skip creating (idempotent re-run).
     Additionally, if it points at a commit ≠ HEAD, print a LOUD warning:
     "v<version> already tagged at <sha> which is not HEAD - the codebase
     changed but the version was not bumped; bump package.json (root+web)
     if this is a new release." (This is exactly today's state: `v1.2.0` @
     `f7f1f9d` ≠ HEAD.)
   - If tag does not exist: `git tag -a v<version> -m "oddspro v<version>"`
     at HEAD, then `git push origin v<version>`. Push failure → die with a
     message noting the local tag was created and how to push manually
     (`git push origin v<version>`); the local tag is NOT deleted.

### `scripts/db-export.js` refactor

- Extract the dump core into an exported `async function exportDb({ outPath,
  container = null })` → resolves `{ path, bytes }`; throws (with the current
  error text) instead of `process.exit` so the caller decides. Container
  resolution and dump-binary probing unchanged (`--container` >
  `DB_DOCKER_CONTAINER` env > auto-detect; `mariadb-dump` before `mysqldump`).
- The CLI entry (stamp into `backups/`, console messaging) becomes a thin
  wrapper around `exportDb` and keeps byte-identical behavior, gated on
  main-module detection so importing the file never runs the CLI.
- `package-deploy.js` imports it **lazily** (`await import`) only when
  `--export-db` is passed — plain packaging stays dependency-free and never
  loads `src/config.js`/dotenv.

### Verification

- From a scratch feature branch: `npm run package:deploy` → refused by the
  branch guard (no artifacts written).
- On `main`, no flag: two zips in `release/`; tag step logs the
  v1.2.0-not-at-HEAD warning and creates nothing (v1.2.0 exists).
- On `main`, `--export-db` (Docker up): third artifact
  `oddspro-db_<ts>.sql.gz` appears with the same stamp; size printed.
- `node scripts/db-export.js` standalone: unchanged behavior into `backups/`.
- Tag-creation path is NOT exercisable without a version bump; it ships
  code-reviewed and fires on the next real release (bumping the version is
  the user's release-time decision).

---

## Part 2 — Docs reorganization (approved layout)

Root `docs/` = project documentation; `docs/dev/` = development pipeline.
All moves via `git mv` (history preserved). ONE commit contains moves + every
reference update, so no intermediate commit has dangling links.

### Mapping (all 42 current files accounted for)

| Destination | Files |
|---|---|
| `docs/` (stay) | `DEPLOYMENT.md`, `memory-bank.md` (referenced from `src/` comments — staying put keeps `src/` untouched) |
| `docs/README.md` (NEW) | Navigation index: what each folder holds, where each NEW doc kind goes (spec → `dev/specs/`, plan → `dev/plans/`, checklist → `dev/checklists/`, research finding → `research/`, guide → `guides/`), pointer to CLAUDE.md for architecture |
| `docs/guides/` | `safety-net-protocol.md`, `sms-bonga-integration.md` |
| `docs/research/` | `sure-win-analysis.md`, `fair-comparison-and-false-positives.md`, `data-independence.md`, `data-integrity-and-signal-audit.md`, `precursor-patterns.md`, `emergence-patterns-findings.md`, `emergence-patterns-m4-backlog.md`, `m4.2b-booster-validation-and-value-edge.md`, `ai-edge-sentinel.md`, `beat-the-book-roadmap.md`, `prediction-scoping.md`, `spa-performance-audit-2026-07-16.md` (12) |
| `docs/dev/` | `implementation-plan.md` (from REPO ROOT), `v1.1.0-implementation-plan.md` |
| `docs/dev/specs/` | everything in `docs/superpowers/specs/` (13 incl. this spec) |
| `docs/dev/plans/` | everything in `docs/superpowers/plans/` (11 incl. this spec's companion plan) |
| `docs/dev/checklists/` | `v1.0.1-ui-tweaks-checklist.md`, `v1.0.2-ui-pass-checklist.md`, `perf-pass-2026-07-17-checklist.md` |
| `docs/agents/` (NEW) | `toolset.md` — the agent toolset knowledge library (Part 4) |
| REPO ROOT (NEW) | `AGENTS.md` — cross-harness agent entry point (Part 4) |

`docs/superpowers/` is removed (empty after the moves).

### Reference updates (same commit)

- `scripts/*` comment lines referencing moved research docs (~12 lines:
  `mine-patterns.js`, `mine-precursors.js`, `probe-value-edge.js`,
  `validate-precursor-boosters.js`, `backtest-sure-tips.js`,
  `edge-sentinel.js`). Comments only — zero behavior change.
- `CLAUDE.md`: every `docs/...` path (superpowers specs/plans, research docs,
  checklists, `implementation-plan.md` root mention).
- Root `README.md`: path references.
- Docs-internal cross-links (docs reference each other heavily). Sweep:
  `grep -r "docs/superpowers\|docs/sure-win\|docs/precursor..."` etc. must
  return zero hits outside historical prose that quotes old paths as
  *history* (e.g. memory-bank lesson entries may keep old paths in
  already-dated narrative — update only living references, not quoted
  history; when in doubt, update).
- `src/` needs NO changes (only references `docs/DEPLOYMENT.md` +
  `docs/memory-bank.md`, which stay).

### Convention change (recorded in CLAUDE.md + docs/README.md)

Future specs → `docs/dev/specs/`, plans → `docs/dev/plans/` (this OVERRIDES
the superpowers-skill default location `docs/superpowers/...` — the skills
honor user/project preference). Progress checklists → `docs/dev/checklists/`.

### Verification

- `npm test` stays 723/723 (nothing in tests imports docs paths).
- Post-move grep sweep: zero dangling references to any old path from
  CLAUDE.md, README.md, `scripts/`, `src/`, `web/`, and within `docs/`.
- `git log --follow` spot-check on one moved file shows history preserved.

---

## Part 3 — Stale-knowledge audit (currency fixes)

Gaps found in the 2026-07-18 review, each becomes a concrete edit:

1. **CLAUDE.md Commands block omissions**: add `npm run package:deploy
   [-- --export-db]` (with the main-only + idempotent-tag rule),
   `node scripts/db-export.js`, and `node scripts/edge-sentinel.js` (a
   standing daily instrument, currently undocumented in Commands).
2. **CLAUDE.md docs-structure note**: one short paragraph stating the Part 2
   layout + where new docs go.
3. **Root `README.md`**: currency pass — version/feature reality (v1.2.0
   tagged; auth/accounts, tips across seven families, AI worker exist),
   corrected doc paths. Light touch, not a rewrite.
4. **`docs/memory-bank.md`**: dated 2026-07-18 entry bringing "Goals & state"
   current (v1.1.0 accounts → v1.2.0 release → post-tag features: filters
   sync, help glossary; M2 all-markets / M3 any-market tips / M4.1 enrichment
   / M4.2 mining outcomes with their honest verdicts) + the docs-structure
   convention + the new release-from-main rule.
5. **Claude memory**: refresh the stale `oddspro-project-state` hook line in
   `MEMORY.md` (still headlines 2026-07-15/v1.1.0); record the docs-path
   mapping in the resume-point so future recalls don't chase dead paths.
6. **CLAUDE.md agent-library pointer** (Part 4): direct automated agents to
   `AGENTS.md` / `docs/agents/toolset.md`.

---

## Part 4 — Agent toolset knowledge library

**Problem:** much of what makes sessions efficient lives in the incumbent
agent's PRIVATE session memory (process-tree cleanup, PowerShell 5.1 traps,
browser-E2E rituals, serve lifecycle) — invisible to Opus, Codex, Gemini, or
any fresh harness. The library exports the transferable parts into the repo.

**Artifacts:**

1. **Root `AGENTS.md`** (~40 dense lines) — cross-harness entry point (the
   `AGENTS.md` convention is auto-read by several non-Claude harnesses; Claude
   Code reaches it via the CLAUDE.md pointer). Contains: read-order
   (CLAUDE.md architecture → `docs/agents/toolset.md` operations →
   `docs/memory-bank.md` issue history), the HARD-INVARIANTS shortlist (the
   strict do-not-break guardrails for unoriented models), and the library
   maintenance protocol.
2. **`docs/agents/toolset.md`** — the library. Agent-density sanctioned
   (user: "keep it as complex as necessary"). VERIFIED-ONLY rule: every
   command/procedure recorded was actually run in a session; aspirational
   content is banned. Sections: environment map (Windows/PS 5.1 quirks,
   Docker DB, ports); operational playbooks (test loop, serve lifecycle,
   frontend dev + orphan ports, browser E2E incl. huge-snapshot workaround +
   cleanup ritual, DB ops, release packaging, pipeline/AI-worker ops);
   what-to-use-when decision table (which analysis script answers which
   question, e.g. `analyze-safe-tips.js` BEFORE touching `DEFAULT_SAFE`);
   operational issues KB (dated, cause → fix/mitigation, cross-referencing
   `docs/memory-bank.md`'s numbered resolved issues instead of duplicating —
   memory-bank REMAINS the historical/code-level KB and the DARK-switch
   dated-note target); doc/knowledge topology (where things live, where new
   docs go, separation-of-duties rule).
3. **CLAUDE.md pointer** — one line directing agents to consult
   `docs/agents/toolset.md` before inventing operational procedures, and to
   append dated verified entries after solving novel operational problems.

**Maintenance protocol (written into both files):** append-only dated
entries; verified-only; never delete a working recipe without a replacement;
supersede with a dated note rather than silent rewrite.

**Content source:** drafted IN the implementation plan (full inline text)
while the incumbent session's experiential knowledge is at hand; execution
lands it mechanically.

## Risks & notes

- **Tag semantics going forward**: a release = user bumps root+web
  `package.json` versions (user-owned, release-time) → `npm run
  package:deploy` on `main` → artifacts + `v<new>` tag pushed. Re-runs
  without a bump: artifacts rebuilt, tag skipped (warning if HEAD moved).
- **Moved-path bookmarks** (external notes, old chat logs) break —
  accepted in the design review.
- **Memory files elsewhere** may cite old docs paths in historical narrative;
  the recall rule ("verify paths still exist") + the resume-point mapping
  covers them. Update opportunistically on touch, no bulk rewrite.
- `release/` and `backups/` are gitignored (verify during execution) — DB
  dumps must never land in git.
