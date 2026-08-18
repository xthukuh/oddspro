# Production sanity, DB sync, and the odds data platform (DRAFT brief)

Status: DRAFT, awaiting owner decisions (section 5). Written 2026-08-18 ~22:30 EAT
after a read-only probe of the live host over `ssh oddspro`. This document is the
stitched-together version of the owner's 2026-08-18 request; once the decisions are
made it becomes the spec and a plan/checklist pair with the same stamp follows.

## 1. The request, restated as one path

The owner's fast-typed request contains six workstreams. In dependency order:

1. **Production sanity (now).** Probe the live host, find and fix what is broken,
   without cutting a new release. Caching and cache-busting were called out.
2. **Reusable DB synchronization** built on `scripts/db-export.js` plus a new reverse
   `scripts/db-import.js`, so local and live hold the same real data (one source of
   truth for facts: fixtures, results, odds). Compressed and compact dumps, progress
   during long runs, pick-and-choose what to sync. Then use it to bring the local DB
   up to date and to repair data.
3. **Storage economy and schema hygiene.** Review how the DB is structured, remove
   deprecated or unusable data, never grow exponentially. Keep everything collected so
   far that is usable; where old data misses fields introduced later, prefer the most
   complete usable set and drop the rest.
4. **Kickoff-anchored odds snapshots.** Persist a timed history of odds per fixture at
   T-24h, T-12h, T-6h, T-2h, T-1h before kickoff, then during the live game until markets
   close. Fixture kickoff is the anchor for the update schedule, replacing the wasteful
   fixed 15-minute light pass on quiet slates.
5. **Decoupled fetch platform + REST API.** Isolate "real verifiable data fetching and
   referencing" (cross-bookmaker fetch, harmonization, correlation to canonical
   fixtures) into the smallest scalable algorithm, expose it as a REST API that can be
   monetized as the central oddspro.ke business model. Enrichment, prediction and slip
   playgrounds become add-on modules on top of it.
6. **Replicable bookmaker-adapter skill.** Capture the owner's manual method (Chrome
   DevTools network capture: date-filtered fixtures endpoint with exhaustive pagination,
   then per-match markets; bare-minimum guest headers; throttle awareness) as a
   persisted, repeatable skill plus tooling that scaffolds a new bookmaker adapter and
   keeps existing ones health-checked in the background.

Overall constraint: complete overhaul is on the table, but no data collected so far may
be lost, and nothing here is a new version release.

## 2. What the probe found (2026-08-18, live host)

Host: `rs1.hpcnoc.com`, shared cPanel + LiteSpeed, load average 21, disk 80 % used
(shared volume). App root `~/oddspro-app-v1.4.0`, DB `oddsprok_prod_1_4_0`,
MariaDB 10.11.18, `sql_mode` empty, `slow_query_log` OFF, no `max_statement_time`
(the host still kills long scans: "Lost connection to server during query").

| # | Finding | Evidence | Severity |
|---|---------|----------|----------|
| F1 | **Warehouse frozen since 2026-08-16 01:20 EAT.** The results-settle `UPDATE` (step 1 of every light pass and of the daily full sweep) throws `ER_DATA_OUT_OF_RANGE` because fixture 1556592 is `FT 0-0` with `HT 1-0` and the score columns are UNSIGNED. 270 light + 3 full passes failed in the surviving log window; earlier failures were trimmed by the self-truncating log. | `logs/auto-refresh.log`, `stderr.log`, `matches.updated_at MAX = 2026-08-16 01:20:12` | critical (fixed on `main` 0ab87e1; live hotfix awaits one approved command) |
| F2 | **Three `lsnode` instances of the app run concurrently** (2+ days each). Every in-process singleton is triplicated: three schedulers (full sweep fired 3x at 02:00), three AI workers, three per-process `data_version` counters and response caches. Clients hitting different instances see different versions; the second/third writer is the deadlock source the codebase already warns about. | `ps -u oddsprok`, three `full ERROR` lines at 02:00:10/13/26 | high (root cause of the "caching" complaint) |
| F3 | **`/api/columns` warm-up scan fails 725 + 624 times**: `SELECT type_name,name,handicap,COUNT(DISTINCT match_id) FROM odds_markets GROUP BY ...` over 8.7 M rows is killed/timed out on the shared DB, and each instance recomputes it at every boot. | `stderr.log` | high |
| F4 | **DB connectivity churn**: `ETIMEDOUT`/`ECONNREFUSED 127.0.0.1:3306`, "Connection lost", MariaDB uptime 17.6 h at probe time (a restart), `Aborted_connects` 17,809. Shared-host reality; the app must tolerate it (it mostly does: fail-open, retries). | `stderr.log`, `SHOW GLOBAL STATUS` | medium |
| F5 | **The settle `UPDATE` rewrites every linked final match on every pass** (~49 k rows on live, 13 k locally, no `WHERE m.completed_at IS NULL`). Cheap locally, wasteful on a stressed shared DB. | code, local rolled-back replay affected 13,022 rows | medium |
| F6 | **Three databases: `oddsprok_prod` 2.7 GB, `oddsprok_prod_1_3_0` 4.8 GB, `oddsprok_prod_1_4_0` 3.0 GB** (10.4 GB). Only `_1_4_0` is live; the others are dead deploy copies. | `information_schema.tables` | medium (owner-gated cleanup) |
| F7 | **`odds_markets` is the storage hog**: 8.7 M rows, 1.36 GB data + 1.26 GB index (the varchar catalog index `(type_name,name,handicap,match_id)` is as big as the data), ~177 rows per match, `type_explainer TEXT` per row. Also `fixture_api_predictions.raw` averages 25 KB/row (105 MB for 4 k rows) and `fixtures.metadata LONGTEXT` (135 MB / 100 k rows). | `SHOW CREATE TABLE`, sizes | design input for workstreams 3-4 |
| F8 | **21 fixtures with HT > FT** exist on both DBs (awarded games and API glitches, 2021-2026). Only a LINKED one crashes the settle; the guarded SQL stores NULL second-half for them. | probe query | low (data repair candidate) |
| F9 | Divergence local vs live: live is richer for <= 2026-08-16 (bookmaker rows for Aug 15: 787+2365 vs local 425+637), local is richer for >= 2026-08-17 (Aug 17: 125+414 vs live 96+108; local scraped through 2026-08-17 20:48). Neither side is complete; the union is. Prediction ledgers and daily slips have also diverged since the 2026-08-07 fresh deploy. | per-date counts both sides | design input for workstream 2 |
| F10 | `stderr.log` is unbounded (2.5 MB, 27 k lines); OpenRouter free-model "no message content" replies are frequent but fail-open. | `stderr.log` | low |

## 3. Proposed program (recommendation)

### A. Production sanity, no release
- A1 (done on `main`, awaiting live apply): guarded second-half split.
- A2 **Single-writer lease**: one MySQL `GET_LOCK('oddspro:writer', 0)` held by the
  instance that wins at boot (re-tried every tick); only the holder runs the scheduler,
  AI worker, geo backfill and the catalog warm. Other instances are read-only API
  servers. Host-independent, no config the shared host must honour.
- A3 **Shared freshness + cache-busting**: a `meta` key/value table (`warehouse_version`,
  `last_success`, `column_catalog` JSON) written by the lease holder after each successful
  refresh; every instance reads `warehouse_version` cheaply (one indexed row) as the ETag
  seed and cache key. Clients get one consistent version, caches invalidate the moment
  data changes, and the column catalog is computed once per refresh instead of once per
  boot per instance (kills F3). Weak ETag / 304 already exist; they become correct.
- A4 Narrow the settle `UPDATE` to rows whose stored scores differ or `completed_at IS NULL` (F5).
- A5 Log hygiene: rotate `stderr.log` (size cap like `auto-refresh.log`).
- A6 **Hot-deploy path**: `scripts/hotfix-remote.js` (upload named files into the live
  app root with backup + `node --check` + `tmp/restart.txt`), so future fixes ship without
  a release. For A2-A4 the practical route is redeploying `main` under the SAME version
  (v1.4.0 build 2, retag) because `server.js`/`auto-refresh.js` have diverged from the
  tag; DB and app-dir names derive from the version so nothing else moves. `--db` is NOT
  run (see B).
- A7 Data repair: re-fetch fixture 1556592 (and the other 20) from API-Football; drop the
  two dead databases after a compressed final backup pulled locally (owner-gated,
  destructive).

### B. DB synchronization tool
`scripts/db-import.js` (reverse of db-export: gz dump -> local Docker or remote DB, with
progress) plus `scripts/db-sync.js` orchestrating: `status` (side-by-side per-table
counts, per-date coverage per provider, staleness), `pull`/`push` with `--tables`,
`--since/--until` date scoping and `--dry-run`. Table classes: **warehouse-canonical**
(fixtures, teams, leagues, standings, fixture_* by fixture id, prematch, api_predictions,
ai_insights: natural API keys, merged by upsert), **bookmaker trio** (matches +
odds_markets + aliases: local ids differ per instance, so merged through a staging table
by the natural key `(provider, provider_match_id)` with id remap, newest `updated_at`
wins per match), **derived ledgers** (fixture_predictions, daily_slips, user_slips:
honesty ledgers, merged by natural key, settled rows never overwritten by unsettled),
**instance** (users, sessions, prefs, tokens, visits, audit, campaigns: never synced,
already listed in deploy-remote.js). Transport: `mariadb-dump --compact --quick
--single-transaction --where=...` piped through `gzip -9` over ssh, byte-progress
meters both ways (the remote has only gzip). First use: pull live -> local (union), then
push local's Aug 17-20 bookmaker rows up (if decision D2 = union).

### C. Storage economy (schema hygiene)
Inputs: F6, F7. Proposals, each reversible and measured before/after with `OPTIMIZE TABLE`:
- Dictionary-encode market identity: `markets_dict(id SMALLINT, provider, type_name,
  name, handicap, canonical_key)`; `odds_markets` keeps `market_id` + price + stale flag
  and drops `type_explainer`/`type_id`/`probability` (never read) and the varchar catalog
  index (the catalog is served from `meta`, A3). Expected: 2.6 GB -> well under 1 GB.
- `fixture_api_predictions.raw`: keep the parsed columns, gzip the raw JSON into a
  BLOB (or drop raw after verifying nothing reads it).
- `fixtures.metadata`: same treatment as `matches.metadata` (retired 2026-08-07).
- Retention tiers for market breadth: canonical + BTTS/DNB forever; the long Betika
  dynamic tail (`raw:` keys, period-tagged) kept N days then pruned (owner picks N).
- Dead DBs dropped (A7).

### D. Kickoff-anchored snapshots + due-queue scheduler
- `odds_snapshots(match_id, market_id, taken_at, price)` compact rows; a snapshot is
  written per fixture at the ladder T-24h/12h/6h/2h/1h and then every N minutes in-play
  until the provider stops listing markets. **Delta encoding**: a row is written only
  when the price differs from the previous snapshot of that market (most pre-match
  prices are flat), plus a per-(match, taken_at) header row so "no change" is
  distinguishable from "not sampled".
- Scheduler: replace the fixed light cadence with a due-queue derived from
  `fixtures.kickoff` (next due = min over upcoming fixtures of the next ladder rung),
  coalesced into one provider call per due window; the results settle keeps its own
  short cadence only while games are in play. Idle slates cost nothing.
- Capacity math (live today: ~200 k odds rows/day at ~300 B): compact rows (~40 B incl.
  index) x 6-8 rungs x ~35 % survival under delta encoding is on the order of 20 MB/day,
  ~7 GB/year, versus ~22 GB/year for the current single-snapshot design.

### E. Decoupled fetch platform + REST API v1
- `src/platform/`: `sources/<bookmaker>/adapter.js` (contract: `listFixtures(date)`
  exhaustive pagination -> `fetchMarkets(matchRef)` -> the existing standardized game
  record), `harmonize/` (canonical market keys, `link.js` correlation), `snapshot/`
  (D), `api/` (REST). The current scrapers become the first two adapters, unchanged in
  behaviour.
- REST v1 (PAT-authenticated, ETag-cached, rate-limited): `GET /v1/fixtures?date=`,
  `GET /v1/fixtures/:id` (canonical fixture + all bookmakers' harmonized markets +
  best price), `GET /v1/fixtures/:id/odds/history`, `GET /v1/bookmakers`,
  `GET /v1/markets`. Metering per token for later billing.
- Enrichment/prediction/slips stay where they are and read through the same modules.

### F. Bookmaker-adapter skill + background contract checks
- A persisted skill (`.claude/skills/bookmaker-adapter/`) encoding the method: DevTools
  capture -> HAR -> identify the date-filtered fixtures endpoint + pagination shape ->
  per-match markets endpoint -> minimal guest headers -> throttle/backoff policy ->
  adapter scaffold + recorded-fixture tests -> registry entry.
- `scripts/adapter-from-har.js` scaffolds an adapter from a saved HAR; a background
  contract probe (one request per adapter per day) flags endpoint drift before the
  warehouse notices.

## 4. Order of execution
A (sanity) -> B (sync, then bring local current) -> C (economy, measured) -> D
(snapshots + scheduler) -> E (platform + API) -> F (skill). Each gets its own
plan/checklist; A and B start immediately after the decisions below.

## 5. Decisions needed from the owner
D1 Live fix path: redeploy `main` under v1.4.0 (build 2, retag) vs cherry-picked file hotfixes only.
D2 Warehouse truth for the sync: union both sides by natural key (recommended) vs live wins outright.
D3 Dead databases `oddsprok_prod` + `oddsprok_prod_1_3_0` (7.4 GB): drop after a compressed backup vs keep.
D4 Retention for the market long tail in snapshots/history: keep everything compact vs prune the non-canonical tail after N days.
