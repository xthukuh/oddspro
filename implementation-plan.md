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
- [x] `src/db/store.js` — `saveMatches()`: upsert `matches` by (provider, provider_match_id); delete+insert `odds_markets`; skip completed matches
- [x] Rewire `betpawa`/`betika` CLI actions to persist to DB (stop writing x-*.json; existing files untouched)
- [x] BONUS: fixed pre-existing `_batch` race - resolved before in-flight tasks drained (caused "Found 37" vs 47 saved; old JSON dumps could contain holes)
- [x] Verify: betpawa 47 matches/11073 markets; betika 164 matches/26683 markets; betpawa re-run → 0 inserted/47 updated, market count identical (clean replace)
- [x] Commit

## Phase 3 — api-sports fixtures & results
- [x] `src/apisports.js` — client (x-apisports-key header, zod validation, quota guard on x-ratelimit-requests-remaining, pagination)
- [x] `fixtures [date]` action — upsert leagues/teams/fixtures (timezone=Africa/Nairobi)
- [x] `results` action — refresh past-kickoff unfinished fixtures (ids batched 20/req); settle scores into linked matches; set `matches.completed_at` (linked terminal OR start_time > 4h past)
- [x] MySQL session time_zone pinned to +03:00 (knex pool afterCreate) so NOW() aligns with stored EAT wall-clock datetimes
- [x] Verify: 111 fixtures / 30 leagues / 220 teams upserted; results refreshed 11 in-play fixtures in 1 request; statuses NS/FT/HT/2H/PEN/CANC/INT present; quota remaining 149,998 (high-volume plan). Full settle check pends Phase 4 links + time passing.
- [ ] NOTE: zod caught `league.round` = null on live data (schema fixed) — keep schemas tolerant on nullable fields
- [x] Commit

## Phase 4 — Match linking (revised per 2026-07-02 README: fixtures = canonical base)
- [x] Name normalizer + fuzzy similarity scorer with `LINK_MIN_CONFIDENCE` threshold (default 0.85)
- [x] `link` action, provider order **betpawa → betika** (betika also scores against linked betpawa records; kickoff ±30min window; competition/league similarity included)
- [x] `team_aliases` + `league_aliases` learning + auto-link after odds/fixtures ingestion
- [x] Scorer iteration after live near-miss review: best-of(bigram dice, token-set dice, 0.9×overlap coefficient, initialism match); reserve markers II≡B≡2; club-type prefixes (JK/NK/US/AS/CS/CR/RS...) as noise; competition = corroborating bonus (+0.1×sim) never a veto; 0.05 runner-up margin guard
- [x] Verify: betpawa 26/47 (55%), betika 29/164 (18% — most unmatched lack an API-Football fixture that day); 14/14 spot-checks correct incl. initialism/word-flip/reserve cases; 55 links → 31 distinct fixtures (cross-bookmaker convergence); 110 team + 29 league aliases learned. Alias fast-path exercise pends next day's fresh matches.
- [ ] Tuning knobs for user: `LINK_MIN_CONFIDENCE` (.env), weights/margin in `src/link.js` `_confidence()`
- [x] Commit

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
