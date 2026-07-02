# oddspro — Implementation Plan & Progress

Source spec: `C:\Users\User\.claude\plans\plan-the-oddspro-project-gleaming-truffle.md`
Goal: MySQL data warehouse for bookmaker odds (BetPawa, Betika) + api-sports.io football stats, with cross-source match linking. Analysis/prediction/dashboards out of scope.

## Status legend
- [ ] pending · [~] in progress · [x] completed (implemented AND verified)

## Phase 1 — Foundation
- [x] Add dependencies: knex, mysql2, dotenv, zod
- [x] `src/config.js` — dotenv + zod env validation (DB_*, X_APISPORTS_*, optional overrides)
- [x] `src/utils.js` — extract shared `_pint`/`_date`/`_dtime`/`_batch` from both scrapers; fix `warn` → `console.warn` bug in `_batch`
- [x] Rewire `src/betpawa.js` / `src/betika.js` to import from `src/utils.js` (no behavior change; syntax + import smoke-tested)
- [x] `knexfile.js` + `src/db/connection.js` (knex singleton)
- [x] Migration `src/db/migrations/*_init_schema.js` — full warehouse schema (11 tables, utf8mb4, timestamps, FKs) — written, NOT yet run
- [x] `npm run migrate` script; `.env.example`
- [x] Verify: migration runs clean on fresh `oddspro` DB (14 tables incl. knex bookkeeping; unique keys + FK rules introspected and confirmed)
- [x] Commit `feat: warehouse foundation (db layer, schema, shared utils)`

## Phase 2 — Odds persistence
- [ ] `src/db/store.js` — `saveMatches()`: upsert `matches` by (provider, provider_match_id); delete+insert `odds_markets`; skip completed matches
- [ ] Rewire `betpawa`/`betika` CLI actions to persist to DB (stop writing x-*.json; existing files untouched)
- [ ] Verify: run both actions for today; SQL row counts match console; re-run → no dupes, markets fully replaced
- [ ] Commit

## Phase 3 — api-sports fixtures & results
- [ ] `src/apisports.js` — client (x-apisports-key header, zod validation, quota guard on x-ratelimit-requests-remaining)
- [ ] `fixtures [date]` action — upsert leagues/teams/fixtures (timezone=Africa/Nairobi)
- [ ] `results` action — refresh past-kickoff unfinished fixtures; settle scores/status; set `matches.completed_at` (linked final OR start_time > 4h past)
- [ ] Verify: today's fixtures land; results settle; quota logged
- [ ] Commit

## Phase 4 — Match linking (revised per 2026-07-02 README: fixtures = canonical base)
- [ ] Name normalizer + fuzzy similarity scorer with `LINK_MIN_CONFIDENCE` threshold (default 0.85)
- [ ] `link` action, provider order **betpawa → betika** (betika also scores against linked betpawa records; kickoff ±30min window; competition/league similarity included)
- [ ] `team_aliases` + `league_aliases` learning + auto-link after odds/fixtures ingestion
- [ ] Verify: link rate reported; 10 links spot-checked; aliases reused on second run
- [ ] Commit

## Phase 5 — Deep stats & standings
- [ ] `stats` action — statistics + lineups + events per final fixture (fetch-once flags, low concurrency)
- [ ] `standings` action — per league/season seen in fixtures; replace rows
- [ ] Verify: completed matchday populated; re-run = 0 API hits
- [ ] Update `CLAUDE.md` (new actions, env vars, utils no longer duplicated)
- [ ] Commit

## Phase 6 — Visualization (added per 2026-07-02 README revision)
- [ ] Market mapping layer: provider market type/name → canonical columns (1, X, 2, 1X, X2, 12, U/O 1.5–4.5)
- [ ] `export [date]` action — temp CSV with README column spec (correlated records only)
- [ ] API server (:3001): paginated + multi-sort + query-builder/filter endpoint over warehouse
- [ ] `web/` React 19 + Vite + Tailwind datatable; settings modal (multi-select market + STATS columns, defaults pre-selected)
- [ ] API-Football extras: pre-match stats / H2H columns
- [ ] Verify + commit

## Issues / notes
- 2026-07-02: MySQL (Docker, reachable via 127.0.0.1:3306, client seen as 172.19.0.1) denied `root` with empty password. Halted per DB-connection-failure rule. RESOLVED: user added credentials to `.env` (Laravel-style names: `DB_DATABASE`/`DB_USERNAME`/`DB_CHARSET`/`DB_COLLATION`) — config.js/knexfile.js aligned to those names.
- 2026-07-02: README rewritten with fuller spec → plan revised: fixtures = canonical base; betpawa→betika correlation order; fuzzy confidence matching + `league_aliases` cache table (added to init migration pre-first-run); Phase 6 visualization added (temp CSV export → API + React datatable).
