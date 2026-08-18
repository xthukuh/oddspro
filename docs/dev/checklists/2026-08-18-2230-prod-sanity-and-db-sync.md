# Checklist: prod sanity + DB sync (2026-08-18)

Plan: `docs/dev/plans/2026-08-18-2230-prod-sanity-and-db-sync.md`. Spec: `docs/dev/specs/2026-08-18-2230-prod-sanity-sync-and-data-platform.md`.
Status values: pending / in progress / completed / blocked (owner).

| # | Item | Status | Notes |
|---|------|--------|-------|
| 0a | Live probe + findings F1-F10 | completed | 2026-08-18 22:00-23:00 EAT |
| 0b | Guarded settle SQL on main (0ab87e1) | completed | suite 942/942 |
| 0c | Interim hotfix on live v1.4.0 file + one instance restarted | completed | 20:45Z; two stale instances still on old code (owner: kill or cPanel Restart) |
| 0d | Verify live light pass recovers (`light ok`, matches.updated_at moves) | completed | 21:00:57Z `light OK 10s`, 1844 matches refreshed, updated_at 2026-08-19 00:00:56 EAT |
| 1 | meta table + src/meta.js | pending | Sonnet |
| 2 | writer lease | pending | Sonnet |
| 3 | lease-gated schedulers + meta version | pending | Sonnet, Fable review |
| 4 | follower-safe manual refresh + catalog from meta | pending | Sonnet, Fable review |
| 5 | narrowed settle + stderr trim + refetch-fixtures | pending | Sonnet |
| 6 | scripts/lib remote + sync-rules (+ deploy-remote refactor) | pending | Sonnet |
| 7 | db-import.js | pending | Sonnet |
| 8 | db-sync.js status/backup/pull/push + local brought current | pending | Sonnet build, Fable runs the live pulls |
| 9 | hotfix-remote.js | pending | Sonnet |
| 10 | ship v1.4.0 build 2, verify, drop dead DBs, docs | pending | Fable (production) |
