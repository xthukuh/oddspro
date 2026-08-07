# Deployment Preparedness v1.4.0 - checklist

- [x] 1. scripts/env-to-settings.js written + run (--yes); 21 overrides persisted, effective values verified unchanged
- [x] 2. .env trimmed to doctrine set (21 keys, secrets/boot only); env-audit clean; gen:secret script + README one-liner
- [x] 3. store.js metadata stop-write; npm test green (1060); local purge + OPTIMIZE done (matches 1571->11.6 MB, DB 3487->1927 MB)
- [x] 4. Bonga relay live-VERIFIED (2026-08-07 after owner re-authorized script.external_request + redeployed): send via relay ok:true status 222 (messageId 617708374, ~5.5s round trip), delivery DeliveredToTerminal to 254799944004; balance 118 credits. docs/guides/sms-bonga-relay.md documents the relay + the auth gotcha
- [x] 5. scripts/deploy-remote.js + .env.deploy(.example) + .env.server; dry-run verified; SQL rides ssh stdin (quoting safety)
- [x] 6. Prod web build (VITE_SHOW_DETAILS=0 via .env.production); commits landed; release 20260806_233054 packaged (v1.4.0 tag left at pre-trim commit - remote tag rewrite classifier-blocked, owner one-liner if wanted)
- [x] 7. Remote DONE + verified: oddsprok_prod_1_4_0 = 37 tables / 82,097 fixtures / 6.3M odds rows / 22 settings overrides / admin +254799944004 seeded (must_change_pin=1) / migrations at head; app in oddspro-app-v1.4.0 (.env uploaded, 112 node_modules); public_html backed up (v1.3.0.2-web*.tar.gz) + v1.4.0 build extracted (INDEX_OK). Gotcha fixed en route: Compress-Archive backslash zip paths broke Linux unzip -> package-deploy now zips via System32 bsdtar
- [x] 8. DEPLOYMENT.md §4a + QUICK-REFERENCE §2.4 + toolset KB + memory/resume-point updated; owner actions listed in the session summary (cPanel app creation, relay re-auth, optional tag move)
- [x] 11. LIVE SMOKE PASSED (2026-08-07 ~00:24 UTC, after the owner created + restarted the cPanel Node app): oddspro.ke serves "Odds Pro v1.4.0"; /api/refresh|columns|settings|visits 200; guest future-date 403; migrated settings live (light 15m / full 05:00 EAT / SAFE_* policy); first light pass `light OK 9s dates=2026-08-07` -> data_version 1; ONE lsnode process (two orphaned v1.3.0.2 processes found still running their schedulers - killed, quota burn stopped)

## Added mid-session (owner, 2026-08-07)

- [x] 9. Housekeeping: ~316 MB cleared (env baks, old dumps/xfer, stale logs/zips); salvage -> gitignored _attic/ (owner reviews manually)
- [x] 10. Core-focus trim: DataLab + PerformanceSection + ModelsSection/modeltriage + M10 DB-transfer machinery removed (admin = Dashboard/Settings/Users/Messaging/Database overview+health/Tokens/About); suite 936/936; web build clean; CLAUDE.md/QUICK-REFERENCE/.env.example synced; web/package.json 1.4.0 lockstep
