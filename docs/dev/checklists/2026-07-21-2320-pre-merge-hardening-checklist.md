# Pre-merge hardening checklist — 2026-07-21 23:20

Branch `feature/admin-dashboard-improvements`, base `beb765b`, HEAD at start `1cff979` (suite 914/914).

Source: the final whole-branch review (5 parallel subsystem tracks) plus two user-requested
audits — **production abuse resistance** and **long-running serve stability**. Every Critical
and every claim acted on below was re-verified against code in the main session before being
accepted; a review claim alone was never sufficient.

**User decisions (2026-07-21):**
1. Fix **Tier 1 + Tier 2** before merging to `main`.
2. Maintenance windows **quiesce AI + geo, keep the data pipeline running** (option 1).

**Legend:** `[ ]` pending · `[~]` in progress · `[x]` done+verified · `[-]` dropped (with reason)

---

## Provenance note — what this branch introduced vs what pre-existed

`trust proxy: true`, the unauthenticated `/api/refresh*` routes and `per_page=all` are all
present on `main` (verified via `git show main:src/server.js`). They are NOT branch
regressions. They are included here because the goal is a deployable tag, not merely a
non-regressing branch.

---

## Batch A — auth / SMS / mail security

- [x] **A1 (T1, CRITICAL) Move `users.email` capture behind proof-of-control.**
      `src/auth.js:338,364` write the address at SEND time; `forgotPinStart` (`:444`) then
      trusts it on an UNAUTHENTICATED flow. Chain: session → capture attacker inbox →
      forgot-PIN → reset-PIN → all victim sessions revoked. No PIN proven anywhere.
      Fix: drop both send-time writes; write `users.email` from the already-stored
      `otp_codes.email` inside the existing consume transaction (`verifyOtp`, `updateProfile`).
- [x] **A2 (T1, CRITICAL) Stop printing OTP codes to stdout by default.**
      `src/sms/index.js:52` + `src/mail/index.js:34` use raw `console.debug` (NOT `debugLog`),
      so `DEBUG=0` does not suppress them. `SMS_ENABLED` defaults off and `MAIL_MAILER`
      defaults `log` ⇒ a default deploy writes every login and every PIN-reset code, plus the
      phone number, to an unrotated Passenger log.
- [x] **A3 (T1, CRITICAL) Global SMS spend ceiling in `sendSms()`.**
      `src/sms/index.js:50` — day-keyed counter + `SMS_DAILY_CAP`, refuse past the cap. ONE
      chokepoint covers signup / resend / forgot-PIN / campaigns. This is what makes unbounded
      SMS spend structurally impossible rather than merely unlikely. (Signup's per-user
      `otpIssueDecision` gate can never engage — each signup creates a NEW user.)
- [x] **A4 (T2) Close the forgot-PIN existence oracle.** `src/auth.js:446,449` — a known phone
      answers 400 `no_email` / 200 + `email_hint` / 429, an unknown one 200 `sent:false`.
      Fold all into the generic answer; drop `email_hint` from the UNAUTHENTICATED response
      (keep it on the authenticated resend path).
- [x] **A5 (T2) Rate-limit `POST /api/auth/resend-otp` + cap the delivery probe.**
      `src/server.js:326` has no `rateLimit` (unlike `pin-change-otp:339`), and the
      `delivery_failed` early return deliberately does not advance the cooldown ⇒ spinnable.
      `_lastSmsDeliveryFailed` (`auth.js:311`) is `withRetry{tries:3}` × 20s and NOT `_capped`.
- [x] **A6 (T2) Loud boot warning when `MAIL_MAILER=log` / `SMS_ENABLED=0` while `AUTH_ENABLED`.**
      Same treatment `PIN_PEPPER` already gets. Silent-dead-end otherwise.
- [x] **A7 (T2) SMTP `requireTLS`.** `src/mail/smtp.js:31` — with default port 587 and unset
      `MAIL_ENCRYPTION`, `requireTLS` is false, so nodemailer may fall back to plaintext AUTH,
      contradicting the file's own comment.
- [x] **A8 (T2) OTP single-use TOCTOU.** `_checkOtp` reads outside the consuming transaction and
      all three consumers update by id without `whereNull('consumed_at')` ⇒ two concurrent
      submissions of one code both succeed.

## Batch B — server perimeter

- [x] **B1 (T1, CRITICAL) Rate-limit the three visit beacons + fix `csrfOk` arity.**
      `src/server.js:604,617,622` — no limiter (every other public POST has one); each
      `checkin` can insert into `visitors` + `visit_sessions` + `visitor_devices`, and none of
      those tables is pruned by default (`TRACK_EVENTS_RETENTION_DAYS` defaults 0 = forever).
      `csrfOk(req)` also omits `res` ⇒ the guard "works" only by throwing into `_beacon`'s catch.
- [x] **B2 (T1) `TRUST_PROXY` env knob, default `1`.** `src/server.js:72` — `true` trusts ALL
      proxies ⇒ `req.ip` is the attacker-controlled leftmost XFF ⇒ every IP-keyed limiter is
      decorative, which un-gates signup's billed SMS. Env knob avoids needing the host hop
      count now and makes a later Cloudflare hop a config change.
- [x] **B3 (T1) Authenticate the refresh routes.** `src/server.js:1062` (`/api/refresh`,
      quota + scraper burn, unlimited distinct dates defeat the per-date cooldown) and
      `:1106` (`/api/refresh/cancel`, unauthenticated, targets the SHARED job slot ⇒ an
      anonymous loop permanently aborts every light pass, the daily sweep, and an admin's
      in-flight DB import).
- [x] **B4 (T1) Cap the unpaged records query.** `src/db/records.js:285` — `per_page=all` +
      `date=all` materializes ~1.5M `odds_markets` rows as JS objects, JSON-stringifies and
      gzips them. Single unauthenticated GET ⇒ OOM.
- [x] **B5 (T1) HTML-escape the 503 maintenance page.** `src/server.js:151` —
      `<p>${info.message}</p>` raw; `MAINT_MSG_PATTERN` closes the placeholder set but permits
      markup ⇒ stored XSS for every visitor during a window (sessions live in localStorage).
      Found independently by review tracks 4 and 5.
- [x] **B6 (T1) Hard-exit backstop in `shutdown()`.** `src/server.js:1213` — `process.exit(0)`
      lives inside `server.close(cb)`, which is unbounded; the 15s grace only waits on
      `refreshJob.running`. An in-flight export download (or Node 18 keep-alive) ⇒ `.HALT`
      leaves a zombie holding :3001 and the pool. Add `closeIdleConnections()` + unref'd hard timer.
- [x] **B7 (T1) `unhandledRejection` / `uncaughtException` handlers.** Absent from all of `src/`.
      Default is exit-with-no-explanation on a host with no SSH.
- [x] **B8 (T2) Limiter overflow should evict, not `clear()`.** `src/server.js:257` — spoofing
      10k keys wipes ALL limiter state incl. in-flight login/OTP counters.
- [x] **B9 (T2) Whitelist the records cache key + memoize two uncached scans.**
      `src/server.js:526` spreads `req.query` ⇒ `?nonce=N` forces a cold compute and thrashes
      the 12-slot LRU. `/api/performance` (`:556`) and `/api/hotpicks` (`:546`) are uncached
      full-ledger scans.

**Batch B live smoke test (2026-07-21, serve with billing seams neutered):**
`POST /api/refresh` unauthenticated → **401** (was open) · `POST /api/refresh/cancel`
unauthenticated → **401** (was open) · `GET /api/records?date=all&per_page=all` → **3000 rows
of 4343, `truncated:true`** (was unbounded) · 25 rapid check-ins → **20 reached the handler,
5 refused before it** (the 20/min cap, proven by the handler-side log appearing exactly 20
times) · beacon without `X-Requested-With` → `{ok:true}`, no insert, no throw. Port freed and
re-probed after; no orphaned node processes.

NOTE E1's shutdown half (drain the campaign job + hard-exit backstop) landed with Batch B,
since it lives inside `shutdown()` and touching that function twice was avoidable. E1's
second half (honor `startCampaignJob`'s return value) is still open under Batch E.

## Batch C — settings / maintenance

- [x] **C1 (T1) Persist the VALIDATED value, not the raw one.** `src/settings.js:115-116` writes
      `String(value)` from `entries`, ignoring `batch.values`. `{"SAFE_MAX_PRICE": true}`
      validates (coerced to 1), stores `'true'`, and `effective()` thereafter returns `NaN` —
      a live regime knob silently corrupted past every catalog range check.
- [x] **C2 (T1, user decision 2) Quiesce AI + geo during an active maintenance window.**
      Shared `maintenanceActive()` helper, early-return in the AI-worker tick
      (`src/ai-worker.js:270`) and the geo tick (`src/geo.js`). The auto-refresh light pass
      DELIBERATELY keeps running (warehouse stays current). Document the split.
- [x] **C3 (T2) `maxLength` on catalog string entries** (`BOT_UA_EXTRA`, `MAINTENANCE_MESSAGE`,
      `AI_CONSENSUS_MODELS`).

## Batch D — DB transfer (M10)

- [x] **D1 (T1, CRITICAL) Import upsert must not rewrite primary keys.**
      `src/db-transfer.js:556` — knex's MySQL dialect DISCARDS the `.onConflict(pkCols)` target
      and compiles `.merge()` to `ON DUPLICATE KEY UPDATE <every column> = values(...)`,
      including `id` (verified in `node_modules/knex/.../mysql-querycompiler.js:65-95`).
      MySQL fires that on ANY unique index — `matches` has `unique(provider,
      provider_match_id)` — and the loop runs under `FOREIGN_KEY_CHECKS=0`, so a same-match
      row with a different auto-inc id rewrites the destination's `id` and silently orphans
      every `odds_markets.match_id`. Fix: merge non-PK columns only + state the contract.
- [x] **D2 (T2) Pre-flight chunk completeness before the destructive apply.** `runImportApply`
      never consults `ready_to_apply`/`missing_files`; a missing chunk ⇒ full ~1.7 GB safety
      export runs, then ENOENT mid-apply.
- [x] **D3 (T2) Import staging cleanup + delete route.** `var/imports/<stamp>/` is never
      cleaned and has no DELETE route (exports have both) ⇒ multi-GB permanent growth.
- [x] **D4 (T2) Chunk sizing vs `max_allowed_packet`.** `CHUNK_SIZE_MATCHES=500` × ~39 KB
      `metadata` ⇒ ~19 MB single INSERT vs MariaDB's 16 MB default; deterministic, so it fails
      identically on every resume.
- [x] **D5 (T2) JSON columns break the round trip under MySQL 8.** mysql2 parses `Types.JSON`
      to objects; the insert then binds an object. MariaDB reports `longtext` so it is
      unaffected today. Cast to CHAR on export.
- [x] **D6 (T2) Default-exclude operational tables.** `settings` (an import silently
      reconfigures the destination's live regime knobs incl. `MAINTENANCE_*`), `admin_audit`,
      `sms_templates`, `sms_campaigns`, `sms_campaign_recipients` (all FK `users`, which IS
      excluded ⇒ dangling or MIS-ATTRIBUTED pointers with FK checks off).

## Batch E — campaigns (M9)

- [x] **E1 (T1) Drain the campaign job on shutdown + honor `startCampaignJob`'s return.**
      `shutdown()` never touches the campaign slot (`requestCampaignCancel` is not even
      imported) and its grace predicate only checks `refreshJob.running` ⇒ a restart mid-send
      strands the campaign in `sending` forever (`canTransition('sending','sending')` is
      false); the documented recovery re-sends to everyone already delivered. Separately
      `sendCampaign:346` discards the claim result and answers `{started:true}` regardless.
- [x] **E2 (T2) `${name}` is a dead placeholder.** Every `renderTemplate` call site passes
      `{ message }` only, yet the catalog and the admin hint advertise `${name}` ⇒ a
      personalized template ships as "Hi ," to the whole audience. Drop it (the message is
      rendered and frozen at creation, before any recipient is known).
- [x] **E3 (T2) Honor opt-out DURING a running send.** `src/campaigns.js:226-228` re-reads the
      ledger each batch but never re-consults `users.sms_opt_out`; a paced broadcast runs for
      many minutes and there IS a live self-service opt-out.
- [x] **E4 (T2) `src/sms/templates.js` hygiene** — plain `Error` ⇒ HTTP 500 (`:40,46,55`);
      `Number(id) || null` turns a bad id into a silent CREATE (`:36`); the auth default can
      never be un-set (`:46`).

## Batch F — web + cross-cutting

- [x] **F1 (T1) Exclude `oddspro.visitor` from prefs sync and config snapshots.**
      `web/src/track.js:17` chose a key inside the `oddspro.*` namespace the sync machinery
      treats as preferences by default, and it is in NONE of the three deny-lists
      (`prefs-rules.js:18`, `configSnapshot.js:19,26`). Consequences: two devices of one
      account converge on one `visitors.anon_id` (silently conflating the unique/repeat
      metrics this branch exists to produce), a `.oddspro` export carries the tracking id,
      and it contradicts the privacy policy shipped in this same branch.
      **Also extend the exclusion tests** — they exist but were never extended to
      `oddspro.maintenance` either, which is why this slipped.
- [x] **F2 (T1) `src/enrich.js:281` dangling `config`.** `cfg = config` default arg, but
      `config` is no longer imported ⇒ free undeclared identifier, latent `ReferenceError`
      in an AI path.
- [x] **F3 (T2) `SettingsEditor.save()` partial-failure honesty.**
      `web/src/admin/SettingsEditor.jsx:132-154` — the DELETE loop runs AFTER the PUT commits;
      a throw leaves overrides half-applied while the UI still shows them pending.
- [x] **F4 (T2) `.HALT` boot check in `src/index.js`.** `.HALT` stops serve but NOT a cron
      writer ⇒ exactly the second-concurrent-writer configuration the slot design exists to
      prevent, during an emergency stop.
- [x] **F5 (T2) CLAUDE.md drift.** Still documents the deleted `src/admin-dashboard.js`; the
      new `src/track.js` / `src/db/track-rules.js` have no module entry; `dailyUniqueVisitors`
      → `dailyUniqueSessions`.

## Batch G — client resilience + version cache-bust (user request, 2026-07-21)

New FEATURE work, not review findings. Design decisions to confirm with the user BEFORE
building (backoff curve, which pollers participate, how a new version is detected, how far
"deprecated store cleanup" should go).

- [ ] **G1 Exponential-backoff polling when the server is unavailable.** Today every poller
      retries on a fixed cadence regardless of failures: `/api/refresh` slow 60s / fast 2s,
      the visitor badge 2min, the records reload, plus tracking beacons. A down or restarting
      server therefore takes sustained request pressure exactly when it can least afford it -
      and it lengthens maintenance work. Needs: shared backoff helper (pure + offline-tested,
      per repo convention), a ceiling, jitter (so all tabs don't retry in lockstep), and an
      immediate reset on the first success.
- [ ] **G2 Dismissible "can't reach the server" warning.** Reuse the existing M14 maintenance
      banner pattern (`windowSignature`-keyed dismissal) rather than inventing a second one.
      Must distinguish "server unreachable" from the already-handled "maintenance 503".
- [ ] **G3 Version-aware cache-bust + stale-store cleanup.** On detecting a newly deployed
      build: reload to drop stale hashed assets, and prune deprecated `oddspro.*` localStorage
      keys. NOTE the existing `data_version` signal is about DATA freshness (silent table
      reload) - this needs a separate APP/build version. Interacts with prefs sync and
      `.oddspro` config snapshots, so pruning rules must be explicit about what is
      deprecated vs merely unknown-to-this-build (a newer device's key must not be destroyed
      by an older build).

---

## Verification gate (before merge)

- [ ] `npm test` green (baseline 914; every fix above that touches a pure module adds tests)
- [ ] `npm run build:web` succeeds
- [ ] New tests specifically covering: A1 (email written only on consume), B1 (beacon limit),
      C1 (stored value round-trips through `coerceValue`), D1 (merge list excludes PK),
      F1 (both exclusion lists)
- [ ] `git diff` reviewed for unintended changes
- [ ] Checklist fully `[x]`; deferred items recorded with reasons

## Deferred to the operator (NOT code — [[separation-of-duties]])

Cloudflare free tier + security headers (CSP/HSTS/X-Content-Type-Options/Referrer-Policy) ·
`PIN_PEPPER` set BEFORE the users migration seeds the admin · `SMS_ENABLED=1` + Bonga creds ·
`MAIL_MAILER=smtp` · finite `TRACK_EVENTS_RETENTION_DAYS` · `BOT_UA_FILTER_ENABLED=1` ·
`DB_POOL_MAX=3` · HTTPS proxy for the cleartext Bonga SEND host · confirm Node ≥ 20 ·
confirm Passenger keeps the app resident · periodic Passenger stdout log rotation.
