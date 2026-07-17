# cPanel Shared-Hosting Deployment (manual)

> **Status:** oddspro is **live at [oddspro.ke](https://oddspro.ke)** — the 2026-07-12 upload (pre-v1.1.0; web titled v1.0.3) is still what the host runs, verified 2026-07-17. **v1.2.0 is tagged (`v1.2.0` @ `f7f1f9d`, suite 707/707) and packaged** — zips + step-by-step in `release/DEPLOY-CHECKLIST-v1.2.0.md` (gitignored); upload it via this workflow. ⚠ Its first restart runs migration batches 9–14 and seeds the admin — **`PIN_PEPPER` must be in the host `.env` BEFORE that restart** (§5 + the checklist).

Deploying oddspro to a shared cPanel host with **no SSH/terminal access** — only Setup Node.js App, Cron Jobs, File Manager, and phpMyAdmin. This is the **manual-first** workflow: build locally, upload the built files. No Git Version Control, no `deploy` branch, no build step on the server. (CI/CD can come later when the host gains SSH — see §7.)

## What's new in the 2026-07-17 detours (deployment-relevant)

- **`./.HALT` kill-switch.** cPanel's Stop button is unreliable; creating a file named `.HALT` in the app root (File Manager) gracefully stops the serve process within ~30s, and any respawned process **refuses to boot** (exit 1) while the file exists — Passenger eventually marks the app errored, which IS the desired "stopped" state. Delete the file to allow boot again.
- **AI verdicts moved to a background worker.** The daily sweep no longer bills AI (it dropped from ~75 min to seconds); hot-pick/tip verdicts are drained by an in-process worker every 60s while the serve runs. **Hosts running cron-only (no always-on serve): add `node src/index.js aireview` after the daily sweep**, or verdicts stop accumulating. `TIP_AI_DAILY_CAP` is now a per-EAT-day billed budget held in memory PER PROCESS — a serve restart resets it (worst case one extra cap that day), and each `aireview` cron invocation gets its own budget (effectively per-invocation, like the old per-run cap).
- **Light passes are cheaper:** kickoff-proximity backoff (`ODDS_REFRESH_TIERS`) + an idle skip (`AUTO_IDLE_LOOKAHEAD_MINUTES`) cut odds detail calls sharply; matches ≤90 min from kickoff always refresh. The daily full sweep and the manual refresh button bypass the backoff.
- New `.env` knobs (all with sane defaults, see `.env.example`): `HOTPICK_AI_CONCURRENCY`, `TIP_AI_REUSE_PRICE_TOL`, `ODDS_REFRESH_TIERS`, `AUTO_IDLE_LOOKAHEAD_MINUTES`, `AI_RUN_MAX_MINUTES`, `AI_BREAKER_AFTER`; plus the DARK regime switches `AI_INJECTION_PREAMBLE` / `AI_CONSENSUS_*` (leave OFF — flipping one requires the dated `docs/memory-bank.md` regime note first).

## What's new in v1.1.0 (deployment-relevant)

- **User accounts (phone + 4-digit PIN, SMS OTP verification).** ON by default (`AUTH_ENABLED=1`). Anonymous visitors become a **guest tier**: no future dates on `/api/records` (403 `{auth_required}` → the SPA shows a sign-in panel), the all-dates view stops at today, and rows lose the internal reasoning (`tip_breakdown` / AI reviews / hot signals; confidence quantized). Signing in restores everything. `AUTH_ENABLED=0` (or an `API_TOKEN`/`ADMIN_TOKEN` machine bearer) restores the legacy full-access behavior — note this means **plain `curl` against a production host now gets redacted records**; use a bearer when smoke-testing full payloads.
- ⚠ **`PIN_PEPPER` is REQUIRED for production.** Every PIN hash mixes in this server-wide secret; without it the server boots with a loud `[auth] PIN_PEPPER is unset` warning and hashes are salt-only. Set it **BEFORE the users migration runs** (the seeded admin's PIN is hashed at migrate time) and **never change it afterwards** — a changed pepper invalidates every stored PIN (that's the deliberate global-reset lever). Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
- **New migrations (batch 11):** `users` / `sessions` / `otp_codes` / `settings` / `user_prefs`. The users migration **seeds one admin** from `ADMIN_SEED_PIN` (default `0000`, must be exactly 4 digits) flagged `must_change_pin` — the first login forces a real PIN. Apply via `MIGRATE_ON_BOOT=1` + Restart (§5).
- **SMS OTP via Bonga (`src/sms/`)** — `SMS_ENABLED=0` by default (the OTP is logged to the server console; fine locally, useless for real visitors). Production sign-ups need `SMS_ENABLED=1` + `BONGA_API_CLIENT_ID`/`BONGA_API_KEY`/`BONGA_API_SECRET` (missing creds fail closed). ⚠ Bonga's vendor **send** endpoint is plain HTTP — credentials + recipient + message travel unencrypted; route `BONGA_API_URL_SEND` through an HTTPS proxy you control (one-time boot warning otherwise). **Live-verify the wire format on first prod send** (MSISDN + urlencoded vs multipart — `docs/sms-bonga-integration.md`).
- **In-app admin panel + dynamic settings.** An admin-**session** (SPA avatar menu → Admin) edits a curated catalog of operational knobs (`SAFE_*`, refresh cadences, `SMS_ENABLED`, …) live from the browser — no `.env` edit/Restart for the `live:true` ones. The legacy `ADMIN_TOKEN` bearer still works on the traffic dashboard + settings API (transitional dual-auth); the data-viz lab is admin-session-only.
- **Cross-device prefs sync**: signed-in users' UI settings (`oddspro.*` localStorage) sync last-write-wins via `/api/prefs` — pull on login, push on logout + a 2-min interval + a manual "Sync settings" row.
- **Response caching on the heavy read endpoints** (`/api/records`, `/api/columns`): server-side memo keyed on the auto-refresh `data_version` + gzip + ETag/304 (cold 887ms → warm 68ms; 916 KB → 106 KB on the wire). No config; guest and full tiers cache separately by construction.
- **Auth housekeeping runs itself**: expired sessions/OTP rows purge in the 10-min light pass; login/signup PIN hashing is async (no event-loop stall); OTP sends no longer hold the HTTP response past ~8s (late SMS failures are logged server-side).
- New `.env` knobs (see `.env.example` / `.env.production.example`): `AUTH_ENABLED`, `PIN_PEPPER`, `ADMIN_SEED_PIN`, `SESSION_TTL_DAYS`, `PIN_MAX_ATTEMPTS`, `PIN_LOCKOUT_MINUTES`; `SMS_ENABLED`, `SMS_DEFAULT_REGION`, `BONGA_API_*`, `BONGA_SERVICE_ID`, `OTP_TTL_MINUTES`, `OTP_LENGTH`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_BASE_SECONDS`, `OTP_MAX_RESENDS`; Safe stats-sufficiency `SAFE_MIN_SAMPLES`/`SAFE_MIN_H2H`.

## What's new in v1.0.1 (deployment-relevant)

- **In-process auto-refresh scheduler** (`src/auto-refresh.js`, runs inside the always-on server): a LIGHT pass every `AUTO_LIGHT_MINUTES` (default 10 — settles scores/outcomes, refreshes today's odds, links, settles picks) and the FULL pipeline once daily at `AUTO_FULL_AT` (default 06:00 EAT, `AUTO_FULL_DAYS` ahead, default 5). **The daily cron job is now an optional backup**, not the primary schedule (§3 step 10).
- **Per-job log** `logs/auto-refresh.log`, toggleable (`AUTO_LOG`) and **self-truncating** at `AUTO_LOG_MAX_KB` (default 256 KB) — no rotation needed on the host.
- **Manual refresh cache reuse**: `POST /api/refresh` for a date already refreshed within `REFRESH_CACHE_MINUTES` (default 5) answers `200 {fresh:true}` without re-running; the web app shows "Already fresh" and just reloads.
- **Connected browsers pick up refreshes silently**: the web app polls `GET /api/refresh` (now carrying `data_version`/`last_success`) every 60s and reloads the table in place — scroll, sort and filters preserved.
- **New DB migration** `20260709000001_fixtures_elapsed` (`fixtures.elapsed` — live match minute, shown in the Status tooltip). Apply it on deploy (§5, Migrations).
- **UI**: the footer is now a bottom-sticky status bar (record count, day hit-rates, last-refresh time).
- **Deadlock-resilient refreshes + the "only one `serve`" rule.** Manual/auto refreshes now retry transient InnoDB deadlocks / lock-wait timeouts (`src/db/retry-rules.js`, wrapping the fixtures/teams/leagues + per-match odds writers) and surface a friendly "please try again" instead of a raw SQL error banner. **Run exactly ONE `serve` process.** The deadlocks come from a *second* concurrent writer on the same rows — a stray `serve`, a manual CLI sweep, or a backup cron overlapping the in-process scheduler; the retry self-heals a rare race, but two always-on writers will fight (see §7, connection-pool + Passenger notes).
- **Boot-time migrations (opt-in, `MIGRATE_ON_BOOT`).** The server can self-apply `knex migrate:latest` on startup — set `MIGRATE_ON_BOOT=1` and a Restart runs any pending migrations (fail-fast: it won't serve on a migration error). This is the no-SSH-friendly alternative to the phpMyAdmin SQL recipe in §5. Off by default (local/dev restarts never migrate).
- **Bot protection (opt-in).** A known-bot user-agent blocklist and an AI-crawler `robots.txt`. Off by default. **See the new §8 for the full config.** (The proof-of-work human gate that also shipped in v1.0.1 was **removed 2026-07-16** — see §8.1.)
- **Client-side kickoff link-disable.** A match's bookmaker link auto-disables once its kickoff passes on the viewer's clock (many books drop the pre-match link at kickoff). Presentation-only; no config.
- **Prediction methodology hidden in the UI** (guarded for a future premium tier): the tip popover shows a lean bet-decision card with the blend/weights/gate internals behind a `SHOW_INTERNALS=false` code flag. **NOTE for the premium phase:** the raw `tip_breakdown` / `hot_signals` / AI-review fields are STILL in the `/api/records` payload (visible in devtools) — gate them server-side when premium lands for true secrecy.
- New `.env` knobs (all optional, sane defaults): `AUTO_REFRESH_ENABLED`, `AUTO_LIGHT_MINUTES`, `AUTO_FULL_AT`, `AUTO_FULL_DAYS`, `AUTO_LOG`, `AUTO_LOG_MAX_KB`, `REFRESH_CACHE_MINUTES`; `MIGRATE_ON_BOOT`; bot-protection `BOT_UA_FILTER_ENABLED`, `BOT_UA_EXTRA`, `BOT_UA_ALLOW`. (The `HUMAN_*` / `VITE_HUMAN_POW` knobs were removed 2026-07-16 — §8.1.)

## 1. Overview

- **Two branches, no `deploy` branch.** `dev` is where development happens; `main` is the stable/production-ready line (merge `dev` → `main` when ready). You deploy by building **whichever branch you're shipping** locally and uploading the result — there is no separate release/promote branch.
- **Two upload archives, split by role** (produced by `npm run package:deploy`, see §3):
  - **Backend → the Node app's Application Root** (e.g. `oddspro-app`): `oddspro-app_<ts>.zip` — the tracked source tree minus `web/` (no `node_modules`, `.env`, or `web/dist`). This is the Passenger/Node app that serves `/api/*`.
  - **Frontend → `public_html`**: `oddspro-web_<ts>.zip` — the built `web/dist` **contents** (index.html, `assets/`, favicons) at the zip root. Apache/LiteSpeed serves these statically; requests that don't match a static file fall through to the Node app (so `/api/*` reaches Passenger).
- **The frontend is always prebuilt locally.** `npm run build:web` produces `web/dist` (gitignored). **The shared host never runs Vite/Tailwind** — it only runs Node.
- **Manual upload is the deploy mechanism** (cPanel File Manager → Upload → Extract). Git history on `dev`/`main` is your rollback reference; keep the last-known-good zips for a fast revert.
- **`scripts/package-deploy.js`** (`npm run package:deploy`) builds both zips into `release/` (gitignored). Dependency-free: the backend zip is `git archive` of HEAD (commit first — uncommitted edits aren't included, and it warns you); the frontend zip is your freshly-built `web/dist`.
- **`scripts/db-export.js`** dumps the local MySQL/MariaDB database (gzip, no `CREATE DATABASE`) for a one-time phpMyAdmin import on the new host.
- **`scripts/pipeline-cron.sh`** is the Linux/cPanel equivalent of `scripts/pipeline-task.cmd`, with a `flock` overlap guard cron jobs need.

## 2. Prerequisites

- [ ] cPanel **Setup Node.js App** offering Node **≥ 18** (prefer 20/22 — Express 5 and zod 4 need a modern runtime).
- [ ] **Cron Jobs**, **phpMyAdmin**, and **File Manager** available (all standard).
- [ ] A local build toolchain (Node + npm) to run `npm run build:web` before each deploy.

## 3. One-time initial setup

Do these **in order**:

1. **MySQL**: cPanel → MySQL® Databases → create a database and user (cPanel prefixes both with your account name, e.g. `cpaneluser_oddspro` / `cpaneluser_dbuser`). Grant the user all privileges on the database. Note the exact prefixed names.
2. **Export the local DB**: `node scripts/db-export.js` → writes `backups/oddspro_<timestamp>.sql.gz` (gitignored).
3. **Import**: cPanel → phpMyAdmin → select the new database → Import → upload the `.gz` (imported natively, no manual decompression). This carries the full schema **and** the populated `knex_migrations` table, so no migrations are needed on first boot.
4. **Build + package locally**: set any branding/token vars in your local `.env` first (`VITE_GA_ID`, `VITE_APP_NAME`, `VITE_DEMO_VIDEO_URL`, and `VITE_API_TOKEN` if you plan to use `API_TOKEN` — see §6), then:
   ```sh
   npm test          # optional but recommended
   npm run build:web # produces web/dist with your VITE_* baked in
   npm run package:deploy   # -> release/oddspro-app_<ts>.zip + release/oddspro-web_<ts>.zip
   ```
   (Commit first — the backend zip is built from HEAD and the script warns on uncommitted tracked changes.)
5. **Create the Node app**: cPanel → Setup Node.js App → Create:
   - Node.js version: highest available ≥ 18 (prefer 20/22).
   - Application mode: **Production**.
   - Application root: a directory (Passenger's app root — e.g. `oddspro-app`, outside `public_html`).
   - Application URL: the domain/subdomain root — **no subpath** (`web/dist`'s asset URLs are root-absolute; `vite.config.js` sets no `base`).
   - Application startup file: `src/server.js`.
6. **Upload the two archives** via cPanel File Manager (Upload → then Extract in place):
   - `oddspro-app_<ts>.zip` → the **Application Root** (`oddspro-app`).
   - `oddspro-web_<ts>.zip` → **`public_html`**.
7. **Create `.env`**: via File Manager, in the **Application Root**, from `.env.example`:
   - `DB_*`: the cPanel-prefixed MySQL creds from step 1.
   - `X_APISPORTS_KEY` (and any other keys you use locally, e.g. `GEMINI_API_KEY`).
   - `DB_POOL_MAX`: start conservative, e.g. `3` (see §6).
   - `API_TOKEN`: optional (see §6) — if set, it must match the `VITE_API_TOKEN` you built with in step 4.
   - Leave `API_HOST` and `DEBUG` at their defaults (see §6).
   - Auto-refresh: the defaults (light every 10 min, full daily 06:00 EAT) are production-ready; set `AUTO_REFRESH_ENABLED=0` only if you want cron-only scheduling.
8. **Run NPM Install**: click **"Run NPM Install"** in the Setup Node.js App UI (installs production dependencies into the app's `nodevenv`).
9. **Restart** the app via the Setup Node.js App UI, then smoke-test (§5's checklist).
10. **Cron Jobs (optional backup since v1.0.1)**: the in-process scheduler (§ What's new) already runs the light pass every 10 minutes and the full pipeline daily at `AUTO_FULL_AT` — a cron entry is only a **safety net** for the case where the host spins the idle Node app down (see §6, Passenger residency). If you keep one:
    - Schedule it **at least 1 hour away from `AUTO_FULL_AT`**. Cron runs in a *separate process* the server's single-slot job guard cannot see — two concurrent sweeps risk the InnoDB delete+insert gap-lock deadlocks the in-process guard exists to prevent.
    - First confirm the server timezone — with no SSH, temporarily add a cron entry `date >> logs/tz-check.log` a minute out, read it via File Manager, then delete that test entry. Convert the chosen EAT time (UTC+3) to the server timezone. Then add:
    ```
    bash /home/<CPANEL_USER>/<APP_DIR>/scripts/pipeline-cron.sh
    ```

## 4. Ongoing deploys (manual)

For any future change:

1. Locally: commit to `dev` (or `main`), then `npm test && npm run build:web && npm run package:deploy`.
2. Upload + Extract via File Manager, overwriting: `oddspro-app_<ts>.zip` → Application Root, `oddspro-web_<ts>.zip` → `public_html`. (If only the frontend changed, you can upload just the web zip; if only backend, just the app zip.)
3. If `package.json` dependencies changed: **"Run NPM Install"** again. If a migration was added: apply it (see §5, Migrations).
4. **Restart** the app via the Setup Node.js App UI.
5. Smoke-test (§5).

## 5. Verifying, migrations, rollback

**Smoke-test after each deploy:**
- `/` loads the SPA shell (correct title, favicon, and — on a prod build — the GA tag in view-source).
- `GET /api/columns` returns JSON.
- `GET /api/refresh` returns the job state with `data_version`; within ~`AUTO_LIGHT_MINUTES` of the restart, `logs/auto-refresh.log` shows a `light ok` line and the status bar's ⟳ time updates.
- If a backup cron is kept: `logs/pipeline.log` shows its next tick landed cleanly.
- The Setup Node.js App log shows no startup errors.

**Migrations (no SSH):** the initial phpMyAdmin import already carries the schema, so first boot applies **zero** migrations. When you add a new migration later, apply it without SSH by either (a) setting `MIGRATE_ON_BOOT=1` in `.env` and **Restart**ing the app — the server runs `knex migrate:latest` on boot and only serves once the schema is current (fail-fast on error; the cleanest no-SSH option, new in v1.0.1), (b) running `npm run migrate` from the Setup Node.js App UI's script runner if your cPanel version exposes one, or (c) translating the migration and running its SQL in phpMyAdmin **plus inserting its bookkeeping row** so a future `npm run migrate` doesn't try to re-apply it. Migrations are forward-only — always test locally (`npm run migrate` against a scratch DB) before deploying. (With `MIGRATE_ON_BOOT=1` you can leave it on permanently: an already-current schema is a no-op.)

⚠ **M3 ordering (batch 12, `20260715000001_tip_market_v2`):** widens `tip_market` to `VARCHAR(32)` and `tip_outcome` to `ENUM('hit','miss','void')`. This migration **MUST apply before the M3 code's first write** — `MIGRATE_ON_BOOT=1` already guarantees that ordering (schema-then-listen). A code-first deploy (new app code against the old schema) would silently truncate long team-total keys (`'TT:H:O 1.5'`) to the old `VARCHAR(8)` and reject/coerce a `'void'` DNB-push outcome against the old two-value enum.

For the v1.0.1 migration specifically, option (b) is:
```sql
ALTER TABLE fixtures ADD COLUMN elapsed SMALLINT UNSIGNED NULL;
INSERT INTO knex_migrations (name, batch, migration_time)
VALUES ('20260709000001_fixtures_elapsed.js',
        (SELECT b FROM (SELECT MAX(batch) + 1 AS b FROM knex_migrations) t), NOW());
```

**Rollback:** keep the previous known-good `release/` zips (both the `-app` and `-web` archives); re-extract them into the Application Root / `public_html` and restart. The corresponding commit on `dev`/`main` is the source-of-truth to rebuild from if you no longer have the zips.

## 6. Troubleshooting / risk appendix

- **Connection-pool sizing.** Since v1.0.1 the scheduled refreshes run *inside* the server process — one knex pool total in the default setup. Only a kept backup cron (`npm run start`) adds a second process/pool while it runs (worst case ~2×`DB_POOL_MAX`). Shared MySQL hosting caps per-account connections; if you see too-many-connections errors, lower `DB_POOL_MAX` in `.env` (e.g. `3`).
- **Passenger residency (scheduler prerequisite).** The in-process scheduler only ticks while the Node app is alive. Passenger *can* spin idle apps down on some hosts — verify yours keeps it resident: after >15 idle minutes, check `logs/auto-refresh.log` still gained `light ok` lines. If the app sleeps, either rely on the visitor traffic + slow client polls to keep it warm, keep the backup cron (§3 step 10), or ask the host to mark the app always-running.
- **`REFRESH_CACHE_MINUTES`.** Manual refresh of a date successfully refreshed within this window (default 5m, any mode — scheduled runs count) answers `200 {fresh:true}` and starts nothing, so button-mashing right after an auto run costs zero scrapes.
- **Timezone.** The cron schedule (server system timezone, likely UTC) and the DB session's `SET time_zone = '+03:00'` pin (every knex connection, `knexfile.js`) are **independent**. The pin governs how stored EAT wall-clock datetimes compare against `NOW()`; the cron schedule only governs when the job fires.
- **Why `API_HOST` stays `127.0.0.1`.** Passenger reverse-proxies your domain to the app over loopback — `0.0.0.0` isn't required and is worse practice on shared multi-tenant hosting. Only change it if Passenger's logs show connection-refused.
- **`API_TOKEN` tradeoff.** Once public, `POST /api/refresh` has no access control beyond an easily-spoofed header — anyone with the URL could trigger live scrapes/API-Football calls. Setting `API_TOKEN` requires `Authorization: Bearer <token>` on all `/api/*`; `web/src/api.js` sends it automatically **when the frontend was built with a matching `VITE_API_TOKEN`** (set it in your local `.env` before `npm run build:web` — they must be identical, and the token is visible in the browser network tab, so it's a deterrent, not real auth). A no-code alternative: cPanel's "Directory Privacy" (Basic Auth on the whole app).
- **`REFRESH_COOLDOWN_MINUTES`.** Per-date: refreshing a date locks that date for the window (default 60m, `0` disables); other dates are unaffected. A cooled-down request returns `429` with a retry time.
- **MariaDB → MySQL dump portability.** The schema (`src/db/migrations/`) uses only standard tables, JSON columns and indexes — no generated/virtual columns, `CHECK` constraints, or sequences — all portable to MySQL 5.7+/8.0 or MariaDB 10.2+. If phpMyAdmin's import complains about an unrecognized directive, it's likely a stray `/*M!...*/` MariaDB-conditional comment — safe to strip.
- **Lockfiles are gitignored** (`package-lock.json`, root and `web/`) — the server's `npm install` guarantees only semver-range compatibility with what you tested locally. Most runtime deps (`express`, `knex`, `mysql2`, `zod`, `dotenv`) are exact-pinned; only `axios` (`^1.7.2`) floats, so the blast radius is small.
- **`logs/` growth.** `logs/auto-refresh.log` self-truncates at `AUTO_LOG_MAX_KB` (default 256 KB) — no maintenance needed. `logs/pipeline.log` (backup cron only) still grows unbounded; if you keep the cron, periodically clear it via File Manager.
- **Passenger restart.** If the app serves stale code after an upload, use the Setup Node.js App UI's **Restart** button (Passenger's `tmp/restart.txt` convention).

## 7. Later: CI/CD (when SSH lands)

This manual flow is deliberately dependency-free. If the host later gains SSH (or you move to a VPS), the natural next step is to automate the build-and-upload — e.g. a small deploy script or a CI job that runs `npm test` + `npm run build:web` and rsyncs the tree, or a Git-based pull with a post-receive/`.cpanel.yml` build hook. Not needed today; captured here so the manual steps above aren't mistaken for the permanent design.

## 8. Bot protection (opt-in, new in v1.0.1)

A user-agent blocklist plus an AI `robots.txt` keep bots and AI scrapers off the public site. **OFF by default** — local dev and an un-gated deploy behave exactly as before. Enable it for production via the server `.env`. No third-party service, account, or API keys.

### 8.1 Proof-of-work "verify you're human" gate — REMOVED 2026-07-16

This gate (`HUMAN_POW_ENABLED`, `VITE_HUMAN_POW`, `HUMAN_TOKEN_SECRET`, `HUMAN_POW_BITS`, `HUMAN_TOKEN_TTL_DAYS`, `HUMAN_CHALLENGE_TTL_MINUTES`, the `/api/challenge` + `/api/human` routes, and the SPA `HumanGate`) was **deprecated and removed** as irrelevant at this stage.

**What this means for a deploy:**

- **Drop every `HUMAN_*` / `VITE_HUMAN_POW` line** from a real `.env` / `.env.production`. They are now ignored (the config schema strips unknown keys), so a leftover line is harmless — but it is dead weight and misleading.
- The gate was opt-in and off by default, so removal is a **no-op for behaviour**.
- **The "#1 deploy gotcha" is gone with it** — there is no longer a switch that has to be kept equal across the server `.env` and the web build, and no way to ship a site where every `/api/*` call returns `401 {human_required:true}`.
- The UA blocklist + `robots.txt` below are a **separate feature and remain in force**. `API_TOKEN` (§7) is unaffected.

### 8.2 Bot user-agent blocklist + AI `robots.txt`

- `BOT_UA_FILTER_ENABLED=1` returns `403` **site-wide, before any route** to known AI scrapers (GPTBot, ClaudeBot, CCBot, PerplexityBot, Bytespider, Google-Extended, …), aggressive SEO crawlers (AhrefsBot, SemrushBot, …), and raw HTTP clients / headless automation (`curl`, `wget`, `python-requests`, `scrapy`, HeadlessChrome, …). General search engines (Googlebot, Bingbot) are deliberately **not** blocked, so landing-page SEO is unaffected.
- Tune the list without a code change: `BOT_UA_EXTRA` = comma-separated UA substrings to *also* block; `BOT_UA_ALLOW` = substrings to exempt (wins over the built-in list).
- `GET /robots.txt` is **always served** (no flag needed) and disallows the same AI crawlers plus `/api/` — the polite signal for bots that honor it; the UA blocklist above catches the ones that don't.

### 8.3 Verifying after you enable it

- Load `/` in a browser → a brief "Verifying you're human" screen → the app. Reload → **no** gate (check-once token in localStorage). 
- `GET /api/records` with no `X-Human-Token` → `401 {human_required:true}`; the SPA attaches the token automatically once verified.
- `curl -A 'GPTBot' https://<domain>/` → `403`; a real browser UA → `200`.
- `GET /robots.txt` lists the AI `Disallow` rules.
