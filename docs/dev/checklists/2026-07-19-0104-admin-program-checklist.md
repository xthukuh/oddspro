# Admin Dashboard Improvements — Checklist (living tracker)

Stamp `2026-07-19-0104`. Plan: `docs/dev/plans/2026-07-19-0104-admin-program.md`. Status values: pending / in progress / completed. Only mark completed when implemented AND verified (suite + live check).

## M0 — Program setup
- [x] Branch `feature/admin-dashboard-improvements`
- [x] Spec + plan + checklist committed (this stamp)
- [x] `docs/dev/apis/BongaSMS-postman-*.json` added to git

## M1 — Bonga SMS send fix — COMPLETED 2026-07-19 (evidence-narrowed scope)
- [x] Diagnostics: `smsBalance()` → ok, client "Intent", **136 credits** (creds + credits valid)
- [x] Diagnostics: live send to 254724212034 → **222 "sent" (unique_id 597538152)**; delivery report → **DeliveredToTerminal 01:07:24**
- [x] ROOT CAUSE VERDICT: pipeline works end-to-end with the EXISTING urlencoded transport — the reported failure was transient (most plausibly zero credits at the time). **Multipart switch REJECTED by evidence** (plan's evidence gate); `buildSendForm` dropped with it.
- [x] Tolerant `SendEnvelope` + `DeliveryEnvelope` (safeParse — shape drift folds to `ok:false`, never throws in a request path) + real live delivery envelope mapped (`delivery_status_desc`/`date_received`/`msisdn`; vendor sends NO `delivery_status`) + tests
- [x] `bonga.js` comment records the live verification (do not switch to multipart without new evidence)
- [x] Suite green (724/724)
- [ ] User acks reception of the diagnostic SMS on 254724212034 (delivery report already says DeliveredToTerminal)
- Note: signup→OTP→verify app-level E2E folds into M13 verification (the resend path is reworked there anyway)

## M2 — Tracking v2 — COMPLETED 2026-07-19 (live-verified)
- [x] Migration `20260719000001_visitor_tracking_v2.js` (4 tables) — applied locally (batch 15)
- [x] Pure `src/db/track-rules.js` + `tests/track-rules.test.js` (7 tests)
- [x] Service `src/track.js` (checkin/ingestEvents/checkout/dailyUniqueSessions, best-effort)
- [x] Routes `POST /api/visit/checkin|events|checkout` (public + csrfOk + 8kb + optionalAuth; errors fold to `{ok:true}`)
- [x] Client `web/src/track.js` (UUID, server-side resume, 15s/10-event flush, keepalive checkout) + App.jsx mount
- [x] Geo backfill discovers + stamps `visit_sessions` (shared ip_geo cache)
- [x] 👤 badge route reads `dailyUniqueSessions` (visit_sessions)
- [x] Verify 2026-07-19: `npm run migrate` batch 15 → 4 tables; API checkin/resume same-sid; browser checkin (sid stored ~2s post-mount) + NEW-TAB server-side resume (same sid, fresh sessionStorage); 2 events rows landed (values intact, `events_count` bumped); checkout → `ended_at` + `duration_seconds`; ended-session events → `{ok:false,recheck:true}` (bad-shape key folds to `{ok:true}` via `_beacon`); geo pass stamped `geo_status='private'` from shared `ip_geo` cache (no re-query); badge `dailyUniqueSessions` `{unique:2,total:2}`
- [x] Suite green offline (731/731, re-run post-verify)

## M3 — Feature events — COMPLETED 2026-07-19 (live-verified)
- [x] `web/src/trackEvents.js` constants (14 events, `EV` + `onOff`) + `tests/track-events.test.js` (grammar/unique/sanitize round-trip; suite 735/735)
- [x] `track()` calls: App.jsx central handlers (refresh, filters_apply(count), magic_sort_toggle(id), safe_only/sure_bets/one_of_each/risk_gate(on|off), csv_export(rows), calendar_nav(prev|next|date) via `navDate`, betslip/help/settings opens via shared wrappers used by nav + overflow) + `tip_popover(market)` at DataTable's `openTip` + `betslip_build(legs)` at addSlip/fillFromTop/seedTopSlip (the debounced AUTO rebuild deliberately untracked — machine-driven, would spam)
- [x] Verify 2026-07-19: browser clicks landed `help_open`/`settings_open`/`calendar_nav prev,next`/`betslip_open` rows; batch first hit the ENDED stored session → real-client `recheck` → re-checkin (new sid) → retry landed all 5, zero loss

## M4 — Legal consent — COMPLETED 2026-07-19 (live-verified)
- [x] `web/src/legal/legalContent.js` + `TERMS_VERSION` `2026-07-19` (legal-agent draft, reviewed; PRIVACY 11 / TERMS 14 sections; Oddspro / info@oddspro.ke / Kenya DPA 2019; negative-EV disclosed, 18+, opt-out, responsible gambling)
- [x] `scripts/gen-legal.js` + committed `web/public/{privacy,terms}/index.html` + `build:web` wiring (one content module feeds modal AND pages — no drift)
- [x] `LegalModal.jsx` (Sheet + CollapseSection + Terms/Privacy tab toggle + printable link `/x/index.html` — the pretty dir URL falls to the SPA on vite DEV only) + links: HelpModal footer, AuthShell footer (all auth views), signup label
- [x] Signup checkbox ("18 or older + agree") gates submit; `signupSchema` `accepted_terms z.literal(true)` + `terms_version`; `createUser` persists; `publicUser` exposes both
- [x] Migration `20260719000002_user_terms_consent.js` (batch 16, nullable — no retro-gate)
- [x] ProfileView Legal row (accepted vN on date + doc links)
- [x] Verify 2026-07-19: API signup w/o consent → 400, with → 201 + row stamped (`2026-07-19` / EAT datetime); UI submit disabled until checked, label/Help/footer links open the modal (Terms 14 collapse sections, tab switch works); `/privacy/index.html` + `/terms/index.html` render (11/14 sections, cross-linked); suite 735/735 (signupSchema test extended: false/missing/blank-version all rejected)

## M5 — Admin shell + Dashboard — COMPLETED 2026-07-19 (live-verified)
- [x] `useAdminRoute.js` hash routing (`#admin/<section>` parse/normalize, history entry per section visit, StrictMode-safe hash claim, unmount clears the hash) + SessionProvider boot hash read (tiny main-bundle import only) + AuthGate renders SignInView for a guest deep link (`signIn` preserves view='admin' when the account is admin)
- [x] AdminPanel full-page shell + section nav (8 sections: sidebar rail md+ / pill row below; SettingsEditor + DataLab mount unchanged; Users/Messaging/Performance/Database placeholders name their milestone; About links the legal pages); `useDark` extracted to a shared admin module (one copy for DataLab + Dashboard)
- [x] `GET /api/admin/track/summary` (requireAdminRole session-only, pre-binned in track.js: daily sessions+people, feature ranking, duration histogram via pure `durationHistogram`, repeat-visitor share, device/country splits, today tiles incl. `active_now`) + fixed `durationBucket(null)` binning as '<30s' (`Number(null)===0`) + tests
- [x] `DashboardSection.jsx` (today tiles; engine KPI strip from `/api/performance` + `/api/magic-sort` with n-badges and signed ROI colour; zero-filled visits/day chart; duration histogram; feature/device/country rank lists; 7/30/90d window select)
- [x] `GET /admin` → 302 `/#admin` (curl + browser follow-through verified); `/api/visits/summary` → requireAdminDual (ADMIN_TOKEN bearer 200 AND admin session 200); `requireAdmin` dropped, `adminBearerOk` retained
- [x] Verify 2026-07-19: suite 736/736; build clean — recharts (`CartesianGrid`) zero hits in the guest bundle, admin chunk lazy at 415.6 kB; guest `#admin` → sign-in view; admin deep-link reload → `#admin/dashboard` with live tiles+charts (real M2/M3 beacon data); `#admin/settings` reload keeps Settings active; nav click → `#admin/lab`, back button → dashboard; × close → clean URL; `/admin` lands in the panel; zero console errors; track summary 401 unauth AND 401 on ADMIN_TOKEN bearer (session-only confirmed)

## M6 — Settings catalog + audit + wiring — COMPLETED 2026-07-19 (live-verified)
- [x] Catalog metadata (`label/hint/unit/regime/pattern`) on ALL 74 entries (patterns as regex SOURCE strings so entries JSON-serialize to the M7 editor; `patternHint` names the format in the 400)
- [x] 44 new keys (pipeline 4 / hotpick 7 / tip 6 / ai +4 / ai-dark 4 / auth-policy 3 / otp 5 / sms 2 / geo 3 / bot 2 / logging 3 / tracking 1); `features` group dissolved into sms/geo/bot; SAFE_STRATEGY gained the real STRATEGIES enum; AUTH_ENABLED deliberately EXCLUDED (an in-session flip would saw off the branch the settings UI sits on); regime:true = TIP_*/HOTPICK_*/SAFE_* wildcard + ai-dark, HOTPICK_AI_CONCURRENCY exempt (mechanical); TRACK_EVENTS_RETENTION_DAYS added to EnvSchema (default 0 keep-forever) + `pruneTrackEvents()` in the light pass beside purgeExpiredAuth
- [x] Migration `20260719000003_admin_audit` (batch 17; actor FK SET NULL) + pure changed-only `buildAuditRows` + in-txn writes in `setOverrides`/`resetOverride` (stored-values SELECT ... FOR UPDATE inside the txn) + `GET /api/admin/settings/audit` (requireAdminRole session-ONLY)
- [x] Late-read wiring: hotpicks (gates/tip floors/lines/book guards/h2h window), ai-worker (caps+windows via per-drain `effectiveAiConfig()` snapshot), adjudicators (`aiModelTag(cfg)`/`_preambleActive(cfg)`/prompt+tag share ONE cfg so preamble bytes and #p version can't diverge; `effectiveAiConfig` MOVED to settings.js, enrich re-exports — avoids the adjudicators→enrich→hotpicks cycle), auth (OTP_*/PIN_*/SESSION_TTL), server (bot extra/allow lists per request after the enabled check; SMS_DEFAULT_REGION), bonga (BONGA_SERVICE_ID), utils (DEBUG), auto-refresh (AUTO_LOG*), geo (batch/url live; GEO_INTERVAL stays restart with in-code comment), link, apisports (quota floor + history depth), prematch
- [x] `parseLinesCsv` in goals-rules (array passthrough + CSV; config.js HOTPICK_LINES transform DELEGATES to it — parity by construction)
- [x] `src/index.js` awaits `loadOverrides()` pre-dispatch (decision 5 — CLI sweeps share serve's effective gates)
- [x] Tests: catalog completeness (label+hint+group+type+pattern-compiles, ≥70 keys), exact regime-flag predicate, pattern accept/reject matrix, SAFE_STRATEGY enum, range spot-checks, secrets/boot exclusion, public subset EXACTLY the 8 SAFE_*, audit builder changed-only/reset; parseLinesCsv cases in goals-rules suite — suite 746/746
- [x] Verify 2026-07-19 (live :3001): `/api/settings` public subset unchanged (8 SAFE_* keys); PUT TIP_MIN_PRICE 1.3 → effective 1.3 same process no restart (then 1.32, then DELETE reset → 1.35 default); HOTPICK_LINES 'abc' → 400 with patternHint message; admin_audit ladder null→1.3, 1.3→1.32, 1.32→null (changed-only, actor null for bearer writes); audit route 401 on ADMIN_TOKEN bearer AND 200 with minted admin session (revoked after); CLI `performance` ran under pre-dispatch loadOverrides; docs updated same-commit (engine 01/06, QUICK-REFERENCE warnings/definitions, memory-bank regime-log preamble, CLAUDE.md DARK/catalog claims)

## M7 — Settings editor redesign — COMPLETED 2026-07-19 (live-verified)
- [x] Pure `normalizeForCompare` + `settingsDiff` in settings-rules (+3 offline tests, suite 749/749): '1.60'==1.6 semantic equality, bool norm, revert=clean; blank NUMERIC == default (clean without an override, a RESET entry when one exists) while a blank STRING stays a value (AUTO_FULL_AT '' = "off" ≠ reset-to-default); numeric junk stays raw → dirty → the server 400s; unknown keys dropped (stale edit vs a changed catalog). Returns `{set, reset, count}` — ONE dirty-truth shared verbatim with the web editor (out-of-root import like magic-rules)
- [x] Rebuilt SettingsEditor: 14 GROUP_LABELS sections in catalog order; row = label + hint + `key · default · range` + live/restart badge + ⚠ regime chip (tooltip = ledger-split warning) + overridden chip + type-aware widget (boolean Switch / enum select from the real STRATEGIES / NumberInput / pattern input with soft amber `border-hot` + patternHint placeholder) + per-field Reset; dirty rows tinted `bg-accent/5`; sticky Save bar ONLY while `settingsDiff.count > 0` (regime warning naming touched labels + "Restart required to apply: keys" note + Save N/Discard); recent-changes audit panel via new api.js `getAdminAudit` (session-only route — a 401 renders a note instead). Admin lazy chunk 500.78 kB (zod now rides it via the settings-rules import); guest bundle untouched
- [x] Verify 2026-07-19 (live :3001, minted admin session, browser): edit 256→300 shows "Save 1 change" + tinted row, revert →256 hides the bar; regime+restart batch shows both notes ("Safe: picks per day" amber, AUTO_FULL_AT restart); save → "Saved - changes are live." + overridden chip + audit row `AUTO_LOG_MAX_KB default → 300` attributed `+254799944004` (bearer-era M6 rows render "admin token"); per-field Reset → `300 → default` audit row + chip cleared (DB left clean); all-or-nothing 400 at API AND UI level (HOTPICK_LINES 'abc' + AUTO_LIGHT_MINUTES 20 → patternHint error, BOTH overrides stayed null); amber border on the bad pattern; console clean (only the deliberate 400); suite 749/749, build clean

## M14 — Scheduled maintenance mode — COMPLETED 2026-07-19 (live-verified)
- [x] Settings keys group `maintenance` (`MAINTENANCE_SCHEDULED`/`_START`/`_END`/`_MESSAGE`, all live, pattern-validated — datetime pattern + closed-placeholder message pattern from maintenance-rules; EnvSchema fallbacks; NOT public — public subset stays exactly the 8 SAFE_*)
- [x] Pure `src/db/maintenance-rules.js` + `tests/maintenance-rules.test.js` (10 tests): `parseMaintenanceWindow` explicit `+03:00` + calendar round-trip (V8 ROLLS OVER '2026-02-31' instead of NaN — caught by test), `maintenanceStateAt` ms-core shared server/web, past-end auto-expiry, total `renderMaintenanceNotice` (blank→default, unknown placeholder stays literal — save-side pattern rejects it), `windowSignature`, `retryAfterSeconds`, `maintenanceInfo` payload
- [x] Server 503 gate before the routes (one `effective()` lookup while off; admin-session/machine-bearer/`/api/auth/*` bypass; `/api/*` → 503 JSON `{error:'maintenance', maintenance}` + `Retry-After`; page loads → self-contained 503 HTML w/ meta-refresh 60) + `GET /api/refresh` carries `maintenance`
- [x] Client: `oddspro.maintenance` cache (excluded from prefs-sync DEVICE_EXACT + configSnapshot isTransient); banner above nav w/ per-signature dismissal; own-clock overlay switch (records/refresh/visitors polls + tracking suspended — `setTrackingSuspended`); recovery at end + 5–30s jitter (silent reload + one status poll); `api.js` 503 interception via `oddspro:maintenance` DOM event; admins exempt from the switch (bypass strip instead)
- [x] `MaintenanceCard.jsx` on Dashboard (state chip off/scheduled/active on a 30s tick, Switch toggle, datetime-local pair (EAT), template textarea + live preview via shared `renderMaintenanceNotice`, +1h preset, Save/Discard through the standard settings PUT)
- [x] Verify 2026-07-19 (live :3001, suite 759/759, build clean — admin chunk 506.2 kB): sched-phase — `/api/refresh` carries scheduled payload w/ rendered message; `${name}` message → 400; audit rows 6–8 attributed to admin phone (changed-only — the 400 left no row). Guest browser — banner shown, dismiss persists across reload (dismissedSig stored). ACTIVE (06:48–06:50 EAT window) — overlay switched at start on own clock, table stayed mounted (108 rows), network QUIET (60s poll due at :48:26 never fired). Second active window — guest `/api/records` 503 `Retry-After:152` + JSON body w/ schedule; page `/` → 503 maintenance HTML (browser reload showed it); admin session records 200; `/api/auth/me` 401 (auth gate, not maintenance); browser re-entered overlay via 503-INTERCEPTION with the NEW window signature. Recovery — overlay gone at end+jitter (03:51:05), silent records reload + polls resumed, LS info cleared. Card — chip honestly `off` on past-end window w/ toggle still on; +1h preset → dirty → Save → chip `scheduled` + notice. First-window matrix 200s were genuine AUTO-EXPIRY (requests landed past end) — re-tested inside a fresh window. Console clean. Cleanup: overrides reset (settings table empty), session revoked, :3001 free

## M8 — User management — COMPLETED 2026-07-19 (live-verified)
- [x] Pure `src/db/admin-rules.js` + `tests/admin-rules.test.js` (17 tests): strict zod patch envelope (`is_active`/`role`/`phone_verified` + one-way `unlock`/`force_pin_change`/`reset_pin` as `z.literal(true)` — false is invalid, pin_hash can never ride a patch), `patchGuards` (self-disable/demote + self PIN actions rejected; `lastAdminViolation` string-compares ids for mysql2 BIGINTs), `buildUserUpdate` (reset_pin clears the lockout too — a rescued locked user must be able to use the temp PIN), `patchRevokesSessions` (disable + reset only; a demotion relies on the per-request role check), `newTempPin` = `generateOtp(4)` reuse, changed-only `buildUserAuditRows` (4 namespaced actions, per-field `user:<id>:<field>` targets, NO PIN material ever), `adminUserView` (ops projection, pin_hash leak asserted against)
- [x] Service `src/admin-users.js` (listUsers w/ correlated active-session counts + q search; patchUser: guards → temp-PIN hash → users update + session revoke + audit rows in ONE transaction; temp PIN only in the response)
- [x] Routes GET/PATCH `/api/admin/users[/:id]` (requireAdminRole session-only, csrfOk + authJson 4kb on PATCH, authErr maps AuthError/ZodError) + api.js `getAdminUsers`/`patchAdminUser`
- [x] `UsersSection.jsx` (search + count, multi-select w/ "N selected" chip for M9, status/role chips, contextual actions w/ self-footguns hidden, typed confirms DISABLE/RESET/ADMIN/NORMAL, one-time temp-PIN reveal w/ copy, in-place row update from the PATCH response)
- [x] Verify 2026-07-19 (live :3001, minted admin session): 401 unauth; self-disable/self-reset 400 w/ exact guard messages; CSRF 403; strict-schema 400 on `pin_hash`. Signup test user → disable → `active_sessions:0`, its session 401, login 403 "disabled" → re-enable. 3 wrong PINs → attempts 3 → unlock → 0/null. reset_pin → temp 5019, old PIN 401, temp login → `/api/prefs` 403 `pin_change_required` → profile PIN change BLOCKED unverified (`verify_required`) → **admin manual verify → PIN change OK → gate lifted 200** (the M8 rescue story end-to-end). Promote/demote roundtrip. Last-admin guard 400 both variants (service-level, non-admin actor). Audit ladder 7 rows changed-only attributed actor 1 (guard rejections left NO rows). Browser (#admin/users deep link): 4 users rendered, self row shows only Unverify, typed-confirm dialog (button disabled until DISABLE typed) → row live-updates to DISABLED/0 sessions, Reset PIN → reveal dialog (PIN 1997, verified by API login → `must_change_pin:true`), search "M8" → 1 of 4, multi-select chip, console clean. Suite 776/776; build clean (admin chunk 516.6 kB, guest untouched). Cleanup: test user deleted, verify sessions revoked, :3001 free, browser storage cleared

## M13 — Email OTP fallback + critical-change auth ✅ (2026-07-19)
- [x] Mail seam (`src/mail/index.js` + `src/mail/smtp.js`, nodemailer 9.0.3 exact-pinned; MAIL_* zod in config.js; creds `.env`-only, `.env.example` placeholders; catalog exposes only `MAIL_MAILER`, group `mail`)
- [x] Migration `20260719000004_email_otp` (batch 18): `users.email` (nullable, NOT unique) + `otp_codes.channel`/`email`
- [x] Resend → Bonga fetch-delivery check (`provider_msg_id` persisted on the row when the send verdict lands, `code_hash`-guarded) → `{delivery_failed:true}` **without rotating the code or the cooldown**
- [x] VerifyPhoneView revealed email input + email-OTP resend path (emailed code completes phone verification)
- [x] Forgot PIN flow (`ForgotPinView.jsx`, SignIn link, AuthGate view `forgot`; stored-email-only fallback; auto sign-in + full session revoke in one txn)
- [x] Profile PIN change OTP confirmation (`purpose='pin_change'`, `POST /api/auth/pin-change-otp`, route-exempt from the must_change_pin gate)
- [x] Pure rules + tests (`isDeliveryFailure`, `otpRowTarget`, channel-aware `otpIssueDecision`, `maskEmail`, `emailFallbackTarget`, resend/forgot/reset schemas + profileSchema otp_code refine) — suite **788/788**
- [x] Verify E2E (serve, `SMS_ENABLED=0`/`MAIL_MAILER=log` console codes): email-channel resend → emailed code verified the phone + captured `users.email`; stale rotated SMS code rejected; PIN change 400s without `otp_code` and succeeds with it (new PIN logs in); forgot-PIN → reset → auto sign-in with the pre-reset session 401'd; stored-email reset shows the `t***@example.com` mask; unknown phone stays generic; `no_email` 400 when none on file. Browser: Forgot-PIN two-step + profile PIN-change code, console clean. **Live SMTP send still pending real `MAIL_*` creds (user-gated).**

## M9 — SMS templates + campaigns
- [x] Migrations `20260719000005_sms_templates_campaigns` (batch 19): `users.sms_opt_out`; `sms_templates`; `sms_campaigns` + `sms_campaign_recipients` (unique `(campaign_id, user_id)` — makes ledger materialization idempotent)
- [x] Pure `campaign-rules` + tests (renderTemplate one-pass/total, GSM-7 + UCS-2 segment counting incl. the escape table, audience discriminated union + **hardcoded opt-out**, batch plan, send breaker, status machine)
- [x] Auth default template applied in `sendOtpSms` (`wrapAuthText`, fail-open — no template/no table sends raw text)
- [x] Service `src/campaigns.js` (CRUD, preview+balance, single-slot job, cancel)
- [x] Routes (templates CRUD; campaigns preview/create/get/send/cancel with the re-count guard; `GET /api/admin/sms/job` progress)
- [x] `countDriftVerdict` drift policy — **asymmetric**: refuse ANY growth (extra recipients were never previewed and bill beyond the approved estimate), proceed on shrink (opt-out/disable/un-verify only ever remove someone already approved, so the send stays a subset). Total: client-supplied `expected` coerces instead of throwing. Suite **828/828**
- [x] `MessagingSection.jsx` + UsersSection selection handoff + ProfileView opt-out
- [x] Verify E2E (serve, `SMS_ENABLED=0` dry run): preview 3 = eligible users, `cost_estimate` 3; **drift growth (expected 2, actual 3) → 409**, **drift shrink (expected 5, actual 3) → 200**; send completed 3/3 sent 0 failed with a full recipient ledger; **opt-out excluded from a filter audience (3→2) AND from an explicit admin selection (2 ids → 1 recipient)** — consent holds by construction; re-send of a completed campaign → 409 frozen; untyped `confirm` → 400; unauthenticated → 401. Cleanup: test campaigns purged, opt-out reset, verify session revoked, :3001 free.
- [ ] **Live 1-recipient send — user-gated** (needs `SMS_ENABLED=1` + real Bonga credits; dry-run path proven above)

## M10 — Database section — COMPLETED 2026-07-21 (controller live-verified)
- [x] `GET /api/admin/db/overview` + `/health`; pure `migrationStatus` + tests (Task 1-2, bea5526/1227a65; live: 33 tables, dbHealth ok)
- [x] Pure `transfer-rules` + tests (manifest, chunkPlan, cursor, filename safety, FK order) (Task 1, bea5526)
- [x] `src/db-transfer.js` export job (NDJSON+gzip chunks, manifest, excludes) (Task 3, 6a1cf6a+f68fdc2; live: 8-table export incl composite/varchar PK)
- [x] Download/delete endpoints + import (manifest, 32MB raw chunks, apply job w/ safety export + schema_head guard + resume) (Task 4, 9ad70cd+0284711; OPUS-reviewed, all 6 safety guarantees verified)
- [x] `DatabaseSection.jsx` (overview/health/export/import wizard) (Task 5, cb3570e)
- [x] Verify: roundtrip idempotence (checksums identical), mid-run kill resume (already_complete), schema_head guard fires at apply — controller live roundtrip PASSED

## M11 — Performance visualizations — COMPLETED 2026-07-21 (controller live-verified)
- [x] `src/scorecard.js` + pure `scorecard-rules` + CLI parity test (Task 6, 2386b68; byte-identical CLI output vs independent baseline; settle→tipHitSafe equivalence proven)
- [x] `GET /api/admin/perf/scorecard` (60s dedicated cache) (Task 7, 3b49de3)
- [x] `PerformanceSection.jsx` (7 widgets, n-badges + underpowered badges, no +edge framing) (Task 7, 3b49de3+14fcedf)
- [x] Verify: scorecardSummary S1-S5 matches CLI — controller live-verified

## M12 — Cleanup + E2E + docs + merge (IN PROGRESS)
- [x] Delete `src/admin-dashboard.js` (post-parity: DashboardSection covers traffic+country via M2 tracking; /admin already redirects; zero imports) (6dddcb1)
- [ ] `.env.example` minimal rewrite (creds/endpoints/boot/VITE_* only; runtime knobs → Admin→Settings) + local `.env` trim checklist in DEPLOYMENT — PENDING AI-economy findings
- [ ] **NEW (user ask 2026-07-21): performance optimization** — pipeline (`npm run start`) + web app speed (3 investigations running)
- [ ] **NEW (user ask 2026-07-21): AI-spend economy** — tighten Gemini budget, prefer free OpenRouter models (investigation running)
- [ ] Full chrome-devtools E2E pass (per plan list)
- [ ] Docs: QUICK-REFERENCE, engine chapters, memory-bank dated notes, CLAUDE.md, DEPLOYMENT
- [ ] Suite green; guest bundle compared; version bump decision (1.2.1 vs 1.3.0 — RAISE with user); merge to `main`
