# Admin Dashboard program — deployment notes (deployment-relevant deltas)

**Status: PREPARED, NOT RELEASABLE.** These notes cover everything on
`feature/admin-dashboard-improvements` as of `e656459` (M0–M9 + M13 + M14, suite 828/828).
**M10 (Database section), M11 (performance viz) and M12 (cleanup + E2E + merge) are not
started** — no version has been bumped and no tag exists. Nothing here ships until M12
merges to `main` and `npm run package:deploy` builds from there.

**When M12 lands:** fold §§1–6 below into `docs/DEPLOYMENT.md` as a
"What's new in v1.3.0 (deployment-relevant)" section (the existing v1.1.0 / v1.0.1 / detour
sections are the format), then delete this file. It exists so the deltas are captured while
they're fresh rather than reconstructed from 30 commits at release time.

---

## 0. ⚠ The compounding pre-flight risk (read first)

The live host at oddspro.ke **still runs the 2026-07-12 upload (pre-v1.1.0)**. It has never
run the v1.1.0, v1.2.0 or admin-program migrations. Deploying this branch therefore applies
**migration batches 9 through 19 in a single restart** — visitor analytics, geo, accounts,
settings, prefs, the catalog index, AI insights, tracking v2, consent, audit, email OTP and
campaigns, all at once.

Two consequences that are unrecoverable if missed:

1. **`PIN_PEPPER` must be in the host `.env` BEFORE that first restart.** Batch 11 seeds the
   admin user and hashes its PIN *at migrate time*, mixing in the pepper. Setting it
   afterwards invalidates that hash — and rotating it later invalidates every stored PIN for
   every user. Generate once, store it, never rotate casually:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
2. **`ADMIN_SEED_PIN` (exactly 4 digits, default `0000`) is the first-login credential.** The
   seeded admin is flagged `must_change_pin`, so the first sign-in forces a real PIN. Set it
   to something non-default before the restart if the host is publicly reachable.

Take a DB backup before the restart (`node scripts/db-export.js`, **mariadb-dump not
mysqldump**) — an 11-batch jump is not a step you want to reverse by hand.

## 1. New migrations (batches 15–19)

Applied automatically when `MIGRATE_ON_BOOT=1` + Restart (the no-SSH path, `DEPLOYMENT.md` §5).

| Batch | Migration | Adds |
|---|---|---|
| 15 | `20260719000001_visitor_tracking_v2` | normalized visitor/session/event tables (tracking v2) |
| 16 | `20260719000002_user_terms_consent` | terms-consent columns on `users` (signup gate) |
| 17 | `20260719000003_admin_audit` | `admin_audit` — every admin mutation is attributable and dated |
| 18 | `20260719000004_email_otp` | `users.email` (nullable, **NOT unique**), `otp_codes.channel`/`email` |
| 19 | `20260719000005_sms_templates_campaigns` | `users.sms_opt_out`, `sms_templates`, `sms_campaigns`, `sms_campaign_recipients` |

Forward-only, as always. Batch 19's `(campaign_id, user_id)` unique index is load-bearing —
it is what makes campaign ledger materialization idempotent.

## 2. New dependency + build-step change

- **`nodemailer` 9.0.3 (exact-pinned)** — first new runtime dependency since v1.2.0. The host
  must re-run **Run NPM Install** in Setup Node.js App after uploading the backend zip, or
  the mail seam throws on boot. `package-lock.json` is gitignored in this repo, so the
  version floor lives in `package.json` alone.
- **`npm run build:web` now runs `node scripts/gen-legal.js` first**, regenerating
  `web/public/{privacy,terms}/index.html` from the single `legalContent.js` source before
  vite builds. The outputs are committed, so the pages exist without a build — but if you
  build the frontend zip by invoking vite directly instead of via `build:web`, stale legal
  pages ship. Use the npm script.

## 3. New `.env` knobs

All optional with sane defaults **except** where noted. Add to `.env.example` /
`.env.production.example` in M12 (that rewrite is an M12 checklist item).

- **Mail (M13)** — `MAIL_MAILER` (**default `log` = prints emails to the server console and
  touches no network**; set `smtp` for real delivery), then the `.env`-ONLY credentials
  `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_ENCRYPTION`,
  `MAIL_SCHEME`, `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`. Fails **closed** when set to `smtp`
  with a missing host. The admin settings catalog deliberately exposes only the
  `MAIL_MAILER` switch — credentials never reach the settings table.
  ⚠ **Leaving `MAIL_MAILER=log` in production silently disables the email OTP fallback**:
  Forgot-PIN and delivery-failure recovery will appear to work while the code only ever
  reaches the server log. This is the one default that is right for dev and wrong for prod.
- **SMS campaigns (M9)** — `SMS_BATCH_SIZE` (20), `SMS_BATCH_DELAY_MS` (2000),
  `SMS_BREAKER_AFTER` (5 consecutive failures stop a run).
- **Maintenance (M14)** — `MAINTENANCE_SCHEDULED`, `MAINTENANCE_START`, `MAINTENANCE_END`,
  `MAINTENANCE_MESSAGE`. These are `.env` **fallbacks**; the live surface is Admin →
  Dashboard → Maintenance card (settings group `maintenance`), so every change is
  audit-dated. Prefer the admin UI.
- **Tracking (M2)** — `TRACK_EVENTS_RETENTION_DAYS`.
- **Hot picks** — `HOTPICK_LINES` (CSV, default `2.5`; only lines with a `LINE_THRESHOLDS`
  entry can fire hot).

## 4. Operational surface changes

- **`/admin` is now an in-SPA panel** (avatar menu → Admin, `#admin` hash routing) with 8
  sections. The legacy standalone `src/admin-dashboard.js` HTML dashboard still exists and
  still answers its `ADMIN_TOKEN` bearer — **M12 deletes it after parity is confirmed**, so
  it is still the fallback if the SPA panel misbehaves post-deploy.
- **Scheduled maintenance (M14) can 503 the whole site.** A window left scheduled will take
  the public site down at its start time on the server's clock. It auto-expires past its end
  (a forgotten toggle cannot hold a stale 503), and admin sessions, `ADMIN_TOKEN`/`API_TOKEN`
  bearers and `/api/auth/*` always bypass the gate — you cannot lock yourself out. Verify the
  window is off after deploy.
- **SMS broadcasts (M9) spend real money the moment `SMS_ENABLED=1`.** With it `0` the entire
  campaign path is a dry run touching no network — which is also how it was verified. Before
  the first real broadcast, confirm the Bonga credit balance shown in the preview is real and
  send a 1-recipient campaign to a number you control. Opted-out users are excluded
  structurally (even from a hand-picked selection), and a sent campaign is frozen — the
  remainder goes out as a NEW campaign, never a re-send.
- **Transactional auth SMS now carries the auth-default template** (`wrapAuthText`,
  fail-open — no template or no table sends raw text, so this cannot break OTP delivery).
- **Consent gate on signup (M4)**: new users must accept terms; `/privacy/` and `/terms/` are
  served statically by Apache from the frontend zip.

## 5. Post-deploy verification

Beyond `DEPLOYMENT.md` §5's standard checks:

1. `GET /api/settings` returns 200 (not 404) — proves the app is past v1.0.3.
2. Sign in as admin → forced PIN change appears → panel opens, all 8 sections render.
3. Admin → Settings shows the grouped catalog; a `live:true` edit takes effect without a
   restart and lands an `admin_audit` row.
4. Admin → Messaging → preview an audience: the count matches expectation and the label ends
   "opt-outs excluded". **Do not send** until the balance is confirmed.
5. Maintenance card shows the window **off**.
6. Guest (logged-out, incognito) still gets redacted records and no future dates.
7. `logs/auto-refresh.log` shows light passes; exactly ONE serve process is running.

## 6. Rollback

`DEPLOYMENT.md` §5 rollback applies to code, but **the migrations do not roll back with it** —
batches 15–19 have no exercised down-path. A code rollback to a pre-v1.1.0 build against a
batch-19 schema is untested. The realistic rollback is: restore the pre-deploy DB dump (§0)
**and** re-upload the previous build together. Take the dump.

---

## Still pending before any of this ships

| Milestone | State |
|---|---|
| M10 — Database section (overview/health/export/import) | not started |
| M11 — Performance visualizations (scorecard endpoint + widgets) | not started |
| M12 — `.env.example` rewrite, delete `admin-dashboard.js`, full E2E, docs, merge | not started |
| M9 live 1-recipient send | user-gated (needs `SMS_ENABLED=1` + real Bonga credits) |
| M1 diagnostic-SMS ack | user-gated |
