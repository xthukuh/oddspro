# docs/ — documentation index

Two worlds: this root = PROJECT documentation (what the system is and how to run it);
`dev/` = the DEVELOPMENT pipeline (how it is being built: specs, plans, checklists, the
phase tracker). Architecture itself lives in the repo-root `CLAUDE.md` (authoritative,
agent-dense); agent operational playbooks in `agents/toolset.md` (entry point: repo-root
`AGENTS.md`).

## Project documentation (here)

- `DEPLOYMENT.md` — the manual cPanel deploy guide (no SSH; zips via `npm run package:deploy`).
- `memory-bank.md` — goals/state history, numbered resolved issues (hard-won lessons), and the
  AI policy-regime switch log. The historical/code-level knowledge base; dated DARK-switch
  notes go here.
- `agents/` — the agent toolset knowledge library (`toolset.md`): verified operational
  playbooks, what-to-use-when, operational issue KB. Entry point: repo-root `AGENTS.md`.
- `guides/` — operator playbooks: `safety-net-protocol.md` (the betting protocol behind the
  Safe toggles), `sms-bonga-integration.md` (SMS provider wire format + live-verify checklist).
- `research/` — analysis findings and studies (the honest ledger of what works and what was
  refuted): sure-win analysis, fair comparison / false positives, data independence, precursor
  patterns, emergence-pattern findings + M4 backlog, M4.2b booster validation, AI edge
  sentinel, beat-the-book roadmap, prediction scoping, SPA performance audit.
- `visuals/` — image assets referenced by docs.

## Development pipeline (`dev/`)

- `dev/implementation-plan.md` — the phase-by-phase progress tracker.
- `dev/v1.1.0-implementation-plan.md` — the v1.1.0 accounts release plan.
- `dev/specs/` — design specs (`YYYY-MM-DD-<name>-design.md`).
- `dev/plans/` — implementation plans (`YYYY-MM-DD-<name>.md`).
- `dev/checklists/` — progress/QA checklists for releases and passes.

## Where does a NEW doc go?

| Kind | Location |
|---|---|
| Design spec | `docs/dev/specs/YYYY-MM-DD-<name>-design.md` |
| Implementation plan | `docs/dev/plans/YYYY-MM-DD-<name>.md` |
| Progress checklist | `docs/dev/checklists/<name>-checklist.md` |
| Research finding / study | `docs/research/<name>.md` |
| Guide / protocol | `docs/guides/<name>.md` |
| Operational agent knowledge | `docs/agents/toolset.md` (dated append) |
| Resolved code-level issue | `docs/memory-bank.md` §Resolved issues |

This layout overrides the superpowers-skill default location (`docs/superpowers/...`) —
the skills honor project preference.
