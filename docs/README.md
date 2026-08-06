# docs/ — documentation index

Lean by policy (housekeeping 2026-08-04): completed specs/plans/checklists and superseded
research were pruned — git history keeps them. What remains is current-truth only.
Architecture lives in the repo-root `CLAUDE.md` (authoritative, agent-dense); agent
operational playbooks in `agents/toolset.md` (entry point: repo-root `AGENTS.md`).
Command/routine quick card: repo-root `QUICK-REFERENCE.md`; system-behavior chapters:
`engine/` (index: `engine/00-README.md`).

## Project documentation (here)

- `DEPLOYMENT.md` — the manual cPanel deploy guide (no SSH; zips via `npm run package:deploy`),
  including the "What's new in v1.3.0" pre-flight section for the pending live deploy.
- `engine/` — the system bible: numbered behavior chapters (operating modes, data pipeline,
  linking, predictions, ranking, AI layers, agent procedures). Index + the doc
  update-triggers table: `engine/00-README.md`.
- `memory-bank.md` — resolved-issue lessons (do not re-learn), the AI policy-regime switch
  log, environment facts, and the short current-state block.
- `agents/` — the agent toolset knowledge library (`toolset.md`): verified operational
  playbooks, what-to-use-when, operational issue KB. Entry point: repo-root `AGENTS.md`.
- `guides/` — operator playbooks: `safety-net-protocol.md` (the betting protocol behind the
  Safe toggles), `sms-bonga-integration.md` (SMS provider wire format + live-verify checklist),
  `api.md` (HTTP API reference with captured examples: auth modes, records, Daily MultiBet,
  performance, refresh semantics).
- `research/` — ACTIVE analysis only. Engine-v2 studies live here while the investigation
  runs; a study that is refuted/superseded gets deleted (git history is the archive).
- `visuals/` — image assets referenced by docs.

## Development pipeline (`dev/`)

- `dev/apis/` — Postman collections/environments for external APIs (Bonga SMS).
- `dev/specs/`, `dev/plans/`, `dev/checklists/` — the ACTIVE effort only. A merged,
  verified effort's files are deleted in the housekeeping pass that follows the merge;
  behavior worth keeping moves to `CLAUDE.md` / `engine/` / `memory-bank.md` first.

Naming: dev-pipeline files carry a full-timestamp prefix `YYYY-MM-DD-HHmm-` (24h local);
a spec, its plan and its checklist share the SAME stamp. Forward-only — never rename
existing dated files.

## Where does a NEW doc go?

| Kind | Location |
|---|---|
| Design spec | `docs/dev/specs/YYYY-MM-DD-HHmm-<name>-design.md` |
| Implementation plan | `docs/dev/plans/YYYY-MM-DD-HHmm-<name>.md` |
| Progress checklist | `docs/dev/checklists/YYYY-MM-DD-HHmm-<name>-checklist.md` (same stamp as its plan) |
| Research finding / study | `docs/research/<name>.md` |
| Guide / protocol | `docs/guides/<name>.md` |
| Operational agent knowledge | `docs/agents/toolset.md` (dated append) |
| Resolved code-level issue | `docs/memory-bank.md` §Resolved issues |
| System-behavior chapter | `docs/engine/NN-<NAME>.md` (triggers: `engine/00-README.md`) |
| Command / routine / warning change | root `QUICK-REFERENCE.md` (same commit as the change) |

This layout overrides the superpowers-skill default location (`docs/superpowers/...`) —
the skills honor project preference.
