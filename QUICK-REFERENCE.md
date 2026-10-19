# QUICK-REFERENCE

> Command/action sequences only. The WHY lives in `docs/engine/` (system bible); per-file
> architecture in `CLAUDE.md`; verified ops playbooks in `docs/agents/toolset.md`.
> **Commands or routines changed? Update this file in the SAME commit** - full triggers
> table: `docs/engine/00-README.md`.

## 1. Development

### 1.1 Prerequisites

- Node **20+** (prose requirement - no `engines` field by design; lockfiles gitignored).
- Docker with a MariaDB/MySQL container on host **:3306** - must pre-exist and is
  auto-detected (no compose file or canonical container name in the repo; pass
  `--container <name>` to scripts when detection fails).
- Windows/PowerShell 5.1 quirks (no `&&`, BOM traps): `docs/agents/toolset.md` §2.

### 1.2 Fresh clone → running

```sh
git clone <repo> && cd oddspro
npm install
cp .env.example .env      # REQUIRED: DB_*, X_APISPORTS_KEY. Set PIN_PEPPER BEFORE migrate.
                          # Local dev: AUTO_REFRESH_ENABLED=0 (no background scraping/API spend)
npm run migrate           # forward-only; seeds admin +254799944004 (PIN = ADMIN_SEED_PIN, default 0000)
npm --prefix web install
npm run serve             # API :3001 (serves web/dist when built)
cd web && npm run dev     # frontend dev :5173, proxies /api → :3001   (or: npm run build:web)
```

### 1.3 Everyday commands

Semantics authority: `CLAUDE.md` `## Commands` (names duplicated here, annotations never).

| Command | Does |
|---|---|
| `npm run start [-- days]` | full pipeline sweep, today..+3 days |
| `npm run serve` | API :3001 + in-process schedulers |
| `npm run build:web` | React build → `web/dist/` |
| `cd web && npm run dev` | frontend dev server :5173 |
| `npm test` | offline node:test suite (< 2s, no DB/APIs) |
| `npm run migrate` / `migrate:make <name>` | apply / scaffold migrations |
| `npm run package:deploy` | release zips - see §2.2 |

`node src/index.js <action> [date]` (idempotent; `[date]` defaults today):

| Action | Does |
|---|---|
| `betpawa` / `betika` | scrape odds → DB, auto-link |
| `fixtures` | canonical fixtures → DB, auto-link |
| `results` | settle finals, complete matches |
| `link [provider]` | correlate matches ↔ fixtures |
| `stats` / `standings` / `history` / `prematch` / `predictions` | deep data (fetch-once) |
| `hotpicks` | settle + recompute picks/tips (bills NO AI) |
| `dailyslip [date]` | settle + build the Daily MultiBet card - the day's top 3 Picks, read from `fixture_predictions`, so run it after `hotpicks` (freezes at first pick kickoff) |
| `reference [date]` | Pinnacle reference odds for the date (default today..+2), then settle + rebuild the Sharp-anchored Pick shadow (BILLED, about 1 request per 10 fixtures; kicked-off fixtures never written) |
| `aireview` | drain pending AI verdicts once |
| `enrich` | AI enrichment (BILLED; full-sweep-only) |
| `performance` | flat-stake ROI / hit-rate report |
| `export [date]` | CSV → `tmp/` |
| `geo` | visitor-IP geo backfill pass |
| `sms balance\|delivery <id>\|send <phone> <text>` | SMS provider ops |

Analysis-script chooser (backtests, mines, scorecards): `docs/agents/toolset.md` §4.
Stuck `results` settle (ft<ht inconsistency, e.g. an awarded-game data glitch): `node
scripts/refetch-fixtures.js --ids <a,b,c>` (or `--inconsistent` to auto-select every affected
final fixture) force-refetches from API-Football then re-runs the settle pass, printing
before/after `ht/ft/goals` and which ids changed; details in `docs/agents/toolset.md` §5.
Duplicate link-claim repair (a reschedule left a stale bookmaker listing holding the fixture,
back-dating the eventual score): `node scripts/repair-duplicate-claims.js [--yes] [--limit N]`
keeps, per (provider, fixture), the listing closest to the canonical kickoff and unlinks the
rest, clearing the scores they inherited; dry-run by default, idempotent.
Orientation repair (API-Football swapped a fixture's sides after linking, so the bookmaker
names and the canonical score render backwards): `node scripts/repair-orientation.js [--yes]`
stamps `matches.sides_swapped` over all history; dry-run by default, idempotent.
Forget a poisoned alias (a `team_aliases`/`league_aliases` entry is short-circuiting the
linker onto the wrong team/league): `node scripts/forget-alias.js (--list <term> | --team
<name> | --league <name>) [--provider p] [--yes]` - `--list` searches both tables, `--team`/
`--league` delete an exact match (dry-run by default); deleting only removes the shortcut,
the next link pass re-derives the correlation by scoring.
The Pick + Top-3 picks card (current since 2026-10-16; chapter 05 "The Pick"): replay the
production `pick-rules.js` over the settled extract with `node scripts/replay-picks.js
[tmp/sharp/fx.ndjson]` (`WINDOW=<days>` env overrides the 90-day window; read-only). It must
print `below 1.50: 0` and claimed within about a point of hit. Build the extract with the
Sharp procedure below (host extract, then `sharp-prep.js`). The daily 2-leg 2.5x slip:
`node scripts/replay-slips.js [file]` replays it and the alternative designs through the
production `selectSlip` (read-only; `DUMP=<file.json>` writes the per-day rows).
Sharp-anchored Pick shadow (2026-10-18; chapter 05): `node scripts/report-anchored.js
[--from d] [--to d] [--days] [--json out.json]` prints the forward per-day legs, hit vs
Pinnacle's claim, flat ROI +- SE and the pass bar (30 days, >= 400 legs, ROI > 0 with lower
95% > -2%, hit within 2 points of the claim). Read-only. Capture runs daily by itself
(sweep + T-3h/T-1h); upstream purges odds after about 7 days, so never leave
`REFERENCE_ODDS_ENABLED` off for long.
Weekly reading of that shadow from the workstation: `node scripts/ops/anchored-weekly.mjs`
(one ssh call runs the report on the host, keeps the JSON under `~/ops/anchored/`, appends a
line to the host and local `anchored-ledger.ndjson`, prints the report and an `ANCHORED
PASS|NOT YET` line; exit 1 = host unreadable). Scheduled Mondays 09:20 local (dispatch adds a few minutes) as the Claude
task `oddspro-weekly-anchored-report`, sibling of the health digest.
Backfill past days with the current algorithm: `node scripts/backfill-algo.js --dry-run`,
then `--yes` (writes `tmp/backfill-algo-<stamp>.json` first; undo with `--restore <file>
--yes`). Local DB for analysis: Docker `oddspro-db` on 127.0.0.1:3307 (`.env` DB_PORT=3307,
DB_DOCKER_CONTAINER=oddspro-db); the name `mariadb` and port 3306 belong to local-web.
Daily MultiBet grid + timeline backfill (pre-2026-10-16 ladder): `node scripts/simulate-daily-slip.js --db oddspro`
(report; `--write-daily --yes` backfills `daily_slips` walk-forward; findings doc
`docs/research/2026-08-06-daily-multibet-simulations.md`).
Sharp 4x card (RETIRED 2026-10-16, no longer built; BetPawa 3-leg slip with its Win Bonus; chapter 05 "Sharp 4x"): research
bundle = a SELECT-only host extract into `tmp/sharp/*.tsv.gz` (procedure in
`docs/research/2026-10-15-sharp-4x.md`), then `node scripts/sharp-prep.js` (fold, drops
prices written at/after kickoff) and `node scripts/sharp-backtest.js [--last 14]` (drives
the production `sharp-rules.js`; must reproduce 24/85 on the 2026-10-15 bundle). Live-data
check without writing: `node scripts/sharp-dryrun.js [date] --require-read-only` (needs a
`tx_read_only = 1` session). Past days: `node scripts/backfill-sharp.js [--days 14] [--yes]`
(appends a backfilled Sharp card to existing rows, saves `tmp/backfill-sharp-<stamp>.json`
first; `--restore <file> --yes` undoes it). Nothing to retune by hand: the residual cells
re-fit from settled results every build and the bonus config is read from BetPawa live.
Gen-2 ladder evolution (MONTHLY routine): `node scripts/evolve-gen2.js [--json out.json]`
(deterministic 120+ generation coordinate descent over the tier-card config, train/test
split, per-tier refinement; bake = edit DEFAULT_GEN2 + bump ALGO_VERSION, then
`node scripts/backfill-gen2-timeline.js --yes` to regenerate the honest timeline).
Legacy v1 evolution: `node scripts/evolve-daily-slip.js --db oddspro`
(deterministic coordinate-descent over the walk-forward replay, train/test split; bake a
new champion ONLY when it wins train AND does not lose the test tail, then bump
ALGO_VERSION + re-run the backfill).
ASCII punctuation normalization (owner's standing rule: no em-dash/en-dash/curly quotes/
ellipsis in prose): `node scripts/normalize-punctuation.js [--check]` (`npm run check:prose` = the
check form; enforced automatically by the tracked pre-commit hook `.githooks/pre-commit` -
new clones run `git config core.hooksPath .githooks` once to arm it) walks every git-tracked
file and rewrites em-dash -> ` - `, en-dash -> `-`, curly quotes -> straight, ellipsis -> `...`;
`--check` reports offenders and exits 1 without writing. Idempotent; preserves each file's
line endings/BOM; skips binaries/`web/dist`/`node_modules`/lockfiles/fonts/images/`.sql*`/the
root `x-*-output*.json` snapshots, and a small hardcoded list of regex/char-class literals in
`tests/` that deliberately test FOR one of these characters.

### 1.4 Dev routines - in this order

1. **After pulling backend changes:** restart `npm run serve` (a stale process holds :3001
   with old code).
2. **Manual sweep on a machine running serve:** stop serve (or `AUTO_REFRESH_ENABLED=0`) →
   `npm run start` → restart serve. Two writers = InnoDB gap-lock deadlocks.
3. **Before touching `DEFAULT_SAFE`:** `node scripts/analyze-safe-tips.js` (weekly cadence
   regardless).
4. **Cache clearing:** `?refresh=1` recomputes `/api/magic-sort` ONLY; records freshness =
   `data_version` bump (light pass) or the `REFRESH_CACHE_MINUTES` window; restart serve to
   drop the in-memory response memo.

### 1.5 Dev health checks - in this order

1. `npm test` - trust the live count, not doc snapshots.
2. `GET http://127.0.0.1:3001/api/refresh` - `data_version` + `last_success` freshness, and the `warm` block: last pass should be recent with `failed: 0` (the warm keeper precomputes records/columns/hotpicks/performance so no visitor pays a cold compute).
3. Tail `logs/auto-refresh.log` - recent `light ok` lines; console shows `[warm] <reason> pass: N/N computed`.
4. No `./.HALT` file present.

## 2. Production

### 2.1 Prerequisites

On `main` only; versions bumped in **both** `package.json` + `web/package.json` (lockstep);
cPanel access. Deep guide: `docs/DEPLOYMENT.md` §2-3 (one-time host setup lives there).

### 2.2 Release build - in this order

```sh
# 1. bump version: package.json + web/package.json (user decision)
npm test
npm run build:web
npm run package:deploy    # [-- --export-db] adds a gzipped DB dump, same timestamp
```

Produces `release/oddspro-app_<ts>.zip` + `oddspro-web_<ts>.zip`; refuses off-`main`;
idempotently tags `v<version>` at HEAD and pushes the tag (existing tag not at HEAD = loud
"bump the version" warning).

### 2.2c Secrets + env hygiene

```sh
npm run gen:secret        # = node scripts/gen-secret.js [hex|b64|pin|uuid] [bytes|digits]
node scripts/env-audit.js                                      # read-only: SECRET / DIFFERS / REDUNDANT / UNKNOWN report
node scripts/env-to-settings.js [--yes]                        # migrate admin-editable .env overrides into the settings table
```

env-audit compares the live .env against code defaults so trims are safe: REDUNDANT lines
change nothing and can go; a DIFFERS line is load-bearing (the 2026-07-26 lesson: a
"clean" .env silently dropped LINK_MIN_CONFIDENCE=0.8 and made the linker stricter).

### 2.3 Production config - `.env` vs Admin → Settings

**Precedence: `settings` table (Admin → Settings) → `.env` → code defaults.** 82 of the 121 config keys are admin-editable and audited in `admin_audit`; only the other 39 (credentials, endpoints, pre-DB boot infra) belong in `.env`. `.env.example` is the authoritative template of what stays. Full split + trim runbook: `docs/DEPLOYMENT.md` §9.

**Host `.env` (not admin-editable):**

| Knob | Setting |
|---|---|
| `MIGRATE_ON_BOOT=1` | Restart self-runs migrations, fail-fast (the no-SSH migration path) |
| `PIN_PEPPER` | Set BEFORE the first migrate/restart; **NEVER rotate** (invalidates every PIN) |
| `API_HOST=127.0.0.1`, `DB_POOL_MAX=3` | shared-host posture |
| `BONGA_*` creds, `MAIL_*` creds, `OPENROUTER_API_KEY` | secrets; `.env` only, never the catalog (`GEMINI_API_KEY` gone with the 2026-08-04 retirement; leftover lines are ignored) |
| `AUTH_ENABLED` | gates the admin UI itself, so it cannot be admin-owned |
| `VITE_SHOW_DETAILS=0` | **build-time**: hides tip internals in the prod bundle (rebuild `web/dist`, not a server setting) |

**Admin → Settings (editing `.env` for these is outranked by any DB override):**

| Knob | Group |
|---|---|
| `AUTO_FULL_AT` (EAT), `AUTO_LIGHT_MINUTES` - refresh cadence | `refresh` (both restart-required) |
| `ODDS_HISTORY_ENABLED` (on), `ODDS_TARGET_MAX_LAG_MINUTES` (15) - odds change log + target snapshots; `ODDS_DUE_ENABLED` (on), `ODDS_DUE_LEAD_MINUTES` (5), `ODDS_DUE_MAX_PER_TICK` (40), `ODDS_DUE_DURING_SWEEP` (on) - the due-queue lane | `refresh` (all live) |
| `SMS_ENABLED=1` - required for real sign-ups (off = codes log server-side) | `sms` |
| `DEBUG=0` - shared-host posture | `logging` |
| AI caps/models (`TIP_AI_DAILY_CAP`, `AI_ENRICH_CAP`, `OPENROUTER_MODEL`, ...) | `ai`, `ai-dark` |
| Bot protection (opt-in) - `docs/DEPLOYMENT.md` §8 | `bot` |

### 2.4 Deploy - in this order (detail: `docs/DEPLOYMENT.md` §4-5)

**Automated over SSH (v1.4.0+, the default; config `.env.deploy`, prod env `.env.server`):**

```sh
node scripts/deploy-remote.js --all --fresh   # FIRST deploy of a version: DB full copy
                                              # + instance-table truncate + admin reseed,
                                              # app extract + npm install, web backup/swap
node scripts/deploy-remote.js --db            # subsequent: warehouse-only DB overwrite
                                              # (users/sessions/settings survive)
node scripts/deploy-remote.js --app --web     # code-only redeploy
                                              # (--dry-run prints every remote command)
```

Emergency single-file fix (no release build): `node scripts/hotfix-remote.js <file...>
[--from <dir>] [--restart] [--dry-run]`: ONE ssh call total (tarball of the files + a
generated apply script piped in via stdin, extracted and run server-side) - backs each file
up (`.orig-<stamp>`), installs, `node --check`s `.js`/`.mjs`/`.cjs`, prints its md5sum, and on
ANY failure rolls back every file the run already touched before exiting non-zero, all with
no further round trips. Prints the manual rollback command too; detail `docs/DEPLOYMENT.md`
§5.1.

Then in cPanel: create/point the Node.js app at `oddspro-app-v<version>` + **Restart**
(with `MIGRATE_ON_BOOT=1` this applies any new migration first). Smoke test (§2.5).

**Manual fallback (File Manager):**

1. Upload + extract app zip → Application Root; web zip → `public_html`.
2. cPanel **Run NPM Install** - only if dependencies changed.
3. **Restart** (with `MIGRATE_ON_BOOT=1` this applies any new migration first).
4. Smoke test (§2.5).

### 2.5 Post-deploy smoke test - in this order

1. `GET /api/refresh` - fresh `data_version` / `last_success`, and `warm.last` recent with `failed: 0` (each instance precomputes its own memo, so check per instance if diagnosing slowness).
2. `GET /api/columns` - catalog loads fast (an index regression shows here first).
3. `GET /api/visits/daily-unique` - public counter answers.
4. `GET /api/coverage` - data-notice status answers (public, memo-backed, costs no query).
5. `logs/auto-refresh.log` gains `light ok` lines (proves the process stays resident).
6. Web page title shows the new version.

### 2.6 Production routines

| Routine | Command / action |
|---|---|
| Daily sweep | in-process (serve); optional cron backup ≥ 1h from `AUTO_FULL_AT` - Windows task `oddspro-pipeline` 08:00 / `scripts/pipeline-cron.sh` |
| Cron-only host | run `node src/index.js aireview` after each sweep (else AI verdicts stop) |
| Stalled-collection watchdog | cron every ~15 min: `node scripts/collection-watchdog.js`, flags stalled odds collection (`WATCHDOG_STALE_MINUTES`/`WATCHDOG_QUIET_STALE_MINUTES`), touches `tmp/restart.txt` to recycle Passenger, SMS-alerts the admin after `WATCHDOG_ALERT_AFTER` consecutive stale runs; reports `busy` (no restart, no SMS) while the writer's `job_state` beacon shows a full sweep younger than `WATCHDOG_FULL_SWEEP_GRACE_MINUTES` (480). Never exits non-zero; log in `logs/watchdog.log` |
| Daily health snapshot | host cron 13:20 EAT (verdict shared with the app, see next row): `~/ops/prod-health.sh` (source `scripts/ops/prod-health.mjs`) appends one JSON line per run to `~/ops/health/ledger.ndjson` (verdict GREEN/AMBER/RED with reason codes, light-pass counts and gaps, latest full sweep, odds freshness, per-table accumulation counters, bookmaker coverage, notices, host and API-Football plan status), rewrites `latest.txt`, leaves `~/ops/health/ALERT` and sends one SMS to the admin on RED only. Silent cron, always exit 0. Read: `ssh oddspro 'cat ~/ops/health/latest.txt'` |
| Health ledger over HTTP (survives SSH loss) | the writer instance takes the SAME snapshot in-process once per EAT day at `HEALTH_SNAPSHOT_AT` (default 13:20, Admin -> Settings, group refresh; a boot past the slot catches up within a minute) into table `health_snapshots`; one SMS on RED when `HEALTH_SNAPSHOT_SMS` is on (to `OPS_ALERT_PHONE`, else the active admin). Read: `curl -s -H "Authorization: Bearer $ADMIN_TOKEN" https://<site>/api/admin/health/ledger?days=14` (1..120, newest last) or `.../api/admin/health/latest`; check `freshness.stale` / `freshness.missing_today` first - no row means the writer itself is down. The cron and the app share `src/health-collect.js` + `src/db/health-rules.js`, so the host cron needs an app build carrying them |
| Odds history of one match | `GET /api/odds-history/<match_id>[?limit=N]` (signed-in / PAT / machine bearer; guests 401): every logged look, every pre-match price change, the five frozen targets (opening, T-24h, T-3h, T-1h, closing) with replayed markets, lag, quality and `kickoff_moved`. `match_id` is the `match_id` field of `/api/records` rows |
| Odds history growth check | `SELECT SUM(changes)/SUM(markets) FROM odds_observations WHERE kind='update';` = share of re-observed prices that moved (the storage driver, spec 2026-10-10-1600); `SELECT target, quality, COUNT(*) FROM odds_target_snapshots GROUP BY 1,2;` = target coverage. If disk runs short: Admin → Settings `ODDS_HISTORY_ENABLED` off (the next look per match re-baselines when it goes back on) |
| Emergency stop | create `.HALT` in the app root - running serve exits ≤ ~30s, boot refused; delete to resume |
| Scheduled maintenance window | Admin → Dashboard "Maintenance" card (or Admin → Settings group `maintenance`): toggle + EAT start/end + message. Guests: banner pre-window, full-screen notice + API 503 during; admins/bearers bypass; auto-expires at end (M14) |
| User management (rescue a user) | Admin → Users: disable/enable, unlock, manual phone-verify (SMS-failure fallback), force PIN change, Reset PIN → temp PIN shown ONCE (user must change it at next sign-in). Self-disable/demote and last-admin removal are blocked (M8). Self-service alternative: Forgot PIN below (M13) |
| Forgot PIN (self-service) | Sign-in → "Forgot your PIN?" → code to the phone (falls back to the account's STORED email when SMS delivery verifiably fails) → new PIN + auto sign-in; every prior session is revoked (M13) |
| Email OTP fallback | Verify / PIN-change / Forgot-PIN codes can go by email when SMS can't deliver. `MAIL_MAILER=log` (default) prints emails to the server console (dev); `smtp` sends via .env `MAIL_*` creds. Admin → Settings group `Email` holds only the switch (M13) |
| Broadcast an SMS to users | Admin → Messaging: pick audience (filter or a Users-section selection) → live preview shows recipients · segments · **credits** → Send needs typing `SEND` + the previewed count. **Opted-out users are excluded always**, even from a hand-picked selection. `SMS_ENABLED=0` = dry run, no network. A sent campaign is frozen - send the remainder as a NEW campaign, never a re-send (M9) |
| Campaign send refused 409 "audience grew" | Someone signed up/verified between your preview and confirm, so the send would reach people you never previewed and bill past the estimate. Re-preview and confirm the new count. Shrink (opt-outs/disables) proceeds silently - it stays a subset of what you approved (M9) |
| DB backup | `node scripts/db-export.js [--container <name>]` → `backups/` (**mariadb-dump, never mysqldump**; phpMyAdmin-ready) |
| DB restore (local) | `node scripts/db-import.js <file.sql.gz> [--container <name>] [--database <name>] --yes` (**OVERWRITES** the target DB; refuses without `--yes`; streams gzip → gunzip → `mariadb`/`mysql` client) |
| Keep local current with live | `node scripts/db-sync.js status` (side-by-side counts/freshness/migration head) then `pull [--tables a,b] [--since YYYY-MM-DD] [--full] --yes` (**LIVE WINS** - `--full` on a table drops+recreates it wholesale, discarding any row that only exists locally; default window pulls the last 3 days). Aborts on a `knex_migrations` head mismatch unless `--force` - check what changed between the two heads before forcing. Every pulled table also lands a dated copy in `backups/sync/` |
| Backup ANY remote DB | `node scripts/db-sync.js backup --remote-db <name>` → `backups/remote_<name>_<ts>.sql.gz` (works on dead/legacy DBs too, not just the deploy target) |
| Changed-pepper recovery | `node scripts/reset-users.js --yes` (**DESTRUCTIVE** - wipes all users; dry-run without `--yes`) |
| Rollback | `docs/DEPLOYMENT.md` §5 |

## 3. Critical warnings & best practices

| Warning | Why |
|---|---|
| Run exactly ONE `npm run serve` | a second writer process gap-lock-deadlocks on the same odds rows |
| Restart serve after every backend pull | stale process serves old code; a web 500 usually means the API is down/stale |
| Never edit an applied migration | forward-only; add a new one |
| Never rotate `PIN_PEPPER` casually | invalidates every stored PIN (deliberate global reset only) |
| Releases/tags from `main` only | `package:deploy` enforces; versions bump root + web in lockstep |
| Never move a live generation knob (`TIP_MIN_PRICE`, `SAFE_*`) mid-experiment undated - change it via Admin → Settings so `admin_audit` dates it (M6); a raw `.env` move still needs a dated `docs/memory-bank.md` note | it partitions the measurement ledger (the 2026-07-10 lesson) |
| Never touch `DEFAULT_SAFE` without a fresh `analyze-safe-tips.js` run | the gates are LODO-tuned, not opinions |
| `DEFAULT_TIP.suppressedMarkets` / `statsVetoGap` ship DISABLED - do not enable without a re-test | both looked strong on the live ledger and REVERSED SIGN under re-derivation; the ledger spans two config regimes (`docs/research/2026-07-26-banker-ladder.md` §7) |
| The Pick and Top picks are WIN-CHANCE products, never an EV claim - label them that way in every surface | replay flat ROI -6.3% (train) / -6.4% (test); a 1.50+ price caps one pick near 65%, so no day is guaranteed |
| Never write sub-1.50 markets into `tip_banker_*` again (the deleted `backfill-banker.js` did) | readers treat those columns as the Pick since 2026-10-16; pre-switch rows only survive because `pickView` rejects them |
| `.env` overrides silently differ from code defaults (`TIP_MIN_PRICE` 1.35 vs 1.2, `TIP_MIN_UNDER_LINE` 3.5 vs 4.5) | any backtest run on code defaults is measuring a DIFFERENT engine than the live one |
| DARK switches (`AI_INJECTION_PREAMBLE`, `AI_CONSENSUS_*`) need an explicit user go BEFORE flipping; flip them in Admin → Settings (group `ai-dark`) so `admin_audit` dates the change (M6 - replaced the manual memory-bank note) | AI regime changes must be attributable |
| `scripts/reset-users.js` is DESTRUCTIVE | wipes all users/sessions/prefs |
| Frozen ledger / fetch-once: never rewrite settled rows or refetch immutable data | the scoreboard is honest by construction - `docs/engine/02-DATA-PIPELINE.md` |
| Odds market identity = `type_name`, never `type_id` | Betika reuses ids across different markets |
| Never prune, update or hand-edit `odds_changes` / `odds_observations` / `odds_target_snapshots` | a target snapshot is a cutoff into the append-only change log, replayed on read - deleting log rows silently changes every frozen snapshot that points past them |
| Secrets live in `.env` only | never in git |
| **Live host runs three concurrent `lsnode` app instances** - only the `GET_LOCK` lease holder (`isWriter()`, `src/db/lease.js`) schedules/writes; the other two serve reads only | a follower running its own scheduler/AI worker would double-bill and gap-lock-deadlock the same rows it warns about above |
| `gzip -t` alone is NOT a completeness check on a dump | a shared host killing the remote connection mid-dump still lets `gzip` close its own output cleanly (`scripts/db-sync.js`'s `dumpLooksComplete`) |
| Never run `node scripts/deploy-remote.js --db` (or `--all --fresh`) against the live host outside a genuine first deploy | it overwrites the warehouse; routine fixes are `--app --web` only (`docs/DEPLOYMENT.md` §4a.1) |

## 4. Definitions

> Wording authority for user-facing terms is `web/src/glossary.js` (the in-app Help
> glossary, test-enforced against `tipMarketLabel()`); this table **indexes** those terms
> and adds developer-only lingo. On conflict, `glossary.js` wins. Signal/skip badge wording:
> `web/src/components/TipPopover.jsx` (`SIGNAL_LABEL`, `skipLabel`).

**Market codes** (1X2, 1X/X2/12, O/U, GG/NG, DNB1/DNB2, TT, ODD/EVEN): canonical
plain-language definitions live in `web/src/glossary.js`; canonical display names in
`tipMarketLabel()` (`src/db/magic-rules.js`).

### Pricing & value

| Term | Meaning (mechanism) | Source |
|---|---|---|
| Odds / price | decimal payout multiplier; `1/price` = implied probability incl. vig | `glossary.js` |
| Overround (vig) | `sum(1/price)` over a full market book; tip books accepted only inside [1.01, 1.30] | `src/db/tip-rules.js` `bookIntegrity` |
| Devig / fair probability | renormalize implied probabilities to sum to 1 | `goals-rules.js` `impliedProbability`, `tip-rules.js` `_devig` |
| Edge | `confidence × price − 1` - an EV *proxy* for bucketing/ordering, not a profit claim | `magic-rules.js` / `perf-rules.js` |
| Flat-stake EV / ROI | profit at 1 unit per settled pick; honest overall ≈ **−3%** (no +EV market) | `perf-rules.js`, `docs/research/` |
| Break-even rate | `1 / avg price` - the hit-rate a price class must beat to profit | `perf-rules.js` |
| `TIP_MIN_PRICE` | 1.2 generation floor - sub-1.20 "sure things" pay too little to matter | `tip-rules.js` |

### Prediction & selection

| Term | Meaning (mechanism) | Source |
|---|---|---|
| Canonical fixture | the API-Football record every bookmaker match correlates to (`matches.fixture_id`) | `docs/engine/02-DATA-PIPELINE.md` |
| Tip | best-supported outcome across 7 families; confidence = 0.6 market + 0.3 stats + 0.1 API | `tip-rules.js`, `docs/engine/04-PREDICTIONS.md` |
| Pick (column "Tip") | one market per game priced 1.50-2.20 (not DNB) with the highest walk-forward residual-calibrated chance; stored in `tip_banker_*` + `tip_banker_cal` since 2026-10-16. Replaced the Banker (shortest price on the board, O 0.5 in 30% of games) | `pick-rules.js`, `src/picks.js`, `docs/engine/05-RANKING.md` |
| Stats tip | the rolling-stats blend pick (`tip_*`, floor `TIP_MIN_PRICE`), second column since 2026-10-16 | `tip-rules.js` |
| Market lattice | `marketRelation(a,b)` -> contradictory / nested / identical / overlapping, derived from `tipOutcome` over every 0-6 scoreline so it cannot drift from settlement | `ladder-rules.js` |
| Coherent alternatives | displayed runners-up may never contradict the tip (`O 2.5` beside `U 2.5`) nor be a nested rung of it (`O 1.5` beside `O 2.5`) | `ladder-rules.js` |
| `rung_gap` | tip price minus the safest available price; strongest non-trivial hit/miss discriminator found (-0.20 sd). Persisted in `tip_breakdown` | `ladder-rules.js` |
| Hot pick 🔥 | binary Over-2.5 flag - all 9 gates passed; precision over recall | `goals-rules.js`, `docs/engine/04-PREDICTIONS.md` |
| Fairness pairing | both teams judged over the SAME window length, capped at the smaller side | `goals-rules.js` |
| Freeze at kickoff | `kickoff > NOW()` selection - past rows are never selected, hence never rewritten | `docs/engine/02-DATA-PIPELINE.md` |
| hit / miss / void | settled outcomes; void = DNB draw push (stake returned, excluded from rates) | `tip-rules.js` `tipOutcome` |
| Blend / parts | the components present in a tip's confidence (market/stats/api) | `tip-rules.js` |
| `safePrior` | market's live hit-rate beta-shrunk (k=20) toward its `WAREHOUSE_WLO` anchor | `magic-rules.js` |
| `sure` (strategy) | default sort = `safePrior × confidence` - win probability, NOT profit | `magic-rules.js`, `docs/engine/05-RANKING.md` |
| Top picks ⭐ (code: sure bets) | the day's 10 strongest Picks by `tip_banker_cal`, all 1.50+ - **not** the `sure` strategy | `magic-rules.js` `sureBetsSelection`, `docs/engine/05-RANKING.md` |
| Safe pool 🛡 | `safeQualifies` gates (parts/agreement/price/stats/maturity) + top-3/day | `magic-rules.js` |
| `estimateLegProb` | `bucketPosterior ?? confidence`, clamped [0.05, 0.98] - the slip survival number | `magic-rules.js` |
| Unbettable | pattern-mine class: real statistical lift priced below 1.20 - lift you cannot buy | `mine-rules.js` |

### Statistics & measurement

| Term | Meaning (mechanism) | Source |
|---|---|---|
| LODO | leave-one-day-out replay - day D is scored with calibration built without D | `magic-rules.js` `simulateStrategies` |
| Temporal OOS | train on older days, test on the newest - no future leakage | `mine-rules.js`, backtest scripts |
| Beta shrinkage | `(hits + k·prior) / (n + k)` - thin buckets pulled toward the prior | `magic-rules.js` |
| BH-FDR | Benjamini-Hochberg false-discovery control across pattern hypotheses | `mine-rules.js` |
| Day-clustered CI | bootstrap resamples DAYS, not rows - same-day tips are correlated | `mine-rules.js` |
| Brier | mean squared error of stated probabilities (AI calibration health) | `scripts/ai-scorecard.js` |
| edge / booster / refuted / underpowered | pattern-verdict vocabulary (closed class); booster = real lift, no profit; edge = clears break-even at real prices (**never found**) | `mine-rules.js` |
| Policy regime | the config epoch a measurement ran under; a mid-window knob move splits the ledger | `scripts/mine-patterns.js` warning |
| `WAREHOUSE_WLO` | per-market warehouse temporal-OOS hit-rate anchors feeding `safePrior` | `magic-rules.js` |
| `ai_impact` / saved | what following the AI vetoes was worth (vetoed picks settle but leave the headline rate) | `perf-rules.js` |

### Operations & data

| Term | Meaning (mechanism) | Source |
|---|---|---|
| Light pass / full sweep | 10-min today-only refresh vs the daily 12-step pipeline | `docs/engine/01-SYSTEM.md` |
| `data_version` | shared `meta.warehouse_version` (cross-instance since 2026-08-19, not a per-process counter) bumped on successful refresh; keys the response cache + client silent reloads | `src/meta.js`, `src/auto-refresh.js` |
| Fetch-once | immutable API detail fetched at most once per fixture (`*_fetched_at` flags) | `docs/engine/02-DATA-PIPELINE.md` |
| Stale odds | vanished market kept flagged with its last-seen price (it IS the historical price) | `src/db/odds-diff.js` |
| Observation (odds history) | one logged pre-match look at a match (`odds_observations`), written even when nothing moved - what makes target lag honest. `kind` first / baseline / update | `src/odds-history.js` |
| Change log | `odds_changes`: one row per price event (first_seen / changed / stale / revived / baseline), never for an unchanged price, never at or after the canonical kickoff | `src/db/odds-diff.js` `diffOddsChanges` |
| Baseline (odds history) | a look that re-states the whole snapshot because odds moved without the log seeing it (pre-existing match, history switched off, post-kickoff write); keeps the replay exact | `src/db/odds-history-rules.js` `observationKind` |
| Target snapshot | frozen opening / T-24h / T-3h / T-1h / closing row: the last look at or before the target, its lag, quality (ok / lagged / missing / baseline) and a cutoff into the change log; written once, never rewritten | `src/db/odds-history-rules.js`, `docs/engine/02-DATA-PIPELINE.md` |
| Due-queue lane | between scheduled passes, fetches just the matches whose target window `[target - lead, target)` is open and not yet looked at; never a job, never bumps `data_version` | `src/odds-due.js`, `docs/engine/01-SYSTEM.md` |
| `coverage.status` | `ok`/`degraded`/`outage` for a date, worst active notice wins; served on `/api/records`, `/api/refresh`, `/api/daily-slip/timeline`, `/api/coverage` | `src/db/notice-rules.js` `coveragePayload` |
| `UNCONFIRMED` prefix | an auto-detected, not-yet-approved notice; shown from the moment it is proposed, dropped on approval, never changes the notice text | `src/db/notice-rules.js` `noticeLabel` |
| Alias | learned provider→canonical team/league name mapping - the linking fast-path | `src/link.js` |
| DARK switch | shipped-but-off AI regime knob; flipping needs an explicit go, dated by `admin_audit` (M6) | `AGENTS.md` |
| Model tag (`#pN`) | model+grounding+prompt-version identity keying AI-verdict reuse | `src/ai/adjudicators.js` |
| `AiGuardOpen` | the AI run guard tripped (wall-clock budget / breaker) - remaining calls refuse instantly | `src/ai/harness.js` |
| `.HALT` | kill-switch file: presence stops a running serve and blocks boot | `src/halt.js` |
| EAT day | Africa/Nairobi calendar day (+03:00 pinned in the SQL session) - daily caps and schedules key on it | `knexfile.js` |
| Gap lock | InnoDB range lock behind the single-writer rule | `toolset.md` §3.2 |
| `PIN_PEPPER` | server-wide scrypt secret; set before first migrate, never rotate | `src/auth-rules.js` |
| `MIGRATE_ON_BOOT` | serve self-migrates before listening - the no-SSH host migration path | `src/server.js` |
