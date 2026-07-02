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
- [ ] Verify: migration runs clean on fresh `oddspro` DB — **BLOCKED: MySQL access denied for root@127.0.0.1 (no password). Waiting for user to add DB credentials to `.env`.**
- [ ] Commit `feat: warehouse foundation (db layer, schema, shared utils)`

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

## Phase 4 — Match linking
- [ ] Team-name normalizer + matcher (aliases → normalized name + kickoff ±30min, both teams must agree)
- [ ] `link` action + `team_aliases` learning + auto-link after odds/fixtures ingestion
- [ ] Verify: link rate reported; 10 links spot-checked; aliases reused on second run
- [ ] Commit

## Phase 5 — Deep stats & standings
- [ ] `stats` action — statistics + lineups + events per final fixture (fetch-once flags, low concurrency)
- [ ] `standings` action — per league/season seen in fixtures; replace rows
- [ ] Verify: completed matchday populated; re-run = 0 API hits
- [ ] Update `CLAUDE.md` (new actions, env vars, utils no longer duplicated)
- [ ] Commit

## Issues / notes
- 2026-07-02: MySQL (Docker, reachable via 127.0.0.1:3306, client seen as 172.19.0.1) denied `root` with empty password. Halted per DB-connection-failure rule. Resume: user adds `DB_USER`/`DB_PASSWORD` (and `DB_HOST`/`DB_PORT` if non-default) to `.env`, then run the DB bootstrap + `npm run migrate`.
