# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It is a MAP, not the manual: one line per module, the commands, the load-bearing invariants
and the conventions. The per-module detail lives in `docs/engine/` - see "Where the detail
lives" at the bottom, and read the chapter that owns a subsystem BEFORE changing it.

## Project Overview

oddspro is a MySQL data warehouse for football bookmaker odds and stats. It scrapes odds from two Kenyan bookmakers (BetPawa, Betika), ingests canonical fixture/result/stats data from API-Football (api-sports.io), and correlates bookmaker matches to canonical fixtures via fuzzy matching with learned aliases. Plain Node.js (ES modules); knex/mysql2 for the DB layer; zod validates all external data. The React 19 + Vite 6 + Tailwind 4 SPA in `web/` is the visualization surface.

**Current state: `main` is at v1.4.0, live as of 2026-08-23** (v1.4.0 build 3 plus a same-day
follow-up push carrying the F7 linker scoping, the AI transport-resilience fix and the chunked
calibrator load; same-version redeploys follow `docs/DEPLOYMENT.md` section "v1.4.0 build 2
routine"). Suite is 1221 tests.
In force since:

- **`.env` doctrine (2026-08-07):** credentials and boot infrastructure only; runtime knobs
  live in Admin -> Settings (chapter 01).
- **Engine GEN-2 value ladder (2026-08-08):** `buildDailySlip` v2.0 ships four tier cards per
  day (chapter 05).
- **Multi-instance safety (2026-08-19):** a `meta` table plus a single-writer MariaDB
  `GET_LOCK` lease, so exactly one of the live host's three app instances schedules work
  while all three answer the same shared `warehouse_version` (chapter 01).
- **Honest headline:** no positive-EV market has been established on our books (all-tips
  flat-stake ROI -5.3% as of 2026-08-06 per `/api/performance`). The survival sorts maximize
  win probability, not profit - engine-v2's job is to change that with verified evidence,
  never by assertion.
- **Removed and not coming back** (git history has all of it): the M10 admin DB-transfer
  machinery (`src/db-transfer.js`/`transfer-rules.js`, the chunked NDJSON export/import UI,
  `--sync-db` bundles, `SYNC_IMPORT_ON_BOOT`), the v1.1.0 admin data-viz lab
  (`src/lab.js`/`lab-rules.js`, `/api/admin/lab/*`, `DataLab.jsx`), the 2026-08-04 OpenRouter
  model triage (`src/modeltriage/`, `ModelsSection.jsx`, the `ai-triage` settings group - the
  now-empty `model_triage` table stays, migrations being forward-only), `PerformanceSection`,
  and `src/admin-dashboard.js` (the standalone `GET /admin` HTML dashboard the React
  DashboardSection replaced). That was the 2026-08-07 core-focus trim, part of the same
  deployment-preparedness pass that added the SSH deploy route `scripts/deploy-remote.js`
  (which superseded the DB-transfer machinery) and the AppScript SMS send relay; admin is now
  Dashboard/Settings/Users/Messaging/Database(overview+health)/Tokens/About. Also gone: the
  proof-of-work human gate (2026-07-16) and `matches.metadata` writes.

The v1.4.0 line itself is engine-v2's final touches - Daily MultiBet, PATs, `/api/view`, the
v2 sorts and shareable slips - squash-merged 2026-08-06.

## Commands

```sh
npm install
npm run migrate                     # knex migrate:latest (forward-only migrations)

npm run start [-- days]             # DEFAULT full pipeline (src/pipeline.js): fixtures + odds for today..+3 days
                                    # (`npm run start -- 5` overrides the sweep), then results, link once, stats,
                                    # standings, team history, pre-match snapshots
node src/index.js betpawa [date]    # scrape BetPawa odds → DB, then auto-link
node src/index.js betika [date]     # scrape Betika odds → DB, then auto-link
node src/index.js fixtures [date]   # API-Football fixtures for date → DB, then auto-link
node src/index.js results           # refresh unfinished past-kickoff fixtures; settle scores; mark matches completed
node scripts/refetch-fixtures.js --ids <a,b,c> | --inconsistent
                                    # force-refetch specific API-Football fixture ids (or auto-select every
                                    # FINAL_STATUSES fixture with an ft<ht inconsistency) then re-run the settle
                                    # pass; prints before/after ht/ft/goals and which ids changed
node src/index.js link [provider]   # correlate bookmaker matches ↔ canonical fixtures
node src/index.js stats             # statistics + lineups + events for final correlated fixtures (fetch-once)
node src/index.js standings         # refresh league tables for correlated leagues
node src/index.js history           # backfill team last-N + full head-to-head history for upcoming correlated fixtures (fetch-once)
node src/index.js prematch          # upsert pre-match snapshots for upcoming correlated fixtures (frozen once kickoff passes)
node src/index.js predictions       # API-Football /predictions for upcoming correlated fixtures (fetch-once)
node src/index.js hotpicks          # settle + recompute over-2.5 hot picks + tips (rules + optional AI adjudication/review)
node src/index.js enrich            # M4.1: 3-call AI enrichment for upcoming correlated fixtures (collection only)
node src/index.js aireview          # drain pending hot/tip AI verdicts once (the serve process runs this every 60s
                                    # in-process via src/ai-worker.js; cron-only hosts run it after the sweep)
node scripts/ai-scorecard.js        # read-only per-model-tag AI health (chapter 06 "Instruments")
node src/index.js performance       # flat-stake ROI / hit-rate / bucket report for tips + hot picks (also GET /api/performance)
node scripts/backtest-hotpicks.js   # replay historical fixtures to measure/tune hot-pick gate precision
node scripts/analyze-safe-tips.js   # weekly: LODO grid of the Safe-only gates + runner-up hypothesis re-tests
                                    # (run BEFORE touching DEFAULT_SAFE in src/db/magic-rules.js)
node scripts/mine-patterns.js       # M4.2: replay the 8 PRE-REGISTERED pattern hypotheses over the settled tip
                                    # ledger. Read-only; prints a POLICY-REGIME WARNING when a live knob moved
                                    # mid-window. Findings + method: chapter 05
node scripts/mine-precursors.js     # M4.2: the 2026-07-14 warehouse mine (read-only, ~5 min; chapter 05)
node src/index.js export [date]     # temp CSV of the date's correlated records → tmp/ (gitignored)
node src/index.js geo               # force a visitor-IP → country/region geo backfill (else runs periodically in-process)
node scripts/collection-watchdog.js # cron-run every ~15 min on the live host: reads MAX(matches.updated_at), flags
                                    # stalled odds collection (WATCHDOG_STALE_MINUTES near kickoffs, the longer
                                    # WATCHDOG_QUIET_STALE_MINUTES on a quiet slate), touches tmp/restart.txt to
                                    # recycle Passenger, SMS-alerts the admin after WATCHDOG_ALERT_AFTER consecutive
                                    # stale runs. Never exits non-zero; everything lands in logs/watchdog.log

npm run serve                       # visualization API server on :3001 (serves web/dist when built) + the
                                    # in-process auto-refresh scheduler (light pass every AUTO_LIGHT_MINUTES,
                                    # full sweep daily at AUTO_FULL_AT EAT; AUTO_REFRESH_ENABLED=0 opts out locally)
npm run build:web                   # build the React frontend → web/dist/
cd web && npm run dev               # frontend dev server on :5173 (proxies /api/* → :3001)

npm run package:deploy [-- --export-db] [-- --out-dir <dir>]
                                    # build the two cPanel upload zips into release/ (backend = HEAD via
                                    # git archive, frontend = web/dist); --export-db adds a gzipped DB dump
                                    # (same <ts> stamp). MAIN-ONLY: refuses to run off `main` (releases are
                                    # built from main; version tags exist only on main), then idempotently
                                    # tags v<package.json version> at HEAD + pushes the tag - an existing
                                    # tag is skipped (loud warning when it isn't at HEAD: bump the version)
node scripts/db-export.js [--container <name>]
                                    # standalone gzipped Docker-DB dump -> backups/ (phpMyAdmin-ready; also
                                    # exports exportDb() consumed by package:deploy --export-db)
node scripts/db-import.js <file.sql.gz> [--container <name>] [--database <name>] --yes
                                    # the reverse of db-export.js: gunzip -> mariadb/mysql client inside the
                                    # Docker container (OVERWRITES the target DB; refuses without --yes)
node scripts/db-sync.js status [--json]
                                    # side-by-side local vs live host: row counts + MB per SYNC_TABLE,
                                    # 7-day match coverage by day/provider, freshness, migration head
node scripts/db-sync.js pull [--tables a,b] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--full] [--dry-run] [--yes] [--force]
                                    # per table: remote mariadb-dump | gzip -9 streamed down to
                                    # backups/sync/<table>_<stamp>.sql.gz (kept, doubles as a backup), then
                                    # windowed matches DELETE (trio only) + local import (--replace, kicks
                                    # in kickoff>NOW() freeze the same way the app itself never violates it).
                                    # LIVE WINS: pull only ever overwrites/extends local, never the reverse.
                                    # Default window (no --since/--full): today-3d .. today+8d EAT. Aborts on
                                    # a knex_migrations head mismatch unless --force. Read-only on the host.
node scripts/db-sync.js push --tables a,b [--since ...] [--until ...] [--dry-run] [--yes]
                                    # mirror of pull (local -> remote); implemented in full but this repo's
                                    # operating rule is dry-run only - the live host stays read-only for us
node scripts/db-sync.js backup --remote-db <name> [--dry-run]
                                    # gz dump of ANY remote DB (not just the deploy target) -> backups/
                                    # remote_<name>_<stamp>.sql.gz; verified locally with gzip -t
node scripts/hotfix-remote.js <file...> [--from <dir>] [--restart] [--dry-run]
                                    # emergency file-level live patch (no zip build/full re-extract):
                                    # remote-backs-up each file (cp -n <file>.orig-<stamp>), uploads, node
                                    # --check's .js/.mjs/.cjs (auto-restores + dies on a syntax error),
                                    # prints the rollback command; --restart touches tmp/restart.txt
node scripts/edge-sentinel.js       # standing M4.3 instrument (read-only, ~seconds): anchoring effect,
                                    # AI-market dissent, dissent calibration over fixture_ai_insights

npm test                            # node:test suite (tests/*.test.js) - offline, no DB/live APIs.
                                    # What it covers: docs/engine/07-AGENT-PROCEDURES.md
npm run check:prose                 # ASCII-punctuation gate (scripts/normalize-punctuation.js --check)
```

Routine sequences, warnings and definitions live in root `QUICK-REFERENCE.md`; operational
playbooks in `AGENTS.md` + `docs/agents/toolset.md`.

`[date]` defaults to today; accepts anything `new Date()` parses, or `today`/`now`. All actions are idempotent and cron-able - a Windows Task Scheduler task `oddspro-pipeline` runs `scripts/pipeline-task.cmd` (full sweep → `logs/pipeline.log`) daily at 08:00. There is no linter. Restart `npm run serve` after pulling backend changes - a stale server process holds :3001 with old code.

**Configuration.** `.env` (gitignored, see `.env.example`, validated by zod in
`src/config.js`) holds credentials and boot infrastructure: MySQL (`DB_*`, Laravel-style
names), the pool-safety pair `DB_ACQUIRE_TIMEOUT`/`DB_STATEMENT_TIMEOUT`, API-Football
(`X_APISPORTS_URL`, `X_APISPORTS_KEY`), `OPENROUTER_API_KEY` (never in git), `PIN_PEPPER`,
`ADMIN_TOKEN`/`API_TOKEN`, the Bonga SMS and `MAIL_*` credentials, `API_HOST`. Everything
else is a runtime knob in the Admin -> Settings catalog, where a flip is dated by
`admin_audit`. Knob tables by area: chapter 01 (database, refresh/warm, deploy/bot,
accounts/messaging/analytics), chapter 04 (`TIP_*`/`HOTPICK_*`), chapter 05 (`SAFE_*`),
chapter 06 (AI, including the DARK switches), and `docs/DEPLOYMENT.md` section 8 for the
deploy side. **`./.HALT`** (file, gitignored) refuses boot and stops a running serve within
~30s - the cPanel-Stop-is-unreliable kill-switch.

## Architecture

Pipeline: **odds scrapers + fixtures ingester → MySQL warehouse → linker correlates → results settle → deep stats accumulate**.

Pure rule modules (`src/db/*-rules.js` and the crypto-bearing `src/*-rules.js`) are
zero-import and offline-tested by convention; several are imported VERBATIM by the web so
client and server cannot drift.

**Entry points and scheduling** (detail: `docs/engine/01-SYSTEM.md`)

- `src/index.js` - CLI dispatcher; every action closes the shared knex pool on exit. No action (or `start`/a bare day count) runs `src/pipeline.js`.
- `src/pipeline.js` - the 12-step full sweep (`runStartPipeline`) and the single-date `runDateRefresh` behind the web refresh button; every step guarded per date and per provider.
- `src/auto-refresh.js` + `src/db/auto-rules.js` - the 30s scheduler tick, the single-slot job shared with the manual endpoint, light vs full modes, and the pure schedule math.
- `src/meta.js`, `src/db/lease.js` + `src/db/lease-rules.js` - the cross-instance `meta` memo and the single-writer `GET_LOCK` lease that decides which instance schedules work.
- `src/server.js` / `src/export.js` - the :3001 Express API (records, columns, magic-sort, refresh, auth, admin, beacons) and the CSV export action.
- `src/http-cache.js` + `src/db/cache-rules.js`, `src/warm.js` + `src/db/warm-rules.js` - the version-keyed response memo and the warm keeper that precomputes it ahead of demand.
- `src/notices.js` + `src/db/notice-rules.js` - data notices: `collection_runs` is the ledger, `data_notices` the published warnings, `/api/coverage` the machine surface.
- `src/maintenance.js` + `src/db/maintenance-rules.js` - the scheduled-maintenance window, its 503 gate and the quiesce policy.
- `src/halt.js`, `src/db/odds-refresh-rules.js` - the `.HALT` kill-switch and the light-pass odds backoff/idle rules.
- `src/db/migrate-rules.js`, `src/db/retry-rules.js`, `src/db/net-rules.js`, `src/bot-rules.js`, `src/crypto-utils.js` - boot-migration summary, deadlock retry, transient-network classification, the bot-UA blocklist, and `sha256Hex`/`bearerMatches`.

**Collection and the warehouse** (detail: `docs/engine/02-DATA-PIPELINE.md`)

- `src/betpawa.js` / `src/betika.js` + `src/db/collector-rules.js` - the two bookmaker scrapers (browser-mimicking axios clients over undocumented public APIs, one standardized game record) plus the pure page-envelope classification that makes a truncated day impossible to mistake for a complete one, and `isVirtualCompetition`.
- `src/apisports.js` + `src/apisports-fixtures.js` / `src/apisports-events.js` / `src/apisports-standings.js` + `src/db/rate-rules.js` - the API-Football client, its fetchers, tolerant per-item parsing and the quota/burst rules.
- `src/db/connection.js` - the only knex instance (never raw mysql2); the session `time_zone` is pinned to +03:00 in `knexfile.js`.
- `src/db/store.js` + `src/db/odds-diff.js` - odds persistence: match upsert, market diff, stale-market retention, the suspicious-empty-snapshot guard.
- `src/prematch.js` + `src/db/prematch-calc.js` - the frozen pre-match snapshot writer and the pure calc it shares with the read layer.
- `src/markets.js` - the canonical market registry plus the M2 generic taxonomy (`canonicalMarket`, `marketIdentity`, `discoverMarketColumns`), display and filter only.
- `src/db/records.js` + `src/db/filter-csv.js` - the read layer (`queryRecords`, `columnCatalog`, the odds pivot, guest redaction, the orientation-aware score display) and the CSV-list filter parser.
- `src/utils.js` - `_date`, `_dtime`, `_batch` (keep DB-writing batches at concurrency 1 - parallel delete+insert transactions deadlock on InnoDB index gap locks).

**Correlation** (detail: `docs/engine/03-LINKING.md`)

- `src/link.js` + `src/db/link-rules.js` - the fuzzy scorer and acceptance gate, alias learning and its stricter teaching bar, the batched league-scoped candidate pool, the one-claim-per-provider contest, and orientation re-validation. Repair tools: `scripts/repair-duplicate-claims.js`, `scripts/repair-orientation.js`, `scripts/forget-alias.js`.

**Prediction** (detail: `docs/engine/04-PREDICTIONS.md`)

- `src/hotpicks.js` - `updateHotPicks()` (settle, then re-evaluate every upcoming correlated snapshot-backed fixture), the standalone `settleHotPicks()`, the shared `loadTeamHistory()`, `hotpicksSummary()` and `performanceSummary()`.
- `src/db/goals-rules.js` - the pure Over-line hot-pick gates, devig, fairness-paired aggregates.
- `src/db/tip-rules.js` - the pure tip deduction: eligibility, seven market families, the confidence blend, book-integrity guards, `tipOutcome` settlement.
- `src/db/perf-rules.js` - the pure flat-stake ROI / hit-rate / bucket calculation.

**Ranking and selection** (detail: `docs/engine/05-RANKING.md`)

- `src/db/magic-rules.js` - calibration, the legacy 11 strategies and the v2 `banker`/`target`/`value` menu, `magicSortRows`, the safe pool, sure bets, `tipMarketLabel`. Shared VERBATIM with the web.
- `src/magic.js` - the thin knex loader behind `GET /api/magic-sort` (`settledTipRows`, the resolved `safe` policy, the per-day memo).
- `src/daily-slip.js` - the Daily MultiBet builder (`buildDailySlip`) and the walk-forward leg-cell calibrator (`loadCalibrator`).
- `src/db/mine-rules.js` + `scripts/mine-patterns.js` - the read-only pattern mine, its anti-false-positive controls and its closed class vocabulary.

**AI layers** (detail: `docs/engine/06-AI.md`)

- `src/enrich.js` + `src/ai/` + `src/db/ai-rules.js` - M4.1 enrichment (facts / blind / anchored), the provider seam over `src/ai/openrouter.js`, task routing and the blind-model independence rule. COLLECTION ONLY: nothing here feeds `bestTip`, confidence or any ranking.
- `src/ai-worker.js` + `src/db/adjudicate-rules.js` - the background worker that owns every verdict write, its derived work predicate and the reuse keys.
- `src/ai/harness.js` + `src/ai/adjudicators.js` + `src/db/ai-guard-rules.js` + `src/ai-parse.js` - the one guarded path every structured AI call takes, the prompts and model tags, the run guard, and the pure reply decoding.
- `src/scorecard.js` + `src/db/scorecard-rules.js` - the read-only AI scorecard behind `scripts/ai-scorecard.js`.

**Accounts, admin and analytics** (detail: `docs/engine/01-SYSTEM.md`)

- `src/auth.js` + `src/auth-rules.js` / `src/authlimit-rules.js` + `src/errors.js` - the auth service, scrypt/session/OTP crypto and rules, rate limits, `AuthError`.
- `src/sms/*` + `src/db/sms-rules.js`, `src/mail/*` - the Bonga SMS seam and the mail seam behind the M13 email-OTP fallback. Recovery tool: `scripts/reset-users.js`.
- `src/settings.js` + `src/db/settings-rules.js` - the curated admin-editable settings catalog merged over immutable config defaults.
- `src/admin-users.js` + `src/db/admin-rules.js`, `src/campaigns.js` + `src/db/campaign-rules.js` + `src/sms/templates.js` - admin user management (M8) and SMS templates + broadcast campaigns (M9).
- `src/prefs.js` + `src/db/prefs-rules.js` - cross-device prefs sync, last-write-wins.
- `src/db/feature-rules.js`, `src/db/access-rules.js` - THE premium feature registry (one `minTier` edit gates a surface) and the guest-tier projection it feeds.
- `src/visits.js` / `src/db/visit-rules.js`, `src/geo.js` / `src/db/geo-rules.js`, `src/track.js` / `src/db/track-rules.js` - page-view analytics, the geo backfill and tracking v2's beacons.
- `src/db-info.js` - read-only DB observability behind `/api/admin/db/overview|health`.

**Web client** (detail: `docs/engine/08-WEB-CLIENT.md`)

- `web/` - the React 19 + Vite 6 + Tailwind 4 datatable: iPadOS-style shell and theme tokens, unified multi-sort, the filter builder, view toggles and the subset warning strip, the betslip playground, Daily MultiBet / Safe / Sure-bets surfaces, the records LRU + persistent seed, auth overlays and the lazy admin panel. The betting protocol behind the Safe toggles is `docs/guides/safety-net-protocol.md`.

### Key invariants

- **Fetch throttling:** `matches.completed_at` set ⇒ odds refreshes skip the match. Fixtures reaching a terminal status (`FT/AET/PEN/AWD/WO/CANC/ABD`) complete their linked matches; the fallback completes anything still open 4h past `COALESCE(f.kickoff, m.start_time)` - **the CANONICAL kickoff wins whenever the match is linked**, because `matches.start_time` is bookmaker-provided and goes stale on a reschedule (seen 24h adrift). Keying the fallback on `start_time` alone permanently froze rescheduled games (completion is a one-way door - nothing ever clears `completed_at`), costing them all further odds coverage; fixed 2026-07-21.
- **Fetch-once stats:** `fixtures.stats_fetched_at`/`lineups_fetched_at`/`events_fetched_at` guarantee each final fixture costs at most 3 detail requests ever. Empty responses only set the flag after 48h post-kickoff (minor leagues may never publish stats). Never delete or refetch immutable API data.
- **Pre-match snapshots freeze at kickoff:** `fixture_prematch` rows are upserted every run while the fixture is upcoming and never written after kickoff - historical pre-match stats must stay exactly as they were, unaffected by later matches.
- **Hot picks freeze at kickoff and settle exactly once:** `fixture_predictions` rows use the same `kickoff > NOW()` selection-freeze; the settle pass (canonical FT scores → `result_goals`/`outcome`) is the only writer of those columns. The hit-rate scoreboard is honest by construction - never rewrite a settled or past-kickoff pick. AI adjudication is optional (no `OPENROUTER_API_KEY` = rules-only) and can only veto, never promote; API `/predictions` uses the fetch-once flag `fixtures.predictions_fetched_at`.
- **Fetch-once history:** `fixtures.history_fetched_at` guarantees each upcoming correlated fixture costs at most 3 backfill requests ever (2× team last-N, 1× full head-to-head). Only FINAL_STATUSES items are saved - headtohead also returns future meetings, which must not leak into the results refresh set.
- **Results are canonical:** the `results` action copies authoritative scores from final fixtures into linked matches (bookmaker-parsed scores are unreliable for upcoming games - BetPawa reports 0-0, Betika null).
- **Betika null fields:** `home_team_id, away_team_id, region_id, region_name, category_id, competition_id` are always null (not exposed by its API).
- **A simulated competition is never linked, and never deleted.** Betika's `-Zoom`/`SRL` products have no real-world counterpart, so no canonical fixture can ever exist for them. `matches.is_virtual` (written at scrape time, see `src/db/collector-rules.js`'s `isVirtualCompetition`) excludes them from the linker's WORK only - the rows keep their odds and stay served. The predicate matches its two tokens at a word boundary and never as a bare substring: a false negative costs CPU on a pass that already runs, but a false positive permanently orphans a real match (never linked, so never scored, tipped or hot-picked, and nothing re-examines it).
- **One claim per provider:** a canonical fixture (`fixtures.id`) may be held by at most one match per provider at a time. When two listings of the same provider contest it (a reschedule), the listing whose `start_time` sits closest to the canonical kickoff wins (`src/db/link-rules.js`'s `claimVerdict`) and the loser is unlinked with its inherited scores cleared; `completed_at` is untouched by this eviction, the fetch-throttling invariant above still governs it.
- **A match's stored score is always in the canonical fixture's orientation:** `matches.home_score_fulltime`/`away_score_fulltime` etc. never get swapped to match the bookmaker's team-name order, even when API-Football has reversed the fixture's sides after linking. `matches.sides_swapped` (maintained by `src/link.js`'s `revalidateOrientation`) is what reconciles the two at READ time - `src/db/records.js` swaps the displayed score when it is set, so names and score always tell the same story without ever touching the settle SQL or the stored columns.
- **Access tiers are server-authoritative (v1.1.0; `GUEST_PREMIUM` extension):** guest redaction/date-gating happens in `records.js`/`server.js`, never client-only; the response memo key MUST carry the tier (a guest and a full body can never share a cache slot). `AUTH_ENABLED=0` and machine bearers are the legacy full-access path (`access=null`). The admin-editable `GUEST_PREMIUM` setting (default off) opens `canFuture`/`fullDetail` for every signed-out visitor without a session, but the resolved `role` stays `'guest'`: account-bound features (saved/shareable slips, prefs sync, admin) never open on this flag, only on an actual session. Sessions store only sha256 hashes (a DB leak yields no usable token); rotating `PIN_PEPPER` invalidates every stored PIN (deliberate global reset, never do it casually).
- **A notice is served before it is approved.** An auto-detected notice is shown with an `UNCONFIRMED` prefix from the moment it is proposed, so the warning still works while nobody has reviewed it. Approval removes only the prefix, never changes what the notice says. A dismissal is permanent: the `(source, kind, date_from, date_to)` unique index means the detector can never re-raise a span an admin threw out.
- **Damage is read from the collector, never inferred from the data.** A row-count rule was measured against the live warehouse and refuted: it fires on five healthy days in a 45-day window, because the capture regime shifted on 2026-08-05 and thin midweek slates are indistinguishable from outage days by volume. Detection uses `collection_runs`, the ledger of the pipeline's own ok/partial/error verdicts.
- **One writer, many readers.** Exactly one process may hold the `oddspro:writer` lease and run the scheduler, AI worker, geo backfill and catalog warm; every other instance serves reads and queues its refresh requests through `meta`. Run only ONE `serve` locally - a second concurrent writer is the deadlock source.
- **A generation knob never moves mid-experiment without a dated note.** Moving `TIP_MIN_PRICE` 1.20 → 1.35 on 2026-07-10 silently partitioned the tip ledger on the temporal-OOS boundary and every price-correlated test measured the config change instead of the hypothesis.
- Migrations are forward-only; never edit an applied migration.

## Conventions

- ES modules, `async/await`, 4-space indentation (workspace setting - overrides the usual 2-space Node default), single quotes, semicolons.
- Foreign keys use `ON DELETE CASCADE`/`RESTRICT`; a NULLABLE audit pointer may use `ON DELETE SET NULL` (prior art: `settings.updated_by`, batch 11 - deleting a user must not delete the settings they once touched). Migrations that seed data may read `process.env` directly (they run under the knex CLI as well as the app; prior art: the users migration's `ADMIN_SEED_PIN`/`PIN_PEPPER`).
- All external data (API responses, env) through zod schemas; keep field schemas tolerant (`nullable().optional()`) - live data has taught this (`league.round` can be null; `/fixtures/events` `type` can be null - parsed by the tolerant `src/apisports-events.js`, and per-fixture ZodErrors are caught so one bad record can't abort a sweep).
- Prose is ASCII-punctuation only (no em dash, en dash, curly quotes or ellipsis character); `npm run check:prose` enforces it repo-wide and a pre-commit hook runs the same gate.
- `x-*-output.xx.json` files at the root are legacy fetched-data snapshots - do not delete.
- Docs layout (lean policy since 2026-08-04): root `docs/` holds PROJECT documentation (`docs/README.md` is the index: `DEPLOYMENT.md`, `memory-bank.md`, `guides/`, `research/`, `agents/`, `visuals/`); `docs/dev/` holds the ACTIVE development effort only (`specs/`, `plans/`, `checklists/`, `apis/`) - a merged, verified effort's files are DELETED in the follow-up housekeeping pass (behavior worth keeping moves to CLAUDE.md / `docs/engine/` / `memory-bank.md` first; git history is the archive). NEW docs: spec → `docs/dev/specs/`, plan → `docs/dev/plans/`, checklist → `docs/dev/checklists/`, research finding → `docs/research/`, guide → `docs/guides/` (this OVERRIDES the superpowers-skill default `docs/superpowers/...` location). Dev-pipeline files use a full-timestamp prefix `YYYY-MM-DD-HHmm-<topic>.md` (24h local; the spec/plan/checklist of one effort share the SAME stamp; forward-only - never rename existing dated files). Root `QUICK-REFERENCE.md` = command/routine quick card + warnings + definitions - update it in the SAME commit whenever a command or routine changes. `docs/engine/` = numbered system-behavior chapters; `docs/engine/00-README.md` holds the index + the update-triggers table - update the matching chapter in the same commit as a behavior change. Releases: built from `main` only via `npm run package:deploy`; version tags exist only on `main`.
- Agent operations: consult `AGENTS.md` + `docs/agents/toolset.md` (verified command playbooks, what-to-use-when, ops issue KB) BEFORE inventing operational procedures; after solving a novel operational problem, append a dated verified entry there.

## Where the detail lives

| Subsystem | Chapter | What you find there |
|---|---|---|
| Operating modes, the 12-step sweep, light/full/manual, serve behavior, multi-instance lease + shared meta, caching and the warm keeper, data notices, maintenance, the HTTP API surface, accounts/settings/feature-registry/analytics, config knob tables | `docs/engine/01-SYSTEM.md` |
| Sources and trust, fixture lifecycle, the warehouse invariants and why, collector durability, API-Football quota/pacing, odds persistence, market taxonomy, the read layer | `docs/engine/02-DATA-PIPELINE.md` |
| Fuzzy correlation formulas, acceptance thresholds, candidate pooling, alias learning and its escape hatch, claim contest, orientation, virtual competitions | `docs/engine/03-LINKING.md` |
| Hot-pick gate cascade and thresholds, tip eligibility, the seven families, the confidence blend, book guards, settlement, performance measurement | `docs/engine/04-PREDICTIONS.md` |
| Calibration and shrinkage, the strategies (legacy 11 + the v2 trio), LODO replay, `sure`, safe pool, sure bets, Daily MultiBet GEN-2, the pattern mine and what it refuted | `docs/engine/05-RANKING.md` |
| Adjudicators (veto-only), the worker and its budget, enrichment, the guard chain, transport resilience, instruments, AI knobs | `docs/engine/06-AI.md` |
| Agent routing: where things live, change → pre-read → verification, what the offline suite covers | `docs/engine/07-AGENT-PROCEDURES.md` |
| The React SPA end to end | `docs/engine/08-WEB-CLIENT.md` |
| Command sequences, warnings, definitions | root `QUICK-REFERENCE.md` |
| Verified ops playbooks and the ops issue KB | `AGENTS.md` + `docs/agents/toolset.md` |
| Deploy routine and full deploy config | `docs/DEPLOYMENT.md` |
| History, resolved issues, the AI regime-switch log | `docs/memory-bank.md` |
