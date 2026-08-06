# Deployment Preparedness v1.4.0 - implementation plan

Spec: `docs/dev/specs/2026-08-07-0149-deployment-prep-v1.4.0-design.md`.
Checklist: `docs/dev/checklists/2026-08-07-0149-deployment-prep-v1.4.0.md`.

Owner boundary (2026-08-07 chat): NO destructive remote actions outside
`public_html` and deployment-only targets (the new `oddspro-app-v1.4.0/` dir
and the empty `oddsprok_prod_1_4_0` DB). Old app dir / old DB / old backups
untouched. Escalate anything else.

## Task order (each lands as its own commit where it changes the repo)

1. **Settings migration tool** - `scripts/env-to-settings.js` (dry-run default,
   `--yes`): DIFFERS ∩ catalog -> `setOverrides()`. Run with `--yes`; verify
   via `effective()` spot-checks that values are unchanged.
2. **.env trim** - doctrine set only (secrets, pool, MAIL_*, bootstrap,
   MIGRATE_ON_BOOT, BONGA_API_URL_SEND relay). Re-run env-audit: expect
   SECRET + boot-only keys, zero admin-editable DIFFERS from trimmed keys.
   package.json `gen:secret`; README one-liner section. Update .env.example
   pointer lines if stale.
3. **Metadata stop-write** - `src/db/store.js` insert path drops `metadata`
   (column stays). `npm test` green. Purge: `UPDATE matches SET metadata=NULL`
   + `OPTIMIZE TABLE matches` (local Docker, ~1.5 GB reclaim).
4. **Bonga relay** - set `BONGA_API_URL_SEND` to the AppScript exec URL in
   local .env; live-test send + delivery fetch via a throwaway node script.
   Doc: `docs/guides/sms-bonga-relay.md` (Code.gs verbatim), link from
   sms-bonga-integration.md. Escalate to owner on failure.
5. **Deploy tooling** - `scripts/deploy-remote.js` (+ `.env.deploy` gitignored,
   `.env.deploy.example` committed). Flags: `--app --web --db [--fresh]
   --all --dry-run`. Byte-progress on upload + import streams. Lean prod .env
   generator (fresh secrets: PIN_PEPPER, ADMIN_TOKEN, ADMIN_SEED_PIN reported
   to owner). Local-hash admin reseed SQL in fresh mode.
6. **Prod build + package** - `VITE_SHOW_DETAILS=0 VITE_GA_ID=G-2CNKRP1W0Q
   npm run build:web`; commit everything; `npm run package:deploy` (tags
   v1.4.0, pushes tag).
7. **Execute deploy** - `deploy-remote --db --fresh` (dump excludes nothing,
   truncate instance tables post-import, reseed admin), `--app` (extract +
   npm install + prod .env), `--web` (backup -> wipe -> extract). Verify
   remotely: table counts, migration status, file listing.
8. **Docs + close** - DEPLOYMENT.md SSH-deploy section, QUICK-REFERENCE.md
   (same commit as command changes), memory-bank note, resume-point update.
   Owner does the cPanel Node-app creation; live verification after.
