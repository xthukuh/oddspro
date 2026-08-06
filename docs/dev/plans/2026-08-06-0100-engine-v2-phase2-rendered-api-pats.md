# Engine v2 Final Touches: Phase 2 plan (rendered-output API + PATs)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Same effort as the 2026-08-06-0100 spec; this file is the Phase 2 task breakdown.

**Goal:** Programmatic access to the exact rendered client view (`GET /api/view`) and admin-minted personal access tokens for integrations (n8n) and Claude's own grounding.

**Architecture:** `src/pat-rules.js` pure crypto module (the auth-rules src-root convention) + migration + `src/pats.js` thin knex service + server wiring inside `optionalAuth`; `src/view.js` computes the client pipeline server-side (magic-rules is already shared verbatim, so the server can replay the exact browser view); admin Tokens card in the lazy admin chunk.

## Global constraints

Same as the Phase 0+1 plan (pure modules, explicit merge lists, suite green, no em-dashes, Conventional Commits). PAT security invariants: only the sha256 of a token is stored (session idiom); the plaintext is returned ONCE at mint; PAT bearers are READ-ONLY (GET) and NEVER valid on `/api/admin/*` or `/api/auth/*`, regardless of the owning user's role; mint/revoke land `admin_audit` rows (`pat.create`/`pat.revoke`, no token material in the trail).

### Task 1: `src/pat-rules.js` + tests
`mintPat(bytes?)` -> `{ token: 'opat_<base64url 32B>', hash: sha256hex, prefix: first 12 chars }`; `isPatToken(s)`; `hashPatToken(s)`; `patRouteAllowed(method, path)` (GET only; deny `/api/admin` and `/api/auth` prefixes). Offline tests: format, hash determinism, route matrix.

### Task 2: migration `20260806000002_personal_access_tokens` (batch 23)
`id`, `user_id` FK users CASCADE, `name` (64), `token_hash` char(64) unique, `prefix` (12), `scopes` json (default `["read"]`), `last_used_at` nullable, `expires_at` nullable, `revoked_at` nullable, `created_by` FK users SET NULL, timestamps.

### Task 3: `src/pats.js` service
`createPat({ userId, name, expiresDays, actorId })` (insert + audit row, returns plaintext once); `listPats()` (join users, never token_hash); `revokePat(id, actorId)` (idempotent, audit row); `resolvePat(token)` (hash lookup; reject revoked/expired/inactive user; `last_used_at` throttled ~1/min).

### Task 4: server wiring + admin routes
`optionalAuth`: an `opat_` bearer resolves via `resolvePat`; disallowed route for a PAT answers `403 { error: 'token is read-only' }`; allowed -> `req.user` (owning user) + `req.pat`. Admin surface behind `requireAdminDual` + `csrfOk` mutations: `GET /api/admin/pats`, `POST /api/admin/pats` `{ user_id, name, expires_days? }`, `DELETE /api/admin/pats/:id`.

### Task 5: `src/view.js` + `GET /api/view`
`renderedView({ date, strategy = 'sure', safeOnly, oneEach, providers })`: `queryRecords` (full tier, unpaginated) -> `magicSortCached()` calibration -> `magicSortRows` -> flags per row (`safe` via `safeSelection` + policy, `sure` + prob via `sureBetsSelection`, `daily` via the day's slip legs) -> optional one-of-each collapse (highest-priority provider per `api_id`) and safe-only filter -> ordered rows with `rank` and `magic_score`. Route: `optionalAuth`, full tier required (session, PAT, machine bearer; guests 401) - the view exists to mirror the signed-in table.

### Task 6: admin Tokens card (web)
`TokensCard.jsx` in the admin chunk: list (prefix, user, last used, expiry, revoked), mint dialog (user picker via the users list, name, optional expiry days) with ONE-TIME token reveal + copy, revoke with confirm. api.js wrappers. `npm run build:web` must pass.

### Task 7: verify + docs
Migrate; mint a PAT via curl (admin bearer); hit `/api/view` + `/api/daily-slip` with it; confirm a PAT 403s on POST and `/api/admin/*`; suite green; extend `docs/guides/api.md` (PAT auth row becomes real + `/api/view` section with captured example); checklist + confirmed-facts + alignment check; commits per task group.
