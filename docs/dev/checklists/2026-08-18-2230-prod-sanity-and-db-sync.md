# Checklist: prod sanity + DB sync (2026-08-18)

Plan: `docs/dev/plans/2026-08-18-2230-prod-sanity-and-db-sync.md`. Spec: `docs/dev/specs/2026-08-18-2230-prod-sanity-sync-and-data-platform.md`.
Status values: pending / in progress / completed / blocked (owner).

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0a | Live probe + findings F1-F10 | completed | 2026-08-18 22:00-23:00 EAT |
| 0b | Guarded settle SQL on main (0ab87e1) | completed | suite 942/942 |
| 0c | Interim hotfix on live v1.4.0 file + one instance restarted | completed | 20:45Z; two stale instances still on old code (owner: kill or cPanel Restart) |
| 0d | Verify live light pass recovers (`light ok`, matches.updated_at moves) | completed | 21:00:57Z `light OK 10s`, 1844 matches refreshed, updated_at 2026-08-19 00:00:56 EAT |
| 1 | meta table + src/meta.js | completed | c8a3795 |
| 2 | writer lease | completed | 9a1a988 + 736c0a2 (re-entrancy guard) |
| 3 | lease-gated schedulers + meta version | completed | 564c859 |
| 4 | follower-safe manual refresh + catalog from meta | completed | 936f5c7 + d3b6773 (cooldown/fresh guards on queued refresh) |
| 5 | narrowed settle + stderr trim + refetch-fixtures | completed | 7d77c81; API-Football keeps the 21 inconsistent finals as-is |
| 6 | scripts/lib remote + sync-rules (+ deploy-remote refactor) | completed | bc336a7 + 9cb60d0 |
| 7 | db-import.js | completed | 27814f5 (full local round trip 385 s) |
| 8 | db-sync.js status/backup/pull/push + local brought current | pending | Sonnet build, Fable runs the live pulls |
| 9 | hotfix-remote.js | completed | af50887 + 95d8e88 |
| 10 | ship v1.4.0 build 2, verify, drop dead DBs, docs | blocked (owner) | release 20260819_013316 built, tag at HEAD locally; waiting for owner to stop the cPanel app |
| 11 | Google Analytics tag missing on live | completed (ships with build 2) | root cause: `VITE_GA_ID` unset at build time (commented out in `.env.production`); set to G-2CNKRP1W0Q, test build injects the snippet. Owner: privacy page still says "no third-party analytics scripts". |
| 12 | Owner pauses: stop/restart cPanel Node.js App during the build-2 apply | blocked (owner) | PAUSED HERE: stop the app, then I deploy, then you start it |
| 13 | Completion report + GA test greenlight to owner | pending | after build 2 is live |
| 14 | Bonus assessment: decouple the always-running server.js from the source tree for hot-swaps | pending | proposal in the completion report (versioned app roots + `current` symlink, or writer/serve process split) |
