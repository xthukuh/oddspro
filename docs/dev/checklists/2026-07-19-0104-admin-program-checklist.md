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

## M6 — Settings catalog + audit + wiring
- [ ] Catalog metadata (`label/hint/unit/regime/pattern`) on ALL entries
- [ ] ~35 new keys (pipeline/hotpick/tip/ai/ai-dark/auth-policy/otp/sms/geo/bot/logging/tracking)
- [ ] Migration `admin_audit` + in-txn audit writes + `GET /api/admin/settings/audit`
- [ ] Late-read wiring per consumer table (hotpicks, ai-worker, adjudicators/enrich, auth, server bot lists, bonga, utils, auto-refresh, geo, link, apisports, prematch)
- [ ] `parseLinesCsv` shared pure helper
- [ ] `src/index.js` `loadOverrides()` pre-dispatch
- [ ] Tests: catalog completeness (label+hint present), regime flags, pattern validation, parseLinesCsv parity, audit builder
- [ ] Verify: TIP_MIN_PRICE override takes effect without restart; audit row with old/new; public subset unchanged

## M7 — Settings editor redesign
- [ ] Pure `normalizeForCompare` + `settingsDiff` + tests (blank==default, bool norm, revert=clean)
- [ ] Rebuilt SettingsEditor (grouped, label+hint+unit+reset, type-aware widgets, regime warning, sticky dirty-only Save, restart badges, audit panel)
- [ ] Verify: dirty semantics, all-or-nothing 400, reset, restart badge

## M14 — Scheduled maintenance mode (added 2026-07-19 post-M4, user request; sequenced after M7)
- [ ] Settings keys group `maintenance` (`MAINTENANCE_SCHEDULED`/`_START`/`_END`/`_MESSAGE`, live, pattern-validated, EnvSchema fallbacks)
- [ ] Pure `src/db/maintenance-rules.js` + offline tests (window parse `+03:00`, state machine w/ past-end auto-expiry, notice render closed placeholders, `windowSignature`, retry-after)
- [ ] Server 503 middleware (admin-session/bearer + `/api/auth/*` bypass; JSON body carries `maintenance` obj + `Retry-After`; static 503 HTML for page loads) + `GET /api/refresh` carries the schedule
- [ ] Client: `oddspro.maintenance` cache; dismissible pre-window banner above the nav (per-`windowSignature` dismissal); own-clock auto-switch to full-screen maintenance (polls/fetches/tracking suspended, no reload); auto-recover at end + jitter; `api.js` maintenance-503 interception
- [ ] Admin "Maintenance" card (Dashboard section): state chip, toggle, datetime range, template + live preview, +1h preset
- [ ] Verify: short live window E2E (banner → dismiss persists → autonomous switch, network quiet → guest 503 / admin bypass → auto-recover); suite green

## M8 — User management
- [ ] Pure `src/db/admin-rules.js` (patch schema incl. `phone_verified`, guards, temp PIN) + tests
- [ ] Service `src/admin-users.js` (list/search/patch + audit)
- [ ] Routes GET/PATCH `/api/admin/users[/:id]`
- [ ] `UsersSection.jsx` (DataTable, search, actions, typed confirms, temp-PIN reveal, multi-select)
- [ ] Verify: disable revokes sessions; unlock; temp-PIN → forced change; manual verify; last-admin guard

## M13 — Email OTP fallback + critical-change auth
- [ ] Mail seam (`src/mail/index.js` + `src/mail/smtp.js`, nodemailer pinned; MAIL_* zod; real creds in gitignored `.env` only)
- [ ] Migration `users.email` (nullable, NOT unique) + `otp_codes.channel`/`email`
- [ ] Resend → Bonga fetch-delivery check (`provider_msg_id`) → `{delivery_failed:true}`
- [ ] VerifyPhoneView hidden email input + email-OTP resend path
- [ ] Forgot PIN flow (SignIn → phone → OTP w/ email fallback → new PIN)
- [ ] Profile PIN change OTP confirmation (`purpose='pin_change'`)
- [ ] Pure rules + tests (delivery envelope, channel/purpose math, email zod)
- [ ] Verify: live email OTP received; forced flows E2E

## M9 — SMS templates + campaigns
- [ ] Migrations: `users.sms_opt_out`; `sms_templates`; `sms_campaigns` + recipients
- [ ] Pure `campaign-rules` + tests (renderTemplate, audience union + hardcoded opt-out, segments, batch plan, transitions)
- [ ] Auth default template applied in `sendOtpSms`
- [ ] Service `src/campaigns.js` (CRUD, preview+balance, single-slot job, cancel)
- [ ] Routes (templates CRUD; campaigns create/get/send/cancel with re-count guard)
- [ ] `MessagingSection.jsx` + UsersSection selection handoff + ProfileView opt-out
- [ ] Verify: dev dry-run; live 1-recipient send confirmed; opt-out excluded

## M10 — Database section
- [ ] `GET /api/admin/db/overview` + `/health`; pure `migrationStatus` + tests
- [ ] Pure `transfer-rules` + tests (manifest, chunkPlan, cursor, filename safety, FK order)
- [ ] `src/db-transfer.js` export job (NDJSON+gzip chunks, manifest, excludes)
- [ ] Download/delete endpoints + import (manifest, 32MB raw chunks, apply job w/ safety export + schema_head guard + resume)
- [ ] `DatabaseSection.jsx` (overview/health/export/import wizard)
- [ ] Verify: roundtrip idempotence; mid-run kill resume; refresh 409 during import

## M11 — Performance visualizations
- [ ] `src/scorecard.js` + pure `scorecard-rules` + CLI parity test
- [ ] `GET /api/admin/perf/scorecard` (60s cache)
- [ ] `PerformanceSection.jsx` (7 widgets, n-badges)
- [ ] Verify: endpoint parity vs `node scripts/ai-scorecard.js`

## M12 — Cleanup + E2E + docs + merge
- [ ] `.env.example` + `.env.production` minimal rewrite; local `.env` trim checklist
- [ ] Delete `src/admin-dashboard.js` (post-parity)
- [ ] Full chrome-devtools E2E pass (per plan list)
- [ ] Docs: QUICK-REFERENCE, engine chapters, memory-bank dated notes, CLAUDE.md, DEPLOYMENT
- [ ] Suite green; guest bundle compared; merge to `main`
