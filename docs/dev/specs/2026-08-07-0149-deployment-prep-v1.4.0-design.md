# Deployment Preparedness v1.4.0 - design

Owner-approved 2026-08-07 (chat). Six workstreams, all this session.

## 1. .env doctrine + cleanup (behavior-neutral)

`.env` is reserved for integrated-service credentials and boot infra only:
DB credentials + pool sizing, API-Football key, OpenRouter key, Bonga
credentials + send-relay URL, SMTP credentials, PIN_PEPPER / ADMIN_SEED_PIN /
ADMIN_TOKEN, MIGRATE_ON_BOOT. Everything runtime-tunable lives exclusively in
Admin -> Settings.

- New `scripts/env-to-settings.js` (dry-run default, `--yes` applies): computes
  DIFFERS-from-default keys that are in the settings catalog (same logic as
  env-audit.js) and persists them via `setOverrides()` (validated, audit-dated,
  actor null = system migration). Run BEFORE trimming so effective values never
  change - TIP_MIN_PRICE=1.35 et al. are policy-regime knobs and the migration
  is regime-neutral by construction.
- Trim local `.env` to the doctrine set, comments reduced to one-liners.
- package.json gains `gen:secret` -> `node scripts/gen-secret.js`; README gets
  the raw `node -e` one-liner alongside it.

## 2. Storage optimization (owner ruling: purge + stop writing)

- `matches.metadata` (~1.5 GB, 44% of the 3.5 GB DB, zero readers,
  insert-only): purge (`UPDATE matches SET metadata = NULL`), then
  `OPTIMIZE TABLE matches` to reclaim. `store.js` stops writing the blob on
  insert (column stays for schema compat).
- `odds_markets` (1.65 GB): untouched - it is the historical price record the
  lab/calibration read. No other table is material.

## 3. SSH deploy automation - scripts/deploy-remote.js

Reusable orchestrator over `ssh oddsprok@oddspro-p` (key auth verified;
remote has mysql/mariadb/mariadb-dump/gzip/unzip/tar, node v24 via nvm, no pv).
Deploy config in gitignored `.env.deploy` (committed `.env.deploy.example`):
SSH target, remote home, DB name/user/password. Remote paths derived from
package.json version: app root `/home2/oddsprok/oddspro-app-v<ver>/`, web
`public_html`, DB `oddsprok_prod_<ver_underscored>`.

Steps (flags `--app --web --db --fresh-db --all`, `--dry-run`):
- app: upload newest `release/oddspro-app_*.zip` (byte-progress meter),
  extract into the versioned app root, upload lean prod `.env` if absent,
  remote `npm install --omit=dev` using the nvm node.
- web: tar.gz backup of public_html to `/home2/oddsprok/v<prev>-web.tar.gz`
  (timestamp suffix when the name exists), wipe, extract the web zip.
- db: see 4.
Progress: every long transfer reports percent (local byte counter feeding the
ssh stdin stream - remote pv unavailable).

## 4. DB deploy - scripts/deploy-db.js (or deploy-remote --db)

Local Docker mariadb-dump -> gzip file in backups/ (artifact + size basis for
progress), then stream over `ssh 'gunzip | mysql <db>'` with percent progress.

- `--fresh` (first deploy of a version): full dump import, then TRUNCATE the
  instance-unique tables, then reseed admin via ONE INSERT generated locally
  (scrypt hash computed with the PROD pepper by src/auth-rules.js hashPin -
  no dependency on the remote app being installed).
- default (subsequent): dump with `--ignore-table` for every instance table -
  warehouse data overwritten (DROP+CREATE per table rides the dump), instance
  records intact; sessions cleared after import.

Instance-unique tables (never shipped after first deploy; truncated on fresh):
users, sessions, otp_codes, prefs, personal_access_tokens, user_slips,
visits, visitors, visit_sessions, visitor_devices, visit_events, ip_geo,
admin_audit, sms_templates, sms_campaigns, sms_campaign_recipients.
`settings` IS shipped on fresh (it carries the migrated .env policy) and
excluded on subsequent deploys (remote admin edits win).

## 5. Bonga SMS relay (AppScript workaround for the blacklisted remote)

Config-only: `BONGA_API_URL_SEND` points at the owner's AppScript exec URL
(HTTPS - the cleartext-send warning disappears). The relay spreads Bonga's
parsed body last into its JSON response, so `status: 222` / `unique_id` /
`credits` sit exactly where `parseBongaSend` expects them; zod strips the
wrapper keys (`_version`, `success`, `row`). Live-test one real send through
the relay + a delivery fetch. Document the relay (Code.gs included) in
`docs/guides/sms-bonga-relay.md` and link it from sms-bonga-integration.md.

## 6. Execute the v1.4.0 deploy (owner-approved FULL deploy)

Order: settings migration -> .env trim -> metadata purge/OPTIMIZE -> code
changes committed -> prod web build (VITE_SHOW_DETAILS=0, GA id) ->
package:deploy (tags v1.4.0) -> deploy --db --fresh + --app + --web.
The owner re-creates the Node app in cPanel (Application Manager cannot be
scripted from a shared shell) - old app already stopped/removed by owner;
old app dir `/home2/oddsprok/oddspro-app-v1.3.0.2/`, old DB
`oddsprok_prod_1_3_0` (same DB user). Docs: DEPLOYMENT.md SSH section,
QUICK-REFERENCE.md, guides. Live verification after the owner's cPanel step.
