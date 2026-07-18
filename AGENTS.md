# AGENTS.md — agent entry point (any harness: Claude, Codex, Gemini, …)

oddspro = MySQL warehouse for Kenyan bookmaker odds (BetPawa/Betika) + API-Football canonical
data, a predictions layer (tips / hot picks / AI adjudication), and a React web table. Node 20+
ES modules, knex/mysql2, zod. Dev box: Windows 11, PowerShell 5.1 default shell, DB in Docker.

**Read order:** 1) `CLAUDE.md` — architecture, commands, invariants (authoritative, dense).
2) `docs/agents/toolset.md` — VERIFIED operational playbooks (test/serve/E2E/DB/release),
what-to-use-when, operational issue KB. 3) `docs/memory-bank.md` — state history, numbered
resolved issues, the AI regime-switch log. System behavior reference: `docs/engine/`
(chapter index + doc-update triggers in `00-README.md`); daily command sequences: repo-root
`QUICK-REFERENCE.md`. New docs go per `docs/README.md` (spec → `docs/dev/specs/`, plan →
`docs/dev/plans/`, checklist → `docs/dev/checklists/`, research → `docs/research/`, guide →
`docs/guides/`; dev-pipeline files carry a `YYYY-MM-DD-HHmm-` timestamp prefix, same stamp
across one effort, forward-only).

**HARD INVARIANTS (do not break; detail in CLAUDE.md):**
- Frozen ledger: prediction/prematch rows freeze at kickoff and settle exactly once — NEVER
  rewrite settled or past-kickoff rows. Measure new rules via the replay scripts, never by
  editing history.
- Fetch-once: never delete or refetch immutable API data (stats/lineups/events/history flags);
  `matches.metadata` is insert-only; root `x-*-output.xx.json` snapshots are frozen fixtures.
- Migrations are forward-only; never edit an applied migration.
- All DB access through the single knex instance (`src/db/connection.js`), never raw mysql2;
  DB-writing batches at concurrency 1; run exactly ONE `npm run serve` (a second writer
  process = InnoDB gap-lock deadlocks).
- Odds market identity = `type_name`, never `type_id` (Betika reuses ids across markets).
- AI adjudicators may veto, never promote. AI-call refactors must be regime-neutral (prompt
  bytes + model tags byte-identical) or bump the tag in the same commit. DARK switches
  (`AI_INJECTION_PREAMBLE`, `AI_CONSENSUS_*`) need an explicit user go + a dated
  `docs/memory-bank.md` entry BEFORE flipping.
- Never move a live generation knob (e.g. `TIP_MIN_PRICE`, `SAFE_*`) mid-experiment without a
  dated note — it partitions the measurement ledger (the 2026-07-10 lesson).
- Never touch `DEFAULT_SAFE` without a fresh `scripts/analyze-safe-tips.js` run.
- Releases are built from `main` only; version tags exist only on `main`
  (`npm run package:deploy` enforces both).
- Secrets live in `.env` only (never git). Guest gating is server-authoritative. Sessions
  store only hashes; never rotate `PIN_PEPPER` casually.
- User-gated ops (live cPanel deploys, DB blob reclaim, billing/top-ups, PAT rotation) belong
  to the USER — surface them once, never track/nag/execute.

**Maintenance protocol (this file + `docs/agents/toolset.md`):** append-only dated entries;
VERIFIED-only (a recipe must have actually been run in a session — aspirational content is
banned); never delete a working recipe without a replacement; supersede with a dated note,
not a silent rewrite.
