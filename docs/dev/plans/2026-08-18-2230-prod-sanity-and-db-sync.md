# Prod sanity (multi-instance safe) + DB sync tooling: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: `docs/dev/specs/2026-08-18-2230-prod-sanity-sync-and-data-platform.md` (workstreams A + B; C-F get their own specs later).
Checklist: `docs/dev/checklists/2026-08-18-2230-prod-sanity-and-db-sync.md`.

**Goal:** Make the live app correct under LiteSpeed's multiple concurrent instances (one writer, one shared freshness version, one persisted column catalog), ship it as v1.4.0 build 2 without a release, and give the project a reusable, compressed, progress-reporting DB sync (`db-import.js` + `db-sync.js`) with live as the source of truth.

**Architecture:** A `meta` key/value table becomes the cross-instance state (writer lease heartbeat, `warehouse_version`, `last_success`, `column_catalog`, `refresh_request`). A dedicated pinned knex connection holds `GET_LOCK('oddspro:writer')`; only the holder runs the scheduler, AI worker, geo backfill and the catalog warm, and only the holder bumps `warehouse_version`. Every instance reads `warehouse_version` (memoized, refreshed every 5 s) as its cache key / ETag seed, so all instances answer consistently and caches bust the moment data lands. Sync tooling = thin ssh/streaming helpers shared by `deploy-remote.js`, `hotfix-remote.js`, `db-import.js` and `db-sync.js`, with pure, tested rules in `scripts/lib/sync-rules.js`.

**Tech stack:** Node ES modules, knex/mysql2 (MariaDB 10.11 live, MariaDB 11.7 Docker locally), node:test, ssh/scp (BatchMode), mariadb-dump + gzip (only gzip exists on the host).

## Global constraints (from the spec + CLAUDE.md)
- ES modules, 4-space indent, single quotes, semicolons, `async/await`; knex only via `src/db/connection.js` (the lease PINS a connection from that same instance; no second knex instance).
- Migrations forward-only under `src/db/migrations/`, style `export async function up(knex)/down(knex)`; new tables utf8mb4, `created_at`/`updated_at`.
- Pure rules modules are zero-import and tested offline in `tests/<topic>.test.js` (node:test + assert/strict). `npm test` must stay green (942 today).
- Instance tables NEVER sync (list = `INSTANCE_TABLES` in `scripts/deploy-remote.js`; move it into `scripts/lib/sync-rules.js` and import it back).
- Live wins outright (D2). `push` only for explicitly named tables, never by default. `deploy-remote --db` must NOT be run against the live host.
- No version bump: the redeploy is `deploy-remote --app --web` under v1.4.0; the tag is moved to the shipped HEAD.
- Live DB name `oddsprok_prod_1_4_0`, live app root `~/oddspro-app-v1.4.0`, node `~/nodevenv/oddspro-app-v1.4.0/22/bin/node`; `.env.deploy` holds `DEPLOY_SSH/DEPLOY_DB_USER/DEPLOY_DB_PASSWORD`; the ssh alias `oddspro` == `oddsprok@oddspro-p`.
- Docs to update in the same commits: `CLAUDE.md` (architecture bullets for `src/meta.js`, `src/db/lease.js`, the sync scripts), `QUICK-REFERENCE.md` (new commands), `docs/DEPLOYMENT.md` (build-2 routine + hotfix route), `docs/agents/toolset.md` (verified command entries), `docs/engine/00-README.md` trigger table if a chapter is touched.
- Writing style: no em-dashes anywhere (code comments, docs, commits).

## File structure
- Create `src/db/migrations/20260818000001_meta.js`: `meta(k VARCHAR(64) PK, v LONGTEXT NULL, updated_at TIMESTAMP)`.
- Create `src/meta.js`: `getMeta(k)`, `setMeta(k, v)`, `warehouseVersion()` (memo), `bumpWarehouseVersion()`, `startMetaPoll()/stopMetaPoll()`.
- Create `src/db/lease.js` (knex-touching) + `src/db/lease-rules.js` (pure): pinned-connection `GET_LOCK` writer lease, `isWriter()`, `startWriterLease()/stopWriterLease()`, `leaseStatus()`.
- Modify `src/auto-refresh.js`: version/last_success via meta; tick gated by `isWriter()`; consume `refresh_request`.
- Modify `src/server.js`: boot order, `apiCache.version` from meta, `/api/refresh` GET/POST changes, `/api/columns` from meta, stderr trim at boot, `/api/health` gains lease/version.
- Modify `src/ai-worker.js`, `src/geo.js`: tick gated by `isWriter()`.
- Modify `src/db/records.js`: `columnCatalog()` unchanged; add `columnCatalogFromMeta()`; `_pivotAllowed` set from the stored catalog.
- Modify `src/apisports.js`: narrowed settle UPDATE.
- Create `scripts/lib/remote.js` (ssh helpers + `.env.deploy` config), `scripts/lib/sync-rules.js` (pure), `scripts/db-import.js`, `scripts/db-sync.js`, `scripts/hotfix-remote.js`, `scripts/refetch-fixtures.js`.
- Modify `scripts/deploy-remote.js`: import helpers from `scripts/lib/remote.js`, `INSTANCE_TABLES` from `sync-rules.js` (behaviour unchanged, `--dry-run` output identical).
- Tests: `tests/lease-rules.test.js`, `tests/sync-rules.test.js`, `tests/meta-rules.test.js` (if any pure helper lands there; otherwise fold into lease-rules).

---

### Task 1: `meta` table + `src/meta.js`

**Files:** Create `src/db/migrations/20260818000001_meta.js`, `src/meta.js`. Test: manual (DB-touching) + `tests/meta-rules.test.js` for the pure memo rule.

**Interfaces (produces):**
```js
// src/meta.js
export async function getMeta(key)            // -> parsed JSON value or null
export async function setMeta(key, value)     // JSON-encodes; upsert by k (explicit merge list!)
export async function bumpWarehouseVersion()  // atomic: v = v+1 (JSON int); returns new int
export function warehouseVersion()            // SYNC memoized int (0 until first poll)
export function lastSuccessMemo()             // SYNC memoized last_success object or null
export async function refreshMetaMemo()       // one read of warehouse_version + last_success -> memo
export function startMetaPoll(intervalMs = 5000) / stopMetaPoll()
```
Pure (in `src/db/meta-rules.js`, zero imports): `parseMetaValue(raw)` (JSON.parse, null-safe, returns null on garbage) and `nextVersion(current)` (`Number.isFinite(n) ? n + 1 : 1`).

- [ ] **Step 1: migration**
```js
export async function up(knex) {
    await knex.schema.createTable('meta', t => {
        t.string('k', 64).primary();
        t.text('v', 'longtext').nullable();
        t.timestamp('created_at').defaultTo(knex.fn.now());
        t.timestamp('updated_at').defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
    });
    await knex('meta').insert({ k: 'warehouse_version', v: '0' });
}
export async function down(knex) { await knex.schema.dropTableIfExists('meta'); }
```
- [ ] **Step 2: pure rules + test** (`tests/meta-rules.test.js`): `parseMetaValue('{"a":1}')` -> `{a:1}`, `parseMetaValue(null)` -> null, `parseMetaValue('{')` -> null, `nextVersion(3)` -> 4, `nextVersion(null)` -> 1. Run: `node --test tests/meta-rules.test.js` -> fails (module missing) -> implement -> passes.
- [ ] **Step 3: `src/meta.js`**: `setMeta` = `db('meta').insert({k, v: JSON.stringify(value)}).onConflict('k').merge(['v'])` (knex-MySQL trap: ALWAYS pass the merge list). `bumpWarehouseVersion` = `UPDATE meta SET v = CAST(CAST(v AS UNSIGNED) + 1 AS CHAR) WHERE k='warehouse_version'` then read back (insert the row first if missing). Memo: module vars `_version = 0`, `_lastSuccess = null`; `refreshMetaMemo()` reads both keys in one query (`whereIn('k', [...])`), never throws (logs once per distinct error message); `startMetaPoll` = unref'd interval + one immediate refresh.
- [ ] **Step 4: run `npm run migrate` locally**, then a one-off `node -e` check that `bumpWarehouseVersion()` returns 1 then 2 and `getMeta('warehouse_version')` reads 2. Then `npm test`.
- [ ] **Step 5: commit** `feat(meta): cross-instance meta table + warehouse_version memo`.

### Task 2: writer lease (`src/db/lease-rules.js` + `src/db/lease.js`)

**Files:** Create both + `tests/lease-rules.test.js`.

**Interfaces (produces):**
```js
// lease-rules.js (pure)
export const WRITER_LOCK = 'oddspro:writer';
export function lockOutcome(rows)  // rows from SELECT GET_LOCK(?,0) AS got -> 'acquired' | 'held-elsewhere' | 'error'
                                    // got === 1 -> acquired; got === 0 -> held-elsewhere; null/undefined -> error
export function leaseTransition(prev, outcome) // {was:boolean, now:boolean, changed:boolean, event:'gained'|'lost'|null}
// lease.js
export function isWriter()                       // sync boolean
export function leaseStatus()                    // { writer, since, last_check, last_error, attempts }
export async function tryAcquireWriter()         // one attempt on the pinned connection; returns boolean
export function startWriterLease(intervalMs = 30_000) / stopWriterLease()  // interval unref'd; stop RELEASES the lock (DO_RELEASE_LOCK) and releases the connection
```
Mechanics: `const conn = await db.client.acquireConnection()`; run `db.raw('SELECT GET_LOCK(?, 0) AS got', [WRITER_LOCK]).connection(conn)`; keep `conn` pinned while writer. GET_LOCK is re-entrant on MariaDB, so re-running it every tick on the same connection returns 1 while we hold it and doubles as a liveness check. On any error: `db.client.releaseConnection(conn)` (ignore errors), drop the pin, `writer=false`, next tick re-acquires. Log gained/lost transitions with `console.info('[lease] writer gained|lost')`.
- [ ] **Step 1: tests** for `lockOutcome([{got:1}])`, `[{got:0}]`, `[]`, `undefined`, and `leaseTransition(false,'acquired')` -> gained, `(true,'held-elsewhere')` -> lost, `(true,'error')` -> lost, `(false,'held-elsewhere')` -> unchanged.
- [ ] **Step 2: run, fail, implement, pass.**
- [ ] **Step 3: live-ish check**: `node -e` acquire in one process, then in a second `node -e` process expect `held-elsewhere` while the first sleeps 10 s. Record the command in `docs/agents/toolset.md`.
- [ ] **Step 4: commit** `feat(lease): single-writer lease over GET_LOCK on a pinned connection`.

### Task 3: gate the singletons on the lease + shared version in auto-refresh

**Files:** Modify `src/auto-refresh.js`, `src/ai-worker.js`, `src/geo.js`, `src/server.js` (boot/shutdown only in this task).

- [ ] **Step 1: auto-refresh.js**: (a) `tick` starts with `if (!isWriter()) return;`; (b) in `startJob`'s ok-branch replace `dataVersion += 1; lastSuccess = ...` with `bumpWarehouseVersion().then(refreshMetaMemo).catch(...)` and `setMeta('last_success', {at, mode, dates})` (best-effort, never throws into the job); keep `dataVersion`/`lastSuccess` module vars as a local mirror for the writer, but `refreshStatus()` now returns `{ ...refreshJob, data_version: warehouseVersion(), last_success: lastSuccessMemo(), writer: isWriter() }`. (c) After a light/full/manual ok, if writer: consume `refresh_request` (Task 4). (d) Also on the ok path (writer): `setMeta('column_catalog', await columnCatalog())` wrapped in try/catch, throttled to once per 30 min (module var) so a light pass every 15 min doesn't scan `odds_markets` twice an hour; the daily full sweep always refreshes it.
- [ ] **Step 2: ai-worker.js / geo.js**: at the top of each tick `if (!isWriter()) return;` (import from `./db/lease.js`).
- [ ] **Step 3: server.js boot** (lines ~1303-1311): after `loadOverrides()`: `await refreshMetaMemo(); startMetaPoll();` then inside listen: `startWriterLease()` BEFORE `startAutoRefresh()`; `startCatalogWarm()` stays but its `warm()` becomes: if writer -> compute+store as today; else -> `apiCache.warm('/api/columns', columnCatalogFromMeta)`. Shutdown: `stopWriterLease()` (releases the lock so a sibling instance takes over within one tick), `stopMetaPoll()`.
- [ ] **Step 4: `/api/health`** (or the existing health route) adds `{ writer: isWriter(), warehouse_version }`.
- [ ] **Step 5: run `npm test`; run `npm run serve` locally with `AUTO_REFRESH_ENABLED=1` and confirm `[lease] writer gained` and that a second local `npm run serve` on another port logs no gain and its `/api/refresh` shows the same `data_version`.**
- [ ] **Step 6: commit** `feat(server): writer-lease gated schedulers + meta-backed warehouse_version`.

### Task 4: cross-instance manual refresh + column catalog from meta

**Files:** Modify `src/server.js` (`POST /api/refresh`, `GET /api/columns`, `apiCache.version`), `src/db/records.js`.

- [ ] **Step 1: records.js**: add
```js
export async function columnCatalogFromMeta() {
    const stored = await getMeta('column_catalog');
    if (stored?.markets) { _pivotAllowed = new Set(stored.markets.map(c => c.key)); return stored; }
    return columnCatalog(); // first boot ever / meta empty: compute (writer will persist on its next ok)
}
```
- [ ] **Step 2: server.js**: `apiCache` `version: () => warehouseVersion()`; `/api/columns` loader -> `columnCatalogFromMeta`; `POST /api/refresh`: if `!isWriter()` -> `setMeta('refresh_request', { date, requested_at, by: 'follower' })` and answer `202 { queued: true, writer: false }` (the web already handles non-200 refresh answers with a notice; verify `web/src` `refresh` handling and add the `queued` notice text if missing); writer path unchanged. In `auto-refresh.js` tick (writer): before the light/full checks, `getMeta('refresh_request')` (throttled: read at most every 30 s, i.e. every tick is fine) -> if present and not running: clear it and `startJob({mode:'manual', dates:[date], run: runDateRefresh...})` exactly like the POST handler does.
- [ ] **Step 3: web**: `web/src` where `POST /api/refresh` responses are handled: treat 202 `{queued:true}` as "Refresh queued on the writer instance, data will land within a minute" (sky notice). Keep it minimal.
- [ ] **Step 4: `npm test`, `npm run build:web` (verify it builds), commit** `feat(api): follower-safe manual refresh + persisted column catalog`.

### Task 5: narrowed settle UPDATE + stderr trim + refetch tool

**Files:** Modify `src/apisports.js` (settle SQL), `src/server.js` (boot), create `scripts/refetch-fixtures.js`.

- [ ] **Step 1: apisports.js**: append to the settle UPDATE's WHERE:
```sql
AND (m.completed_at IS NULL
     OR NOT (m.home_score_fulltime <=> COALESCE(f.ft_home, f.goals_home)
         AND m.away_score_fulltime <=> COALESCE(f.ft_away, f.goals_away)
         AND m.home_score_first_half <=> f.ht_home
         AND m.away_score_first_half <=> f.ht_away))
```
  Verify locally with the same rolled-back-transaction replay used for the guard fix: affected rows drop from ~13k to the genuinely changed set on a second run (expect 0 the second time).
- [ ] **Step 2: server.js boot**: before listen, `trimStderrLog()`: if `stderr.log` (cwd) exceeds `effective('AUTO_LOG_MAX_KB') * 8` KB, rewrite it with `trimLogTail(content, maxBytes)` from `src/db/auto-rules.js` (same idiom as `_log`). Passenger appends afterwards; truncation of an O_APPEND file is safe. Wrap in try/catch, log once.
- [ ] **Step 3: `scripts/refetch-fixtures.js --ids 1556592,...`**: uses `apisports.js`'s `_get('/fixtures', { ids, timezone })` (export a small `refetchFixtureIds(ids)` from apisports.js that batches 20 per call and calls `_saveFixtureItems`) then re-runs `settleApisportsResults()`; prints before/after `ht/ft` per id. Run it locally for the 21 inconsistent ids and report which ones API-Football corrected.
- [ ] **Step 4: `npm test`, commit** `fix(results): settle only changed matches; boot-time stderr trim; refetch-fixtures tool`.

### Task 6: `scripts/lib/remote.js` + `scripts/lib/sync-rules.js` (+ deploy-remote refactor)

**Files:** Create `scripts/lib/remote.js`, `scripts/lib/sync-rules.js`, `tests/sync-rules.test.js`; modify `scripts/deploy-remote.js`.

**Interfaces (produces):**
```js
// remote.js
export function remoteConfig({ version })   // reads .env.deploy + package.json version -> { SSH_TARGET, REMOTE_HOME, APP_DIR, WEB_DIR, DB_NAME, DB_USER, DB_PASS, NODE_BIN, TMP_DIR, MYSQL_ENV }
export function ssh(cfg, cmd, { capture=true, allowFail=false, dry=false })
export function sshInput(cfg, cmd, input, { allowFail=false, dry=false })
export function sshStreamUpload(cfg, localFile, remoteCmd, label, { dry=false })      // byte-progress meter (known total)
export function sshStreamDownload(cfg, remoteCmd, localFile, label, { dry=false })    // byte-progress meter (unknown total: MB + MB/s + elapsed)
export const fmtMB
// sync-rules.js (pure)
export const INSTANCE_TABLES          // moved verbatim from deploy-remote.js
export const SYNC_TABLES              // ordered array of { name, cls: 'canonical'|'trio'|'derived', dateWhere: (since, until) => sqlString|null }
export function planPull({ tables, since, until, full }) // -> [{ table, mode: 'full'|'window', where }] ; throws on instance table or unknown name
export function dumpArgs({ db, table, where, full })    // -> mariadb-dump argv array: ['--compact','--quick','--single-transaction','--no-tablespaces','--default-character-set=utf8mb4', full ? '--add-drop-table' : '--no-create-info','--replace', ...(where?[`--where=${where}`]:[]), db, table]
export function importPreamble()                        // 'SET FOREIGN_KEY_CHECKS=0; SET UNIQUE_CHECKS=0; SET SQL_MODE="";\n'
export function windowDeleteSql(table, since, until)    // for the trio: `DELETE FROM matches WHERE start_time >= ? AND start_time < ?` (odds cascade) ; canonical/derived tables use REPLACE only (live rows overwrite) - returns null for them
export function statusRows(db)                          // the SQL text list run on both sides for `status` (row counts + MB per table, per-date/provider match counts last 7 d, MAX(updated_at) matches, MAX(kickoff), knex_migrations MAX(name))
export function compareStatus(local, remote)            // -> printable side-by-side rows with lag markers
```
Date columns: fixtures.kickoff; matches.start_time; standings: full only; teams/leagues/aliases: full only (small); fixture_statistics/events/lineups/players/prematch/api_predictions/ai_insights/fixture_predictions: `fixture_id IN (SELECT id FROM fixtures WHERE kickoff >= '<since>' AND kickoff < '<until>')`; daily_slips: `slip_date >= ...`; odds_markets: `match_id IN (SELECT id FROM matches WHERE start_time >= ... AND start_time < ...)`.
- [ ] **Step 1: tests** (`tests/sync-rules.test.js`): `planPull` rejects `users`; default table set excludes instance tables; `dumpArgs` for a windowed table contains `--no-create-info` and `--replace` and the `--where`; for `full` contains `--add-drop-table` and no `--where`; `windowDeleteSql('matches',...)` non-null, `('fixtures',...)` null; `compareStatus` marks the side with the smaller count/older timestamp.
- [ ] **Step 2: implement, tests pass.**
- [ ] **Step 3: refactor `deploy-remote.js`** to import from `lib/remote.js` + `INSTANCE_TABLES` from `lib/sync-rules.js`; `node scripts/deploy-remote.js --all --dry-run` output must be identical to before (capture before/after and diff).
- [ ] **Step 4: commit** `refactor(scripts): shared remote/ssh helpers + pure sync rules`.

### Task 7: `scripts/db-import.js`

**Files:** Create `scripts/db-import.js`.

**Interface:** `export async function importDb({ inPath, container = null, database = config.DB_DATABASE, onProgress = null })` streams `inPath` (gz) -> gunzip -> `docker exec -i <container> <mariadb|mysql> -u -pXXX <database>` (password via `-e MYSQL_PWD=` exactly like db-export.js; resolve container/binary by reusing db-export's `resolveContainer` (export it) and a sibling `resolveClientBinary` (`mariadb` > `mysql`)). CLI: `node scripts/db-import.js <file.sql.gz> [--container <name>] [--yes]`: prints target DB + file size, refuses without `--yes` (it writes the local DB), progress = bytes read of the gz file / total with MB/s + ETA, exit code from the client. Also accepts `--preamble` (default on) which prepends `importPreamble()` to the stream (needed for `--compact` dumps).
- [ ] **Step 1: implement**; **Step 2: verify** with a tiny round trip: `node scripts/db-export.js` (whole local DB, `backups/`), then import into a scratch DB `oddspro_import_test` (create it via `docker exec mariadb mariadb -e "CREATE DATABASE ..."`, import with `--database`, count `fixtures`, then DROP the scratch DB). **Step 3: docs** (QUICK-REFERENCE + toolset entry) **Step 4: commit** `feat(scripts): db-import.js, the reverse of db-export`.

### Task 8: `scripts/db-sync.js`

**Files:** Create `scripts/db-sync.js` (uses Tasks 6-7).

CLI:
```
node scripts/db-sync.js status                         # side-by-side local vs live (row counts, MB, per-date/provider coverage 7d, freshness, migration head)
node scripts/db-sync.js pull [--tables a,b] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--full] [--dry-run] [--yes]
node scripts/db-sync.js push --tables a,b [--since ...] [--yes]     # explicit tables only, never instance tables
node scripts/db-sync.js backup --remote-db <name>       # gz dump of ANY remote DB -> backups/remote_<name>_<stamp>.sql.gz (for D3)
```
Behaviour: `status`/`pull` first compare `MAX(name) FROM knex_migrations` both sides and abort on mismatch unless `--force`. `pull` per planned table: remote `mariadb-dump <dumpArgs> | gzip -9` streamed down (progress) to `backups/sync/<table>_<stamp>.sql.gz` (kept: it doubles as a backup), then local: for the trio in window mode run `windowDeleteSql` first, then `importDb` with preamble. Default window when `--since` is absent and not `--full`: last 3 days (`--since` = today-3d), which is the routine daily catch-up. Print a summary table (rows before/after per table via `status` counts). `push` mirrors it (local dump via `exportDb`-style docker exec with the same dumpArgs, `sshStreamUpload` into `gunzip | mysql`) and demands `--yes` plus a typed table list. Progress everywhere; every long step prints elapsed and MB/s.
- [ ] **Step 1: implement `status`** and run it against live: record the output in the checklist.
- [ ] **Step 2: implement `backup`**; run it for `oddsprok_prod` and `oddsprok_prod_1_3_0` (7.4 GB source, expect ~1 GB gz); verify each file gunzips (`gzip -t`) and record sizes. DO NOT drop yet (Task 10).
- [ ] **Step 3: implement `pull`**; dry-run first, then `pull --full` for the small canonical tables (leagues, teams, aliases, standings), then windowed pulls for the trio + fixture_* + ledgers from `--since 2026-08-01`, then a `--full` pass table by table for the historical bulk (odds_markets is ~2.6 GB raw, expect a long transfer: keep the meter honest). Verify with `status` afterwards: local counts >= live counts for every synced table, `MAX(updated_at)` equal.
- [ ] **Step 4: implement `push`** (code + dry-run only; no live push in this plan).
- [ ] **Step 5: docs** (CLAUDE.md commands block, QUICK-REFERENCE, DEPLOYMENT.md "keeping local current", toolset entries) **Step 6: commit** `feat(scripts): db-sync status/pull/push/backup with compressed streaming + progress`.

### Task 9: `scripts/hotfix-remote.js`

**Files:** Create `scripts/hotfix-remote.js`.

`node scripts/hotfix-remote.js <repo-relative file...> [--from <path>] [--restart] [--dry-run]`: for each file, remote backup `<file>.orig-<stamp>` (never overwrite an existing `.orig-*`), upload via `sshStreamUpload`, `node --check` for `.js` using `NODE_BIN`, and with `--restart` touch `<APP_DIR>/tmp/restart.txt`. Refuses `.env`. Prints the exact rollback command (`cp <file>.orig-<stamp> <file> && touch tmp/restart.txt`). Record in DEPLOYMENT.md as the emergency route. Commit `feat(scripts): hotfix-remote.js file-level live patch route`.

### Task 10: ship v1.4.0 build 2 + live verification + dead-DB drop

- [ ] **Step 1:** `npm test`, `npm run build:web`, `git status` clean; move the tag: `git tag -f v1.4.0 HEAD && git push -f origin v1.4.0` (owner-approved retag, D1); `npm run package:deploy` (existing tag at HEAD -> skipped, no warning).
- [ ] **Step 2:** `node scripts/deploy-remote.js --app --web` (NO `--db`). `MIGRATE_ON_BOOT=1` on the host applies the `meta` migration at first boot. Restart: `touch ~/oddspro-app-v1.4.0/tmp/restart.txt` (or cPanel Restart). If the classifier blocks the ssh writes, hand the owner the exact commands.
- [ ] **Step 3: verify on the host** (read-only probe): exactly ONE instance logs `[lease] writer gained`; `GET /api/refresh` returns the same `data_version` from repeated calls over a minute (different instances); after the next light pass `matches.updated_at` moves and `warehouse_version` increments; `stderr.log` no longer grows with `[warm] /api/columns failed`; `/api/columns` answers < 1 s.
- [ ] **Step 4:** D3: with both backups verified (Task 8 step 2), run on the host `DROP DATABASE oddsprok_prod; DROP DATABASE oddsprok_prod_1_3_0;` via `sshInput` from a one-off script (owner-approved; if blocked, hand over the command). Re-run `db-sync status`.
- [ ] **Step 5:** update `docs/agents/toolset.md`, `docs/DEPLOYMENT.md` (build-2 routine), memory-bank entry for the incident, checklist closed, resume point updated. Commit `docs: v1.4.0 build 2 shipped, incident + sync playbooks`.

## Self-review notes
- Spec A1-A7 map to Tasks 1-5, 9, 10; B maps to Tasks 6-8; D3 to Task 10 step 4; D2 encoded in `sync-rules` (REPLACE + windowed delete for the trio, push explicit only). C-F deliberately absent (own specs).
- Names used consistently: `isWriter`, `warehouseVersion`, `columnCatalogFromMeta`, `planPull`, `dumpArgs`, `importDb`, `sshStreamDownload`.
