# cPanel Shared-Hosting Deployment

Deploying oddspro to a shared cPanel host via cPanel's **Setup Node.js App** tool, with **no SSH/terminal access** — only the Setup Node.js App UI, Cron Jobs, Git™ Version Control, File Manager, and phpMyAdmin.

## 1. Overview

- **Three-branch model.** `dev` is where ongoing development happens; `main` is reserved for production-ready releases (merge `dev` → `main` when ready to ship); `deploy` (see below) is the built artifact `scripts/release.js` produces FROM `main` and the only branch cPanel's Git Version Control ever pulls. `scripts/release.js` defaults to sourcing from `main` (`--branch <name>` overrides) — run it after merging `dev` → `main`, not directly from `dev`.
- **Single-directory git model.** cPanel's Git Version Control "Repository Path" is the same directory as the Node app's "Application Root" — no separate staging/promote directory. Git history is the rollback mechanism.
- **A dedicated `deploy` branch** (not `main`) is what cPanel pulls. `main` stays the normal dev branch, exactly as today (`web/dist` gitignored). `deploy` is release-snapshot-only — `main`'s tracked tree plus a freshly-built `web/dist` — produced by `node scripts/release.js`. **The server never runs Vite/Tailwind on the shared host**; the frontend always ships prebuilt.
- **`.cpanel.yml`** (repo root) drives the "Deploy HEAD Commit" button: creates runtime dirs, `npm install --omit=dev`, `npm run migrate`, touches `tmp/restart.txt` (Passenger's restart convention).
- **`scripts/pipeline-cron.sh`** is the Linux/cPanel equivalent of `scripts/pipeline-task.cmd`, with a `flock` overlap guard cron jobs need but Windows Task Scheduler doesn't.
- **`scripts/db-export.js`** dumps the local Docker MySQL database (gzip, no `CREATE DATABASE`) for a one-time phpMyAdmin import on the new host.

## 2. Prerequisites / go-no-go checklist

- [ ] **Rotate the GitHub PAT embedded in `origin`'s remote URL** (`git remote -v`). This is a hard blocker — do it before anything below touches `origin`. Issue a *new*, purpose-scoped credential (ideally an SSH deploy key, or a fine-scoped PAT) for cPanel's Git Version Control auth. Never reuse the leaked one, even rotated.
- [ ] Confirm cPanel's **Setup Node.js App** offers Node **≥ 18** (prefer 20/22 — Express 5 and zod 4 need a reasonably modern runtime). If only an older version is available, stop and re-evaluate before going further.
- [ ] Confirm the plan has **Git™ Version Control**, **Cron Jobs**, and **Setup Node.js App** (already confirmed available for this account).
- [ ] Note: the local export produced a ~37MB dump (see §3) — comfortably under typical phpMyAdmin upload limits today, but re-check `upload_max_filesize`/`post_max_size` if it grows.

## 3. One-time initial setup

Do these **in order**:

1. **Rotate the PAT** (see §2). Create a new credential for cPanel's Git Version Control — SSH deploy key preferred, otherwise a fine-scoped PAT.
2. **MySQL**: in cPanel → MySQL® Databases, create a database and user (cPanel prefixes both with your username, e.g. `cpaneluser_oddspro` / `cpaneluser_dbuser`). Note the exact prefixed names.
3. **Export the local DB**: `node scripts/db-export.js` → writes `backups/oddspro_<timestamp>.sql.gz` (gitignored). Transfer it to the server (upload via phpMyAdmin's import UI directly, or File Manager first).
4. **Import**: cPanel → phpMyAdmin → select the new database → Import → upload the `.gz` (imported natively, no manual decompression needed).
5. **Create the Node app**: cPanel → Setup Node.js App → Create:
   - Node.js version: highest available ≥ 18 (prefer 20/22).
   - Application mode: Production.
   - Application root: pick a directory (this becomes both the git Repository Path and Passenger's app root — e.g. `oddspro-app`, **outside** `public_html` unless your host requires otherwise).
   - Application URL: the domain/subdomain this will serve. **Must be the domain/subdomain root — no subpath** (`web/dist`'s asset URLs are root-absolute, `vite.config.js` has no `base` override).
   - Application startup file: `src/server.js`.
   - **Note the exact `nodevenv` activation path shown on this page** (e.g. `/home/cpaneluser/nodevenv/oddspro-app/20/bin/activate`) — you'll paste it into two files next.
6. **Seed the `deploy` branch**: locally, run `node scripts/release.js` (no `--no-push`) once, from a clean `main` checkout. This pushes the first `deploy` snapshot to `origin` so cPanel has something to clone.
7. **Git Version Control**: cPanel → Git™ Version Control → Create → clone from `origin` (using the new credential from step 1), branch `deploy`, **Repository Path = the same Application Root from step 5**.
8. **Fill in the placeholders**: locally, edit `.cpanel.yml` and `scripts/pipeline-cron.sh`, replacing `<CPANEL_USER>`/`<APP_DIR>`/`<NODE_VERSION>` with the exact values noted in step 5. Commit on `main`, then run `node scripts/release.js` again to carry the change onto `deploy` and push.
9. **cPanel Git UI**: click "Update from Remote" then "Deploy HEAD Commit" to pull this first real snapshot and run the `.cpanel.yml` tasks (installs prod deps, runs migrations — should be a no-op against the imported dump, see §6 — and touches the restart marker).
10. **Create `.env`**: via File Manager, in the Application Root, based on `.env.example`:
    - `DB_*`: the cPanel-prefixed MySQL creds from step 2.
    - `X_APISPORTS_KEY` and any other keys you use locally.
    - `DB_POOL_MAX`: start conservative, e.g. `3` (see §6 — the cron pipeline and the always-on server are separate processes with separate pools, and shared hosts cap per-account MySQL connections).
    - `API_TOKEN`: optional — set a random string if you want `/api/*` to require it (see §6). If set, also rebuild locally with it baked in (handled automatically by `scripts/release.js`, which mirrors `API_TOKEN` into the frontend build as `VITE_API_TOKEN`).
    - `REFRESH_COOLDOWN_MINUTES`: defaults to `60` (blocks re-clicking Refresh on the same date within an hour of its last run) — adjust or set `0` to disable.
    - Leave `API_HOST` and `DEBUG` at their defaults (see §6).
11. Click **"Run NPM Install"** once in the Setup Node.js App UI (belt-and-suspenders alongside `.cpanel.yml`'s own install task).
12. **Cron Jobs**: first confirm the server's actual timezone — there's no SSH to just run `date`, so temporarily add a cron entry running `date >> logs/tz-check.log` a minute or two out, check the file via File Manager, then delete that test entry. Convert 08:00 EAT (UTC+3) to the server's timezone (05:00 if it's UTC, which is typical). Add the real entry:
    ```
    bash /home/<CPANEL_USER>/<APP_DIR>/scripts/pipeline-cron.sh
    ```
    scheduled daily at the converted time.

## 4. Ongoing incremental deploys

For any future change:

1. Commit to `main` as usual, locally.
2. `node scripts/release.js` — runs `npm test`, builds the frontend, snapshots `main` + fresh `web/dist` onto `deploy`, pushes. Prints "nothing changed" and exits cleanly if there's nothing new since the last release.
3. cPanel Git Version Control UI: **"Update from Remote"**, then **"Deploy HEAD Commit"**.
4. Smoke-test: `GET /api/columns` returns JSON, `/` loads the SPA shell, `logs/pipeline.log` shows the next cron tick landed, Setup Node.js App's own log has no startup errors.

## 5. Rollback

```sh
git reset --hard <previous-good-sha>   # on the deploy branch, locally
git push --force origin deploy         # the one sanctioned force-push in this workflow
```
Then redeploy via the cPanel UI as in §4. Database rollback is out of scope — migrations are forward-only; catch schema problems locally (`npm run migrate` against a scratch DB) before releasing.

## 6. Troubleshooting / risk appendix

- **Connection-pool sizing.** The cron pipeline (`npm run start`) and the always-on server (`npm run serve`) are *separate processes*, each with its own knex pool (`DB_POOL_MAX`, default 10 each — worst case ~20 connections from this one app). Shared MySQL hosting caps per-account connections; if you see connection-refused/too-many-connections errors, lower `DB_POOL_MAX` in `.env` (e.g. `3`).
- **Timezone**: the cron schedule (server's system timezone, likely UTC) and the DB session's `SET time_zone = '+03:00'` pin (every knex connection, `knexfile.js`) are **independent** — don't "fix" one thinking it affects the other. The pin is about how stored EAT wall-clock datetimes compare against `NOW()`; the cron schedule is purely about when the job fires.
- **Why `API_HOST` stays `127.0.0.1`.** Passenger reverse-proxies your domain to the app over loopback — `0.0.0.0` isn't required and is worse practice on shared multi-tenant hosting. Only change it if Passenger's logs show connection-refused.
- **`API_TOKEN` tradeoff.** Once public, `POST /api/refresh` has no real access control beyond an easily-spoofed header — anyone who finds the URL could trigger live scrapes/API-Football calls. Setting `API_TOKEN` requires `Authorization: Bearer <token>` on all `/api/*`; `web/src/api.js` sends it automatically when the frontend was built with `VITE_API_TOKEN` set (handled by `scripts/release.js`). The token is visible in the browser's network tab to anyone with the page open — this is a deterrent against opportunistic/automated hits, not a defense against a determined attacker. An alternative/complementary option requiring no code changes: cPanel's "Directory Privacy" (Basic Auth on the whole app).
- **`REFRESH_COOLDOWN_MINUTES`.** Per-date: refreshing 2026-07-08 locks that date for the configured window (default 60m, `0` disables), but other dates are unaffected. A cooled-down request gets `429` with a human-readable retry time; the existing single-slot lock (`refreshJob.running`, unrelated to this) still serializes actual concurrent runs regardless of date.
- **First-deploy migration no-op.** The imported dump already carries `knex_migrations`/`knex_migrations_lock` fully populated, so the first `npm run migrate` on the server (via `.cpanel.yml`) should apply **zero** new migrations. If it tries to apply migrations you didn't expect, stop and check the dump import completed fully before investigating further.
- **MariaDB → MySQL dump portability.** The local dump comes from MariaDB 11.7. The schema (`src/db/migrations/`) has no generated/virtual columns, `CHECK` constraints, or sequences — only standard tables, JSON columns and indexes, all portable to MySQL 5.7+/8.0 or MariaDB 10.2+. If phpMyAdmin's import ever complains about an unrecognized directive, it's likely a stray `/*M!...*/` MariaDB-conditional comment (auto-ignored by non-MariaDB servers, same idea as MySQL's own `/*!NNNNN ...*/` version comments) — safe to strip manually if needed.
- **Lockfiles are gitignored** (`package-lock.json`, both root and `web/`) — the server's `npm install --omit=dev` only guarantees semver-range compatibility with what was tested locally, not identical versions. Only `axios` (`^1.7.2`) isn't pinned exact among the runtime deps; the rest (`express`, `knex`, `mysql2`, `zod`, `dotenv`) are exact-pinned, so the blast radius is small.
- **Unbounded `logs/` growth.** No log rotation exists (pre-existing — Windows Task Scheduler doesn't have one either), and shared hosting often has tighter disk quotas than a dev machine. Periodically clear old entries from `logs/pipeline.log` via File Manager if disk usage becomes a concern.
- **Passenger restart.** `.cpanel.yml` touches `tmp/restart.txt` on every deploy (Passenger's standard convention). If the app still serves stale code after a deploy, use the Setup Node.js App UI's "Restart" button directly.

## Verification performed (local, before any real cPanel access)

- `npm test` — 161/161 passing after all config/knexfile/utils/pipeline/server changes.
- `PORT`/`API_PORT`, `DB_POOL_MIN/MAX`, `DEBUG` env var overrides confirmed via direct `node` smoke checks (defaults unchanged when unset, overrides take effect when set).
- `scripts/db-export.js` run twice against the real local `mariadb` container (auto-detect and explicit `--container mariadb`), output validated as well-formed gzip (`gzip -t`) and inspected (correct MariaDB dump header, target database `oddspro`); zero-match/wrong-container error path confirmed to fail with a clear message.
- `scripts/pipeline-cron.sh`'s `flock` overlap guard verified by racing two concurrent invocations of an equivalent stripped-down copy under WSL: the second run logged "SKIPPED" while the first held the lock, then proceeded normally once released.
- `scripts/release.js`'s clean-tree precondition verified live (correctly refused to run against an uncommitted working tree during development of this feature itself).
