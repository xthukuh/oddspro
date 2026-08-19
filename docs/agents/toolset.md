# Agent Toolset Library — verified operational knowledge

> Harness-agnostic ops reference for ANY agent working this repo. Read AFTER `CLAUDE.md`
> (architecture) — this file is HOW to operate the toolchain, not what the system is.
> RULES: VERIFIED-only (every command/procedure here was actually run in a session;
> aspirational content is banned); append-only dated entries; supersede with a dated note,
> never silently rewrite; never delete a working recipe without a replacement. Code-level
> lessons live in `docs/memory-bank.md` §Resolved issues — cross-reference by number (#N),
> don't duplicate.

## 1. Environment map

- Windows 11 dev box; default shell **PowerShell 5.1** (`powershell.exe`) — see §2 traps.
  Git Bash is available and preferred for POSIX one-liners (`sed`, globs, `git mv` batches).
- Node 20+ ES modules; 4-space indent (workspace rule), single quotes, semicolons; no linter.
- DB: **MariaDB in Docker**, host port 3306; the dump tool inside the container is
  `mariadb-dump` (NOT `mysqldump`). `.env` uses Laravel-style names (`DB_DATABASE`,
  `DB_USERNAME`, …). DB connection failure = HALT and ask the user (global rule).
- Ports: **:3001** = `npm run serve` (API + built web); **:5173** = `cd web && npm run dev`
  (proxies `/api` → :3001); vite silently binds **:5174** when :5173 is orphan-held — always
  read the printed URL (§3.3).
- API-Football plan ~150k req/day — quota is not a practical constraint (the guard stays).
  OpenRouter (sole AI provider since the 2026-08-04 Gemini retirement) HTTP 429 on a
  `:free` slug = daily free quota exhausted (50 req/day free; 1,000/day after the one-time
  $10 top-up) - stop and escalate to the user for a top-up; never swap models to work
  around it (a model switch re-keys the reuse tags = a policy-regime fork).
- Live site `oddspro.ke`: shared cPanel, NO SSH; deploys are manual zip uploads
  (`docs/DEPLOYMENT.md`). Merged-to-main ≠ live.

## 2. PowerShell 5.1 traps (each verified the hard way)

- No `&&`/`||` chaining (parser error). Chain with `;` or `if ($?) { … }`.
- `Out-File` / `Set-Content -Encoding utf8` writes a **BOM** — corrupted 4 markdown files
  on 2026-07-17 (the git diff showed an "invisible" first-line change). BOM-less write:
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.
  Prefer the harness Write/Edit tools for file content; use PS only for orchestration.
- Bulk regex edits over checklists: anchor per line — `(?m)^(\s*)- \[ \] ` — a narrow
  `- [ ] **` pattern misses non-bold checkboxes, and prose mentions of "`- [ ]`" inside
  backticks must NOT match (the line anchor prevents it).
- `ConvertFrom-Json` returns PSCustomObject (no `-AsHashtable` in 5.1).
- A final empty `Select-String` in a chain exits 255 — noise, not failure.
- Port probe: `Get-NetTCPConnection -State Listen -LocalPort 3001,5173,5174`
  (add `-ErrorAction SilentlyContinue` when none may be listening).

## 3. Playbooks

### 3.1 Test loop
- `npm test` — offline node:test, no DB / live APIs, < 2 s. **723 passing @ 2026-07-18.**
  The suite count is quoted in `CLAUDE.md` — update it in the same commit that adds tests.
- Harness note: > 30 KB of output gets persisted to a tool-results file — read the TAIL for
  the pass/fail summary instead of re-running.
- Tests import pure zero-import `src/db/*-rules.js` modules — new decision logic goes in a
  pure module first; that purity is what keeps the suite offline.

### 3.2 Serve lifecycle
- `npm run serve` = API :3001 + in-process schedulers (auto-refresh light/full, AI worker
  60 s tick, geo backfill).
- **Stale-serve trap:** the process holds OLD code after backend edits — restart before
  judging behavior. A web "500 Internal Server Error" usually means the API is down/stale,
  not a code bug (memory-bank #17).
- Run exactly ONE serve. A manual `npm run start` sweep while serve's scheduler runs
  gap-lock-deadlocks on the same odds rows — stop serve first or set
  `AUTO_REFRESH_ENABLED=0` (memory-bank #3/#22).
- `./.HALT` file = reliable stop (boot refusal exit 1 + a running serve exits within ~30 s);
  delete it to allow boot again. Local dev: `AUTO_REFRESH_ENABLED=0` keeps the scheduler quiet.

### 3.3 Frontend dev + orphan ports
- `cd web && npm run dev` → :5173. **Read the printed URL** — an orphaned previous dev server
  makes vite silently bind :5174 and you will E2E-test the WRONG build.
- Kill a dev server by PORT OWNER, tree-wide (npm wrappers on Windows leave node children):
  PS `(Get-NetTCPConnection -LocalPort 5173).OwningProcess` then
  `taskkill /PID <pid> /T /F` (Git Bash spelling: `taskkill //PID <pid> //T //F`).
  Then RE-PROBE ports; expect only :3001 (the user's serve) to remain.
- `npm run build:web` → `web/dist`. A NEW component file with a syntax error still "builds"
  until something imports it — the importing change is the real compile check (memory-bank #19).

### 3.4 Browser E2E (chrome-devtools MCP)
- REUSE the existing blank tab: `list_pages` first, then `navigate_page` that same tab to the
  app. `new_page` orphans a tab the user must close by hand (the last page cannot be closed).
- **Huge-snapshot workaround (verified):** `take_snapshot` on the loaded data table overflows
  the tool token limit — pass `filePath` (scratchpad), grep the saved file for uids/labels,
  then click by uid.
- Console check: `list_console_messages` filtered to error/warn. Network check:
  `list_network_requests` with a resourceTypes filter (used to prove the help-modal iframe
  never loads until expanded).
- Cleanup ritual: navigate the tab back to `about:blank`; stop background shells; kill
  survivors by port PID with the tree flag; re-probe ports. "Clean" = the machine looks like
  it did before the task, minus the intended changes.
- Verify visual redesigns by DRIVING them (both themes, tablet + phone widths) — the offline
  suite cannot see layout (memory-bank #19).

### 3.5 DB ops
- Ad-hoc SQL: `docker exec <container> mariadb -u<user> -p<pass> <db> -e "…"` (find the
  container via `docker ps` — the mysql/mariadb image exposing 3306).
- Dump: `node scripts/db-export.js [--container <name>]` → `backups/oddspro_<ts>.sql.gz`
  (`mariadb-dump` preferred; no CREATE DATABASE — meant for phpMyAdmin import into an
  existing, differently-named DB).
- Restore: `node scripts/db-import.js <file.sql.gz> [--container <name>] [--database <name>]
  --yes` (reverse of the dump above: gunzips on the fly into `mariadb`/`mysql` inside the
  container; refuses without `--yes`, it OVERWRITES the target DB). Also importable:
  `importDb({ inPath, container, database, preamble, onProgress })`.
- Migrations: `npm run migrate` (forward-only). Remote host without SSH: `MIGRATE_ON_BOOT=1`
  self-migrates on restart (fail-fast).
- `backups/` and `release/` are gitignored — dumps must never land in git.
- **DB-sync (verified 2026-08-04, full round trip):** `node scripts/db-sync-export.js
  [--zip out.zip] [--exclude t1,t2]` → NDJSON bundle in `var/exports/<stamp>/`
  (prod tables excluded by construction); `node scripts/db-sync-import.js <dir|zip>
  [--skip t1,t2] [--no-safety] --yes` (dry-run without `--yes`; upsert-only; resumable).
  PREREQ: serve process STOPPED for a CLI apply (separate writers gap-lock). Remote no-SSH:
  extract into `var/imports/<stamp>/` + `SYNC_IMPORT_ON_BOOT=1` (background apply after
  boot+migrate).
- **Cross-DB inspection one-liner (verified 2026-08-04):** ad-hoc knex against ANY local DB
  without touching src config —
  `node -e "import('knex').then(async ({default:knex})=>{const cfg=(await import('dotenv')).config().parsed; const k=knex({client:'mysql2',connection:{host:cfg.DB_HOST,port:+cfg.DB_PORT,user:cfg.DB_USERNAME,password:cfg.DB_PASSWORD,database:'<dbname>'},pool:{afterCreate:(c,d)=>c.query(\"SET time_zone='+03:00'\",e=>d(e,c))}}); /* queries */ await k.destroy();})"`
  — ALWAYS pin the +03:00 session and select DATETIMEs via `DATE_FORMAT` when values cross
  DBs (driver Date decoding reinterprets EAT wall-clock).
- **Merging two SAME-SCHEMA DBs whose rows were created independently: NEVER by
  auto-increment PK** — id spaces are unrelated; a PK upsert rewrites unrelated rows.
  Natural keys only (`matches` = `(provider, provider_match_id)` with odds `match_id`
  remap; `fixtures`/`fixture_prematch`/`fixture_predictions` = API-native PKs, safe).
  Proven by the 2026-08-04 stage-window salvage (22,843 odds rows, 0 orphans).

### 3.6 Release packaging (rule since 2026-07-18)
- `npm run package:deploy [-- --export-db] [-- --out-dir <dir>]` — **MAIN-ONLY** (refuses on
  any other branch; deliberately NO auto-checkout). Builds `release/oddspro-app_<ts>.zip` +
  `oddspro-web_<ts>.zip` (+ `oddspro-db_<ts>.sql.gz` with the flag, same stamp), THEN
  idempotently tags `v<package.json version>` at HEAD and pushes the tag. Existing tag not at
  HEAD → loud "version not bumped" warning, nothing created. Artifacts before tag; tag before
  push; a failed push keeps the local tag (push manually: `git push origin v<version>`).
- A release = the USER bumps root + web `package.json` versions, then package:deploy on `main`.
- Doc/file moves in git: always `git mv` (history survives `git log --follow`).

### 3.7 Pipeline + AI worker ops
- Full sweep `npm run start [-- days]`; per-action `node src/index.js <action> [date]`; all
  idempotent. The sweep bills NO AI — verdict columns are worker-owned (`src/ai-worker.js`,
  60 s serve tick; CLI drain `node src/index.js aireview` for cron-only hosts).
- `TIP_AI_DAILY_CAP` = BILLED verdicts per EAT day; the counter is in-memory PER PROCESS
  (serve holds it across ticks; each CLI run starts fresh; a restart resets — worst case one
  extra cap that day).
- Enrichment (`node src/index.js enrich`) is full-sweep-only by cost design — never wire it
  into the web refresh path.
- AI verdicts can never be backfilled: a grounded call on a played fixture retrieves the
  final score from the web — collection is strictly pre-kickoff, forward-only.

### 3.8 Cross-instance meta + writer lease (verified 2026-08-18)
- `meta` key/value table (`src/db/migrations/20260818000001_meta.js`) + `src/meta.js`:
  shared `warehouse_version`/`last_success` state across the three concurrent live
  `server.js` instances. One-off bump check: `node -e "import('./src/meta.js').then(async
  m => { console.log(await m.bumpWarehouseVersion(), await m.bumpWarehouseVersion(), await
  m.getMeta('warehouse_version')); const { closeDb } = await import('./src/db/connection.js');
  await closeDb(); })"` → expect `1 2 2` the first run (each call is +1 on the stored int).
- Single-writer lease (`src/db/lease.js`) over MariaDB `GET_LOCK('oddspro:writer', 0)` on a
  connection PINNED for as long as the process holds it (`db.client.acquireConnection()` /
  `.connection(conn)` / `db.client.releaseConnection(conn)`). `db.raw(...).connection(conn)`
  returns the raw mysql2 `[rows, fields]` tuple, NOT bare rows: unwrap with `const [rows] =
  await db.raw(...)`, since a bare-rows assumption silently breaks `lockOutcome`.
- **Live two-process check (verified):** process A ran
  `node -e "import('./src/db/lease.js').then(async m => { const ok = await
  m.tryAcquireWriter(); console.log('A', ok, JSON.stringify(m.leaseStatus())); await new
  Promise(r => setTimeout(r, 10000)); await m.stopWriterLease(); const { closeDb } = await
  import('./src/db/connection.js'); await closeDb(); })"`, started first (backgrounded);
  process B ran the same `tryAcquireWriter()` one-liner without the sleep, started ~2s
  later. Result: A logs `[lease] writer gained` and `ok=true`; B gets `ok=false` with
  `last_error:null` (a clean `held-elsewhere`, not a connection failure). After A's
  `stopWriterLease()` releases the lock (`SELECT RELEASE_LOCK(?)`), a fresh process
  re-acquires immediately, confirming no orphaned lock survives a clean stop.
- GET_LOCK is re-entrant on the SAME connection: re-running it every tick while already
  holding the lease returns 1 again and doubles as a liveness check on the pinned
  connection, no separate renew logic needed.

## 4. What-to-use-when (analysis scripts — all read-only unless noted)

| Question | Tool | Notes |
|---|---|---|
| Re-tune Safe-pool gates? | `scripts/analyze-safe-tips.js` | LODO grid; MANDATORY before touching `DEFAULT_SAFE`; weekly cadence |
| Hot-pick gate precision / O-U line sweep? | `scripts/backtest-hotpicks.js [--line]` | 10k+ fixture replay |
| Sure-sort priors / new-family anchors? | `scripts/backtest-sure-tips.js` | warehouse temporal-OOS; feeds `WAREHOUSE_WLO` |
| Live ranking bake-off / sure cross-val? | `scripts/analyze-sure-live.js` | settled-ledger based |
| AI health per model tag? | `scripts/ai-scorecard.js` | hit-rates, veto value, price drift, Brier, coverage |
| Pre-registered pattern hypotheses? | `scripts/mine-patterns.js` | tip-ledger mine; prints a POLICY-REGIME WARNING on mid-window knob moves |
| Warehouse precursor candidates? | `scripts/mine-precursors.js` | the 2026-07-14 Tier-A/B mine, ~5 min |
| Warehouse baselines / odds menu? | `scripts/recon-warehouse.js` | recon |
| Daily value-edge instrument? | `scripts/edge-sentinel.js` | standing M4.3 probe: anchoring effect, AI-market dissent, dissent calibration |
| Flat-stake ROI / buckets? | `node src/index.js performance` | also `GET /api/performance` |
| Wipe/reseed users (changed pepper)? | `node scripts/reset-users.js [--yes]` | DESTRUCTIVE; dry-run without `--yes` |

**Settled negatives — do NOT re-litigate without NEW data:** runner-up tip swap (+108/−128);
H5 golden longshots (2/153 at ≥10x); X2 "+EV" (selection artifact, refuted); O/U line
expansion (no line beats 2.5's ~73% bar); PR-1 ladder (real lift but unbettable, −5.9% at
real prices); anchored-AI probabilities as a ranking signal (sycophancy, ≈ +16pp pull toward
the shown bet). Sources: `docs/research/`.

## 5. Operational issues KB (dated; code-level lessons → memory-bank §Resolved issues)

- 2026-07-17 — **PS 5.1 BOM corruption:** bulk md edits via `Out-File -Encoding utf8`
  prepended BOMs to 4 files; fix = BOM-less `WriteAllText` or the harness Edit tools (§2).
- 2026-07-17 — **Huge-snapshot overflow:** `take_snapshot` on the loaded table exceeds tool
  token limits; `filePath` + grep workaround (§3.4).
- recurring — **Vite orphan port:** E2E ran against :5174 while an orphan held :5173; always
  read the printed URL; kill by port-owner PID tree (§3.3).
- recurring — **Stale serve:** post-edit behavior judged against an old :3001 process;
  restart serve after every backend change (§3.2).
- 2026-07-16 — **Unindexed catalog scan:** `/api/columns` full-scanned the 2.4M-row
  `odds_markets` (> 180 s; the settings modal "wouldn't open"); fix = covering index
  (migration batch 13). Caching cannot save an unindexed query.
- 2026-08-04 — **Split-brain `.env` DB target:** a session left `DB_DATABASE=oddspro-stage`
  (sandbox) and every subsequent run — including the user's own and the daily scheduled
  task — silently wrote there while the real warehouse stalled. Bookmaker odds are NOT
  retroactively refetchable, so the gap is permanent data loss unless salvaged. RULES:
  (a) any sandbox experiment that flips `.env` must flip it BACK in the same session;
  (b) prefer an explicit env override (`DB_NAME=... node script`) over editing `.env`;
  (c) when analysis numbers look absurdly thin, `SELECT DATABASE(), COUNT(*)` FIRST.
- 2026-08-04 — **Scratchpad scripts can't resolve repo packages:** a node script outside
  the repo tree fails `ERR_MODULE_NOT_FOUND` on `knex` (ESM ignores NODE_PATH). Copy it
  into the repo root as `*.tmp.mjs`, run, delete.
- 2026-08-04 — **OpenRouter live smoke (verified):** free blind + grounded call in one
  shot — `node -e "import('./src/ai/index.js').then(async({callModel})=>{...})"` asking
  the grounded task a current-events question; success = text + non-empty `sources`.
  Free-endpoint quirks seen live: transient empty replies ("no message content") and
  429s — both fail-open by design, the breaker guards drains.
- 2026-08-04 — **Env hygiene pair (verified):** `node scripts/env-audit.js` (read-only
  SECRET/DIFFERS/REDUNDANT/UNKNOWN report vs code defaults; run BEFORE any .env trim) and
  `node scripts/gen-secret.js [hex|b64|pin|uuid]` (node:crypto, no deps) for PIN_PEPPER/
  token generation. First audit found 12 redundant lines and 34 load-bearing overrides in
  the 55-key dev .env; trimming by audit output avoids the dropped-override trap.
- 2026-08-07 — **SSH deploy route (verified):** `ssh oddsprok@oddspro-p` (key auth,
  BatchMode works from Git Bash + node spawn). Remote has mysql/mariadb/mariadb-dump/
  gzip/unzip/tar + node v24 at `~/.nvm/versions/node/v24.18.0/bin` (no pv — progress =
  local byte counter feeding the ssh stdin stream). `node scripts/deploy-remote.js
  [--db [--fresh]] [--app] [--web] [--all] [--dry-run]`; config `.env.deploy`, prod
  server env `.env.server`. SQL snippets go over ssh STDIN, never `-e "..."` — a
  scrypt hash's `$`-runs and SQL backticks inside remote double quotes corrupt silently.
- 2026-08-07 — **AppScript SMS relay auth gotcha (verified live):** a web-app deployment
  whose script calls `UrlFetchApp.fetch` fails with "You do not have permission" until
  the project is authorized for `script.external_request` (run any UrlFetchApp function
  once in the editor, approve, then re-deploy a NEW VERSION). Relay response shape is
  parseBongaSend-compatible as-is (Bonga body spread last wins the `status` key).
  Re-test: `node tmp/test-bonga-relay.js`.
- 2026-08-07 — **InnoDB space reclaim (verified):** `UPDATE ... SET blob=NULL` frees
  nothing on disk; `OPTIMIZE TABLE` (recreate+analyze) is what returns it — matches
  went 1571 MB -> 11.6 MB after the metadata purge (whole DB 3.5 -> 1.9 GB).
- 2026-08-18 — **Live-host read-only probe (verified):** `ssh oddspro` (alias of
  `oddsprok@oddspro-p`; host `rs1.hpcnoc.com`, shared cPanel + LiteSpeed). Write the
  probe as a bash script, `scp` it to `~/tmp/`, run it, delete it: DB creds come from
  `~/oddspro-app-v1.4.0/.env` inside the remote script (`MYSQL_PWD=$(grep '^DB_PASSWORD='
  .env | cut -d= -f2-)`), never on the local command line. Filter the ssh banner noise
  with `grep -v "post-quantum\|store now\|openssh.com/pq"`. Live layout: app roots
  `~/oddspro-app-v<ver>` (Passenger/lsnode via `public_html/.htaccess`, node at
  `~/nodevenv/oddspro-app-v<ver>/22/bin/node`), app logs `logs/auto-refresh.log`
  (self-truncating - only the LAST ~26 h of an error storm survive) + unbounded
  `stderr.log`, DBs `oddsprok_prod_<ver_underscored>`. LiteSpeed runs SEVERAL `lsnode`
  instances of the app concurrently (`ps -u $USER -o pid,etime,args | grep lsnode`), so
  every in-process singleton (scheduler, AI worker, `data_version`, caches) is duplicated.
  Long scans on `odds_markets` (8.7 M rows) get killed by the host ("Lost connection to
  server during query"); the shared MariaDB restarts occasionally (ECONNREFUSED 3306,
  `SHOW GLOBAL STATUS LIKE 'Uptime'`). Only gzip is available remotely (no zstd/xz).
  Note: the harness classifier BLOCKS in-place edits of the live app over ssh
  (compound cp/perl/touch); prepare the patched file locally and hand the owner one
  `scp` + restart command instead.
- 2026-08-18 - **Narrowed settle UPDATE + refetch tool (verified):** `settleApisportsResults()`'s
  `matches` settle UPDATE (`src/apisports.js`) used to rewrite every linked final match on every
  light pass regardless of whether anything changed (13,021 rows locally, ~49k live). Added a
  `NULL`-safe `<=>` guard to the WHERE clause so the UPDATE is a no-op once a match already
  matches its fixture. Verified with the rolled-back-transaction replay idiom: open
  `const trx = await db.transaction()`, run the SQL via `trx.raw(sql, FINAL_STATUSES)` twice,
  compare `affectedRows`, then `await trx.rollback()` + `await closeDb()`, never commits, safe
  against a live/shared DB. Local result: the OLD unqualified UPDATE (same query minus the new
  WHERE fragment) touched 13,021 rows every time; the NEW narrowed UPDATE touched 0 both runs
  (nothing had actually drifted). Companion recovery tool `node scripts/refetch-fixtures.js
  --ids <a,b,c>` (or `--inconsistent`, auto-selecting every `FINAL_STATUSES` fixture where
  `COALESCE(ft,goals) < ht` on either side) force-refetches from API-Football then re-runs
  `settleApisportsResults()`, printing before/after `ht/ft/goals` tables and which ids changed.
  Live run against the 21 fixtures flagged by `--inconsistent` locally: all 21 came back from
  API-Football with the SAME inconsistent ht>ft pair (not a transient upstream glitch, these
  fixtures' underlying data is genuinely inconsistent at the source), so the existing guarded
  `CASE WHEN` in the settle UPDATE (stores `NULL` for the second half instead of aborting on the
  UNSIGNED-column underflow) remains the correct permanent handling for this class of record.
- 2026-08-19 - **deploy-remote.js refactor, dry-run equivalence proof (verified):**
  `scripts/lib/remote.js` (ssh/sshInput/sshStreamUpload/sshStreamDownload/remoteConfig,
  every fn taking `cfg` first) and `scripts/lib/sync-rules.js` (pure SYNC_TABLES/planPull/
  dumpArgs/windowDeleteSql/statusRows/compareStatus + the moved `INSTANCE_TABLES`) were
  extracted out of `deploy-remote.js`. Proof method: captured `node scripts/deploy-remote.js
  --all --dry-run` stdout to a file BEFORE the refactor, re-ran the identical command AFTER,
  normalized only the dump filename's embedded timestamp (`oddspro-deploy_<ts>`, the one
  line that legitimately changes run-to-run), then `diff`'d: zero remaining differences.
  Same idiom is reusable for any future pure-refactor of a script with observable CLI output.
- 2026-08-19 - **db-import.js round trip, local Docker MariaDB (verified):** the live
  `oddspro` DB is 2.25 GB uncompressed (98,832 fixtures / 36,871 matches / 7,281,925
  odds_markets rows) but `mariadb-dump --compact` gzip's it down to ~114 MB (`node
  scripts/db-export.js` took under a minute). Import (gunzip -> `docker exec -i -e
  MYSQL_PWD=... mariadb mariadb -uroot <db>`) is the slow side: 114 MB round-tripped into a
  scratch `oddspro_import_test` DB in 385s (~0.3 MB/s effective, INSERT-execution-bound, not
  I/O-bound; expect several minutes for a full-DB import, plan the timeout accordingly).
  Scratch DB created with `docker exec -e MYSQL_PWD=... mariadb mariadb -uroot -e "CREATE
  DATABASE oddspro_import_test CHARACTER SET utf8mb4"` (the local `root` DB_USERNAME already
  has CREATE privilege, no separate grant needed). Post-import `COUNT(*)` on fixtures/
  matches/odds_markets matched the source exactly; scratch DB then dropped. Verifying a
  `DROP DATABASE` actually happened needs the OUTPUT of `SHOW DATABASES LIKE '...'`, not its
  exit code: the mysql/mariadb CLI exits 0 on a successful query even when it returns zero
  rows, so `cmd && echo exists` is always true and silently lies.
- Cross-refs: second-writer deadlocks → memory-bank #3/#22; web 500 = API down → #17;
  `cmd | tee log` masks exit codes (verify long runs by reading the output tail) → #14.
- 2026-08-19 — **`.env.deploy` `DEPLOY_SSH` was stale (fixed):** it read `oddsprok@oddspro-p`,
  which resolves nowhere on this machine (`ssh: Could not resolve hostname oddspro-p`). The
  working path is the `~/.ssh/config` alias `Host oddspro` (`oddspro.ke:1980`, verified
  `ssh oddspro` -> `rs1.hpcnoc.com`/`oddsprok`). Updated `.env.deploy` (gitignored, not in any
  commit) to `DEPLOY_SSH=oddspro`. If a fresh checkout's `.env.deploy` ever reintroduces the
  old literal, swap it for the alias rather than debugging DNS.
- 2026-08-19 — **`db-sync.js status`/`backup`/`pull` first live runs (verified):** `status`
  against `oddsprok_prod_1_4_0` completed in seconds (4 sshInput round trips) and printed a
  correct side-by-side (row counts/MB per SYNC_TABLE, 7-day match coverage, freshness,
  migration head). `backup --remote-db` on both dead DBs: `oddsprok_prod` -> 19.0 MB gz in
  31.1s, `oddsprok_prod_1_3_0` -> 31.0 MB gz in 34.1s, both `gzip -t` clean (far smaller than
  the 2.7/4.8 GB raw-size estimates in memory — actual on-disk size was stale). `pull --full`
  on the 5 small canonical tables (leagues/teams/*_aliases/standings) and a windowed
  `pull --since 2026-08-01` of the default 17-table set both ran clean: matches +12,509,
  odds_markets +1.85M rows in 178s for just the 26-day window (22.8 MB gz). **Found and fixed
  two real bugs while doing this** (see the two entries below) - a live dry run is worth more
  than a code read for a script like this.
- 2026-08-19 — **`sshInput`/`ssh`'s thrown Error embeds the raw remote command, password
  included (bug class, worth knowing for any future ssh-wrapper caller):** `scripts/lib/
  remote.js`'s `ssh()`/`sshInput()` interpolate `cmd` verbatim into the Error message on a
  non-zero exit (`remote command failed (...): ${cmd}`). Any caller that builds `cmd` from
  `cfg.MYSQL_ENV` (which embeds `MYSQL_PWD='<real password>'`) and lets that Error reach a
  console.error/die() unmodified prints the live DB password in plaintext. Caught live: a
  hostname-resolution failure on the very first `db-sync.js status` run printed the password
  before the fix. `db-sync.js`'s fix (two layers): every call site wraps `sshInput` in a
  `safeSshInput` that masks the message before rethrowing, AND the top-level catch masks
  again via a cached `cfg` as defense in depth. `deploy-remote.js` has the SAME underlying
  exposure in its own `ssh`/`sshInput` error paths (its `die(e.message)` prints unmasked) -
  not fixed there (out of this task's scope), worth fixing if that script's error path is
  ever hit for real.
- 2026-08-19 — **mysql2 DATE/DATETIME round-trip: use the Date's LOCAL getters, never
  `.toISOString()` (bug, found + fixed in `db-sync.js`):** mysql2 parses a DATE/DATETIME
  result using the Node process's OWN local timezone as the `Date` constructor's frame
  (`new Date(y, m, d, ...)`), so the object's local getters (`getFullYear`/`getMonth`/
  `getDate`) recover the exact literal value MySQL returned, regardless of what timezone the
  process happens to run in. `.toISOString()` renders in UTC instead, which silently loses a
  calendar day whenever the local UTC offset crosses midnight - confirmed live: this exact bug
  shifted EVERY day in `db-sync.js status`'s 7-day match-coverage table back by one against
  the remote side (which reads its `DATE()` result as a plain string, no `Date` round-trip at
  all: `local[day] === remote[day+1]` for every provider, every day). Diagnosed by comparing
  three read paths for the identical SQL against the identical local DB: knex `db.raw()`
  (wrong, `.toISOString()`-sliced), `docker exec ... mariadb -N -B` (right, matched remote),
  and a one-off script logging the raw `Date` object's `.toString()` vs `.toISOString()` side
  by side (`Fri Aug 21 2026 00:00:00 GMT+0300` vs `2026-08-20T21:00:00.000Z` for the SAME
  value) - that comparison is the fast way to confirm this class of bug anywhere else in the
  codebase that might slice `.toISOString()` off a knex-returned DATE/DATETIME.
- 2026-08-19 — **`pull --full` genuinely discards local-only rows (by design, confirmed
  live, worth remembering before reaching for `--full` casually):** a full-mode dump uses
  `--add-drop-table` (`scripts/lib/sync-rules.js`'s `dumpArgs`), so the local table is dropped
  and recreated with EXACTLY the remote's current full row set. Live-verified this is not
  hypothetical: `fixture_statistics`/`fixture_events`/`fixture_lineups`/`fixture_players`/
  `fixture_predictions`/`fixture_api_predictions`/`fixture_ai_insights`/`daily_slips` all had
  MORE rows locally than on the remote BEFORE any `--full` pull (independent local
  pipeline/enrichment runs), and a `--full` pull on them dropped 200-14,000+ rows each back
  down to the remote's exact count - including locally-generated `fixture_ai_insights` rows,
  which cost real OpenRouter credits to produce. No undo short of an earlier whole-DB backup
  (`node scripts/db-export.js`). `odds_markets` was deliberately left un-full-pulled this
  session for exactly this reason (see the task-8 report) even though status showed remote
  unambiguously ahead there (so a full pull would likely be a net gain, not a loss) - the
  point stands for future runs: check direction (`status`) before reaching for `--full` on a
  table, and prefer the windowed default for routine catch-up.
- 2026-08-19 — **`gzip -t` is NOT a completeness check (Round 1 fix, live-verified twice):**
  the live host kills a long-running remote `mariadb-dump` connection mid-stream, but `gzip`
  on the remote closes ITS OWN output cleanly regardless - the resulting file is a perfectly
  valid, perfectly truncated gzip stream. `gzip -t` verifies the gzip FRAME, never that
  mariadb-dump actually finished. Caught for real: `oddsprok_prod`'s first backup attempt died
  mid-INSERT inside `matches` with zero `odds_markets` rows at all, and `gzip -t` passed
  anyway. **The fix (`scripts/db-sync.js` + `scripts/lib/sync-rules.js`'s `dumpLooksComplete`):
  check for mariadb-dump's own trailer** (`-- Dump completed on ...`, only ever written after
  a clean exit - so backup dumps skip `--compact`, which suppresses it) **or an explicit marker
  of our own** (pull dumps keep `--compact` for size, so the remote command appends
  `-- oddspro-sync: complete` itself, ONLY after mariadb-dump exits 0: `(mariadb-dump ... &&
  echo '...') | gzip -9` under `set -o pipefail` via a `bash -c` wrapper, so a killed dump's
  non-zero exit survives the pipe into gzip instead of being swallowed by gzip's own success).
  Read the tail by streaming the file through `zlib`'s `createGunzip()` and keeping only the
  last ~2 KB decompressed - never load a multi-hundred-MB dump into memory just to check its
  end.
  **Playbook for "is this a real backup?":** `node scripts/db-sync.js backup --remote-db
  <name>` now does this automatically per table/chunk and prints a completeness table
  (planned chunk-row-sum vs a final remote `COUNT(*)`, per table) before declaring success -
  trust that table, not a bare "the command exited 0". A fatal abort renames the partial
  output to `<file>.partial` so it can never be mistaken for a finished backup. For an OLDER
  file made before this fix existed, there is no retroactive check possible other than
  re-running the backup - `gzip -t` on it proves nothing about completeness, only that the
  bytes it does contain aren't corrupt.
  **Row count alone cannot predict when a table is "too big"**: `matches` in `oddsprok_prod`
  is only 26,670 rows - nowhere near `BACKUP_CHUNK_SIZE` (100000) - but carries a ~39 KB
  `metadata` blob per row, and three flat retries of the whole table died at the identical
  ~20-30 MB / ~25-30 s mark every time (`mariadb-dump: Error 2013: Lost connection to server
  during query`). The general fix is adaptive, not a bigger row-count guess: on a completeness
  failure that survives 3 retries, `downloadWithBisection` (shared by `backup` and `pull`)
  bisects the table's id range and retries each half recursively, bottoming out only when the
  range can't be split further. Live result: `matches` succeeded in 5 bisected pieces;
  `odds_markets`'s 509 pre-planned id-range chunks all matched their planned counts exactly
  with zero bisection needed (they were already small enough). `pull` needed the identical
  fallback for a table it had never pre-chunked at all: `odds_markets`'s normal WINDOWED dump
  (`match_id IN (SELECT id FROM matches WHERE ...)`, a subquery predicate - slower to evaluate
  per row than a direct id range, and it failed even earlier as a result, at row ~179,590 on
  the first retry) fell back to bisected pieces and completed. **This is proof, not
  speculation, that the ORIGINAL (pre-Round-1) windowed `odds_markets` pull earlier in this
  session had silently imported a truncated table**: local's windowed `COUNT(*)` for the exact
  same predicate came up ~3M rows short of remote's (1,852,723 vs 4,910,118) - re-pulling with
  the fixed code closed the gap. **Profiling a whole DB before backing it up must be batched,
  not per-table:** an initial per-table-loop implementation (PK check + count + min/max, 3
  round trips x N tables, each `ssh` invocation paying full connection-setup latency with no
  multiplexing) measured live at several minutes just to PLAN a 25-table backup, before any
  data moved; batching PK shape into one `information_schema.columns` query and counts into
  one `UNION ALL` per batch of ~100 (`profileRemoteDatabase`/`batchedChunkCounts`) cut that to
  16 seconds. Aggregate reads (COUNT/MIN/MAX) are cheap to batch even across hundreds of
  chunks - the risk this whole fix is about is bulk DATA transfer, not read aggregates.
- 2026-08-19 - **v1.4.0 build 2 live deploy: three traps, all hit for real.** (1) **The web
  step wipes `public_html/.htaccess`, and on this host that file IS the Passenger config.**
  `find public_html -mindepth 1 -delete` takes dotfiles; without the CloudLinux Passenger
  block every `/api` route 404s and the Node app never starts. Worse, the tar.gz backup taken
  moments earlier is NOT a rescue: cPanel's own **Stop App removes the Passenger block from
  `.htaccess` first**, so a backup taken while stopped contains only the ENV VARS block.
  Restore = write the block back (`PassengerAppRoot`/`PassengerBaseURI`/`PassengerNodejs`
  (`~/nodevenv/oddspro-app-v<ver>/22/bin/node`)/`PassengerAppType node`/`PassengerStartupFile
  src/server.js`) or click Start in cPanel, which rewrites it. FIXED in `scripts/deploy-remote.js`
  (`HOST_OWNED = ['.htaccess', '.well-known']` parked in tmp across the wipe, restored unless
  the build ships its own, plus a loud HTACCESS_MISSING warning). (2) **cPanel's Stop does NOT
  kill the running `lsnode` processes.** Two instances with 2-3 day uptimes kept serving, kept
  running their OWN schedulers on PRE-deploy code (no writer lease), and answered `/api/refresh`
  while the new build was already on disk: the "warehouse_version stays 0 but odds are being
  written" symptom. Always `ps -u $USER -o pid,etime,args | grep "[l]snode"` after a deploy and
  `kill` anything whose etime predates it, then re-warm with one request. (3) **`build-id.txt`
  was never found in production**: the server only looked at `web/dist/build-id.txt`, which does
  not exist in the SPLIT layout (backend `~/oddspro-app-v<ver>`, frontend `~/public_html`), so
  `/api/refresh` always answered `build:null` and the client's stale-bundle reload never fired.
  Fixed to walk `WEB_DIST_DIR` -> `web/dist` -> `../public_html`.
- 2026-08-19 - **`scripts/hotfix-remote.js` first live run (verified):** `node
  scripts/hotfix-remote.js src/server.js --restart` backed the remote file up to
  `src/server.js.orig-<stamp>`, streamed the new one, ran the host's `node --check`, touched
  `tmp/restart.txt`, and printed the exact per-file rollback command. Fix confirmed live ~16 s
  later (`build` went from null to `1.4.0+mszeyz65`). This is the route for a one-file
  production fix that must not wait for a release.

- 2026-08-19 - **AI verdicts: two separate failures, only one of them ours.** After the owner
  topped up OpenRouter, HTTP 402 stopped and 24 hot verdicts landed within four minutes,
  draining the upcoming hot queue. The remaining log noise was a genuine parse bug: our own
  `extractJson` used a greedy `/\{[\s\S]*\}/`, which spans from the FIRST brace anywhere in a
  reply to the LAST, so any prose brace before the JSON produced one unparseable blob and the
  verdict was dropped after the call had already been billed. Fixed by matching brace PAIRS with
  a string-aware stack scan (candidates tried last-first, so a model that restates the schema
  before answering still parses) plus `response_format: {type:'json_object'}` on the request.
  Live A/B on `openai/gpt-5.6-luna`: JSON mode does NOT cost grounding citations (5 of 5 both
  ways) and long grounded replies finish cleanly (`finish_reason: stop`, 3.9 KB), so the
  original theory of token truncation was wrong - check `finish_reason` before believing it.
  **Honest status: the fix is proven by unit tests and live A/B, NOT yet by production traffic**,
  because the queue had already drained when it shipped; the next real test is the batch after
  the 05:00 EAT full sweep. Diagnosis one-liner that settled it: post to
  `/chat/completions` directly and print `choices[0].finish_reason` + `usage`.
  **Why the worker can look idle and be correct:** tip reviews need `tip_confidence >=
  TIP_AI_MIN_CONFIDENCE` (0.75) and live's best upcoming tip was 0.7154, so zero were due;
  hot reviews were all already verdicted. Check those two counts before suspecting the worker.

- 2026-08-19 - **Dead-DB drop, and how a backup was actually proven before it (verified):**
  `oddsprok_prod` (2.7 GB, 25 tables) and `oddsprok_prod_1_3_0` (4.8 GB, 33 tables) were dropped
  after `node scripts/db-sync.js backup --remote-db <name>` produced completeness-verified dumps
  (156 MB / 282 MB gz; the 1_3_0 run took 7207 s and needed bisected retries on `matches`, whose
  ~39 KB metadata blobs keep losing the connection). Trusting the tool's own completeness table
  is not enough for an irreversible drop: verify independently with `gzip -t`, `gzip -dc | grep
  -c '^CREATE TABLE'` against the live table count, the dump trailer in the last 2 KB, AND a
  spot-check that the AT-RISK rows are really inside (`gzip -dc f.gz | grep -c '(<id>,'`).
  **Neither dead DB was a subset of live** - `_1_3_0` held 730 fixtures and 60 settled tip rows
  absent from `_1_4_0`, `oddsprok_prod` held 505 - so "it is an old copy" is never a safe
  assumption; measure the delta with a LEFT JOIN across schemas first. Freed 7.4 GB.
- 2026-08-19 - **Passenger idle-shutdown silently stops the pipeline (verified, fixed):**
  `logs/auto-refresh.log` showed light passes at 12:42 and 12:57 UTC and then NOTHING until
  14:41, when an incoming request respawned the app. LiteSpeed had idled the process out and the
  in-process scheduler slept with it, so on a quiet site the warehouse only refreshes when a
  human visits. The host's own crontab was EMPTY. Fix installed: `*/5 * * * * curl -s -o
  /dev/null --max-time 30 https://oddspro.ke/api/refresh` (the host resolves its own hostname
  over HTTPS in 0.17 s; `http://127.0.0.1` with a Host header 404s, LiteSpeed vhost routing).
  Check cadence with `grep -c "light OK" logs/auto-refresh.log` twice, minutes apart, not by
  reading the tail once. The durable fix is the writer-process split (spec section 7).

## 6. Doc & knowledge topology

- `CLAUDE.md` (root) — architecture + commands + invariants; authoritative for any harness.
- `AGENTS.md` (root) — cross-harness entry point + hard invariants; points here.
- `docs/` — PROJECT docs: `DEPLOYMENT.md`, `memory-bank.md` (historical/code-level KB + the
  AI regime-switch log — dated DARK-switch notes go THERE), `guides/`, `research/`, `visuals/`.
- `docs/dev/` — DEVELOPMENT pipeline (ACTIVE effort only since the 2026-08-04 lean-docs policy): `specs/`, `plans/`,
  `checklists/`. NEW docs go per the `docs/README.md` table.
- Separation of duties: user-gated ops (live cPanel deploys, DB blob reclaim, billing,
  PAT rotation) are surfaced to the user once — never tracked as agent work.
- 2026-07-18 — topology additions: `docs/engine/` (numbered system-behavior chapters; index
  + the doc update-triggers table in `engine/00-README.md`) and repo-root
  `QUICK-REFERENCE.md` (command/routine quick card + warnings + definitions — updated in
  the SAME commit as any command/routine change). Dev-pipeline files now carry a
  `YYYY-MM-DD-HHmm-` timestamp prefix (same stamp across one effort; forward-only).

## 7. Update log

- 2026-07-18 — library created (spec:
  `docs/dev/specs/2026-07-18-release-packaging-and-docs-reorg-design.md`); initial content
  exported from the incumbent agent's verified session memory.
- 2026-07-18 — §6 append: `docs/engine/` + root `QUICK-REFERENCE.md` joined the topology;
  dev-pipeline timestamp-prefix convention (plan:
  `docs/dev/plans/2026-07-18-0324-quickref-engine-docs.md`).
- 2026-08-04 — §3.5 append (DB-sync commands, cross-DB knex one-liner, natural-key merge
  rule) + §5 entries (split-brain .env, scratchpad module resolution, OpenRouter smoke).
  STANDING PRACTICE (user directive 2026-08-04): every command proven working in a session
  — including its nuances, prerequisites and the WHY — gets a dated entry here rather than
  being re-discovered later. This library is the proven-commands knowledge base.
- 2026-08-18: §3.8 append: `meta` table bump one-liner + the live two-process writer-lease
  check (`GET_LOCK` acquire/held-elsewhere/release round trip), plus the
  `db.raw(...).connection(conn)` returns `[rows, fields]` (not bare rows) gotcha.
- 2026-08-18: §5 append: narrowed `settleApisportsResults()` settle UPDATE (NULL-safe `<=>`
  guard, verified 13,021 → 0 rows locally) + `scripts/refetch-fixtures.js` recovery tool + the
  rolled-back-transaction replay idiom for safely verifying a SQL change against a live/shared DB.
