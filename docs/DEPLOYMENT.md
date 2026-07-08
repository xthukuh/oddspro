# cPanel Shared-Hosting Deployment (manual)

Deploying oddspro to a shared cPanel host with **no SSH/terminal access** — only Setup Node.js App, Cron Jobs, File Manager, and phpMyAdmin. This is the **manual-first** workflow: build locally, upload the built files. No Git Version Control, no `deploy` branch, no build step on the server. (CI/CD can come later when the host gains SSH — see §7.)

## 1. Overview

- **Two branches, no `deploy` branch.** `dev` is where development happens; `main` is the stable/production-ready line (merge `dev` → `main` when ready). You deploy by building **whichever branch you're shipping** locally and uploading the result — there is no separate release/promote branch.
- **The frontend is always prebuilt locally.** `npm run build:web` produces `web/dist` (gitignored); `src/server.js` serves it. **The shared host never runs Vite/Tailwind** — it only runs Node.
- **Manual upload is the deploy mechanism.** You upload the project tree (source + prebuilt `web/dist`) into the Node app's Application Root via File Manager (or FTP). Git history on `dev`/`main` is your rollback reference; keep a zip of the last-known-good upload for a fast revert.
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
4. **Build the frontend locally**: set any branding/token vars in your local `.env` first (`VITE_GA_ID`, `VITE_APP_NAME`, and `VITE_API_TOKEN` if you plan to use `API_TOKEN` — see §6), then run `npm test` and `npm run build:web`. Confirm `web/dist/index.html` exists and (for a prod build) contains your title/GA/favicon links.
5. **Create the Node app**: cPanel → Setup Node.js App → Create:
   - Node.js version: highest available ≥ 18 (prefer 20/22).
   - Application mode: **Production**.
   - Application root: a directory (Passenger's app root — e.g. `oddspro-app`, outside `public_html` unless your host requires otherwise).
   - Application URL: the domain/subdomain root — **no subpath** (`web/dist`'s asset URLs are root-absolute; `vite.config.js` sets no `base`).
   - Application startup file: `src/server.js`.
6. **Upload the project**: locally, zip the repo tree **excluding** `node_modules/`, `.git/`, `.env`, `tmp/`, `logs/`, `backups/`, and **including** the freshly-built `web/dist/`. Upload the zip into the Application Root via File Manager and Extract (or push the same files over FTP).
7. **Create `.env`**: via File Manager, in the Application Root, from `.env.example`:
   - `DB_*`: the cPanel-prefixed MySQL creds from step 1.
   - `X_APISPORTS_KEY` (and any other keys you use locally, e.g. `GEMINI_API_KEY`).
   - `DB_POOL_MAX`: start conservative, e.g. `3` (see §6).
   - `API_TOKEN`: optional (see §6) — if set, it must match the `VITE_API_TOKEN` you built with in step 4.
   - Leave `API_HOST` and `DEBUG` at their defaults (see §6).
8. **Run NPM Install**: click **"Run NPM Install"** in the Setup Node.js App UI (installs production dependencies into the app's `nodevenv`).
9. **Restart** the app via the Setup Node.js App UI, then smoke-test (§5's checklist).
10. **Cron Jobs**: first confirm the server timezone — with no SSH, temporarily add a cron entry `date >> logs/tz-check.log` a minute out, read it via File Manager, then delete that test entry. Convert 08:00 EAT (UTC+3) to the server timezone (05:00 if UTC). Add the real entry, daily at the converted time:
    ```
    bash /home/<CPANEL_USER>/<APP_DIR>/scripts/pipeline-cron.sh
    ```

## 4. Ongoing deploys (manual)

For any future change:

1. Locally: commit to `dev` (or `main`), run `npm test`, then `npm run build:web`.
2. Upload the changed files into the Application Root via File Manager, overwriting — at minimum the rebuilt `web/dist/`, plus any changed `src/` / `knexfile.js` / `package.json`. (A full re-zip-and-extract of the same exclusion set from §3.6 is the simplest, foolproof option.)
3. If `package.json` dependencies changed: **"Run NPM Install"** again. If a migration was added: apply it (see §5, Migrations).
4. **Restart** the app via the Setup Node.js App UI.
5. Smoke-test (§5).

## 5. Verifying, migrations, rollback

**Smoke-test after each deploy:**
- `/` loads the SPA shell (correct title, favicon, and — on a prod build — the GA tag in view-source).
- `GET /api/columns` returns JSON.
- `logs/pipeline.log` shows the next cron tick landed cleanly.
- The Setup Node.js App log shows no startup errors.

**Migrations (no SSH):** the initial phpMyAdmin import already carries the schema, so first boot applies **zero** migrations. When you add a new migration later, apply it without SSH by either (a) running `npm run migrate` from the Setup Node.js App UI's script runner if your cPanel version exposes one, or (b) translating the migration and running its SQL in phpMyAdmin. Migrations are forward-only — always test locally (`npm run migrate` against a scratch DB) before deploying.

**Rollback:** keep the previous known-good upload zip; re-extract it into the Application Root and restart. The corresponding commit on `dev`/`main` is the source-of-truth to rebuild from if you no longer have the zip.

## 6. Troubleshooting / risk appendix

- **Connection-pool sizing.** The cron pipeline (`npm run start`) and the always-on server (`npm run serve`/`src/server.js`) are *separate processes*, each with its own knex pool (`DB_POOL_MAX`, default 10 each — worst case ~20 connections). Shared MySQL hosting caps per-account connections; if you see too-many-connections errors, lower `DB_POOL_MAX` in `.env` (e.g. `3`).
- **Timezone.** The cron schedule (server system timezone, likely UTC) and the DB session's `SET time_zone = '+03:00'` pin (every knex connection, `knexfile.js`) are **independent**. The pin governs how stored EAT wall-clock datetimes compare against `NOW()`; the cron schedule only governs when the job fires.
- **Why `API_HOST` stays `127.0.0.1`.** Passenger reverse-proxies your domain to the app over loopback — `0.0.0.0` isn't required and is worse practice on shared multi-tenant hosting. Only change it if Passenger's logs show connection-refused.
- **`API_TOKEN` tradeoff.** Once public, `POST /api/refresh` has no access control beyond an easily-spoofed header — anyone with the URL could trigger live scrapes/API-Football calls. Setting `API_TOKEN` requires `Authorization: Bearer <token>` on all `/api/*`; `web/src/api.js` sends it automatically **when the frontend was built with a matching `VITE_API_TOKEN`** (set it in your local `.env` before `npm run build:web` — they must be identical, and the token is visible in the browser network tab, so it's a deterrent, not real auth). A no-code alternative: cPanel's "Directory Privacy" (Basic Auth on the whole app).
- **`REFRESH_COOLDOWN_MINUTES`.** Per-date: refreshing a date locks that date for the window (default 60m, `0` disables); other dates are unaffected. A cooled-down request returns `429` with a retry time.
- **MariaDB → MySQL dump portability.** The schema (`src/db/migrations/`) uses only standard tables, JSON columns and indexes — no generated/virtual columns, `CHECK` constraints, or sequences — all portable to MySQL 5.7+/8.0 or MariaDB 10.2+. If phpMyAdmin's import complains about an unrecognized directive, it's likely a stray `/*M!...*/` MariaDB-conditional comment — safe to strip.
- **Lockfiles are gitignored** (`package-lock.json`, root and `web/`) — the server's `npm install` guarantees only semver-range compatibility with what you tested locally. Most runtime deps (`express`, `knex`, `mysql2`, `zod`, `dotenv`) are exact-pinned; only `axios` (`^1.7.2`) floats, so the blast radius is small.
- **Unbounded `logs/` growth.** No log rotation exists. Shared hosting often has tight disk quotas; periodically clear old `logs/pipeline.log` entries via File Manager.
- **Passenger restart.** If the app serves stale code after an upload, use the Setup Node.js App UI's **Restart** button (Passenger's `tmp/restart.txt` convention).

## 7. Later: CI/CD (when SSH lands)

This manual flow is deliberately dependency-free. If the host later gains SSH (or you move to a VPS), the natural next step is to automate the build-and-upload — e.g. a small deploy script or a CI job that runs `npm test` + `npm run build:web` and rsyncs the tree, or a Git-based pull with a post-receive/`.cpanel.yml` build hook. Not needed today; captured here so the manual steps above aren't mistaken for the permanent design.
