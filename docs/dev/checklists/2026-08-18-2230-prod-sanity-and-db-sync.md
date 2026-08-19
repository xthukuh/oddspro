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
| 10 | ship v1.4.0 build 2, verify, drop dead DBs, docs | completed | LIVE 2026-08-19 12:05Z, verified (one writer, GA, build id); dead-DB drop gated on the _1_3_0 backup |
| 11 | Google Analytics tag missing on live | completed (ships with build 2) | root cause: `VITE_GA_ID` unset at build time (commented out in `.env.production`); set to G-2CNKRP1W0Q, test build injects the snippet. Owner: privacy page still says "no third-party analytics scripts". |
| 12 | Owner pauses for the cPanel app stop/restart | completed | owner stopped; agent deployed + restored .htaccess + recycled stale instances |
| 13 | Completion report + GA test greenlight to owner | completed | GA live (G-2CNKRP1W0Q); greenlight given |
| 14 | Hot-swap assessment | completed | spec section 7: releases/ + `current` symlink, then split the writer into its own process |
| 15 | Deploy traps found live and fixed | completed | `.htaccess` wipe (6b55f40), surviving old-code `lsnode` instances (killed), `build-id.txt` split-layout lookup (5d88e79, shipped via hotfix-remote) |
| 16 | OpenRouter out of credits (HTTP 402) | blocked (owner) | 3,696 failed AI reviews, zero landing; rules-based tips unaffected |
| 19 | Dead DBs dropped | completed | backups verified independently (gzip -t, CREATE TABLE counts 25/33, trailer, at-risk delta rows present) then `DROP DATABASE`; 7.4 GB freed, live untouched |
| 20 | Passenger idle-shutdown stopped the scheduler | completed | no passes 12:57-14:41 UTC; keep-alive cron `*/5` installed (crontab was empty); durable fix = writer-process split, spec section 7 |
| 22 | GUEST_PREMIUM: guests get tips, stats, Daily MultiBet, Sure Bets | completed | 24551bf, reviewed (no Critical/Important; account-bound surfaces structurally unreachable). Deployed + flipped ON live with API_DETAILS off; browser-verified signed out: future dates, exact confidence, full card ladder, Sure Bets, methodology still hidden |
| 23 | Class A historical backfill (immutable API facts) | completed | 212 stuck fixtures refetched, 130 resolved (263 -> 133, remainder is upstream PST/NS truth), 38 matches settled; deep stats run: 108 fixtures, 216 stats + 21 lineups + 613 events, events gap 54 -> 3, ALL 88 residual stat gaps sit inside the normal 48h retry window (no real gap left); 3 pending tips graded |
| 24 | Outage damage + durability documented | completed | docs/research/2026-08-19-odds-durability-and-outage-damage.md: ~2 days of bookmaker prices unrecoverable (Aug 17: 203 rows, Aug 18: 57 vs 1000-3000 normal), why API-Football data is not at risk, 5 protections shipped, ranked remaining gaps, SaaS moat scoped to workstream E |
| 25 | Ingestion audit + collector defects fixed | completed | 0dc7d1d + 91582e8: betpawa truncated-page silence, empty-snapshot stale-bomb, lying odds heartbeat, one-bad-match-kills-the-day, and the full sweep's missing step isolation (it alone fetches future-date odds). Report: docs/research/2026-08-19-ingestion-pipeline-audit.md |
| 26 | Verified file uploads in deploy tooling | completed | 6409ffc after a live 2.4 MB upload landed as 512 KB with the meter reading 100%; now scp + remote byte check + retries, proven on the next deploy ("verified 2536353 bytes") |
| 27 | Docs housekeeping | completed | f0f4df8: four completed efforts' dev files retired (owner-approved), docs/dev holds only the active effort |
| 28 | NOT covered: apisports.js and link.js audits | open | both audit agents died on API errors; link.js is the higher risk (a confident wrong link teaches a permanent alias) |
| 29 | NOT fixed: no statement/pool-acquire timeout | open | knexfile sets only pool min/max; a runaway query can hold a connection and starve collection |
