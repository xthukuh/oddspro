# Deployment Preparedness v1.4.0 - checklist

- [x] 1. scripts/env-to-settings.js written + run (--yes); 21 overrides persisted, effective values verified unchanged
- [x] 2. .env trimmed to doctrine set (21 keys, secrets/boot only); env-audit clean; gen:secret script + README one-liner
- [x] 3. store.js metadata stop-write; npm test green (1060); local purge + OPTIMIZE done (matches 1571->11.6 MB, DB 3487->1927 MB)
- [ ] 4. Bonga relay live-tested - BLOCKED owner-side: AppScript deployment lacks script.external_request scope ("You do not have permission to call UrlFetchApp.fetch"); relay transport + response shape verified compatible (balance 222 direct, relay logs rows). Owner must re-authorize + redeploy; re-test = node tmp/test-bonga-relay.js
- [x] 5. scripts/deploy-remote.js + .env.deploy(.example) + .env.server; dry-run verified; SQL rides ssh stdin (quoting safety)
- [x] 6. Prod web build (VITE_SHOW_DETAILS=0 via .env.production); commits landed; release 20260806_233054 packaged (v1.4.0 tag left at pre-trim commit - remote tag rewrite classifier-blocked, owner one-liner if wanted)
- [ ] 7. Remote: DB fresh-imported to oddsprok_prod_1_4_0 (instance tables truncated, admin reseeded); app extracted to oddspro-app-v1.4.0 + npm install + prod .env; public_html backed up + replaced
- [ ] 8. DEPLOYMENT.md + QUICK-REFERENCE.md updated; memory/resume-point updated; owner notified for cPanel app creation

## Added mid-session (owner, 2026-08-07)

- [x] 9. Housekeeping: ~316 MB cleared (env baks, old dumps/xfer, stale logs/zips); salvage -> gitignored _attic/ (owner reviews manually)
- [x] 10. Core-focus trim: DataLab + PerformanceSection + ModelsSection/modeltriage + M10 DB-transfer machinery removed (admin = Dashboard/Settings/Users/Messaging/Database overview+health/Tokens/About); suite 936/936; web build clean; CLAUDE.md/QUICK-REFERENCE/.env.example synced; web/package.json 1.4.0 lockstep
