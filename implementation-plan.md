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
- [x] `stats` action — statistics + lineups + events per final correlated fixture (fetch-once flags; empty responses only flagged 48h post-kickoff; serial DB writes)
- [x] `standings` action — per league/season on correlated fixtures; delete+replace rows; teams upserted for FK safety
- [x] Deadlock fix: `_batch` concurrency 1 for delete+insert transaction workloads (parallel workers deadlocked on InnoDB index gap locks)
- [x] Verify: standings 204 rows / 15 league-seasons, re-run idempotent (204 again), 3 table-less comps skipped; stats action correctly targets 0 fixtures at 6:45 AM (nothing final+correlated yet) with 0 API calls
- [ ] PENDING: full stats-path live check (statistics/lineups/events rows landing) once today's correlated matches finish — run `results` then `stats` this afternoon
- [x] Update `CLAUDE.md` (rewritten: pipeline architecture, key invariants, all 7 actions, env names)
- [x] Commit

## Phase 6 — Visualization (added per 2026-07-02 README revision)
- [x] Market mapping layer `src/markets.js`: provider market type/name → canonical columns (1, X, 2, 1X, X2, 12, U/O 0.5–6.5; defaults 1.5–4.5). Match on `type_name` never `type_id` (betika reuses id 19 across team-total markets). Single registry drives both JS pivot and SQL sort/filter conditions.
- [x] Shared read layer `src/db/records.js` — `queryRecords()` (paginate/multi-sort/filter; market columns sortable via LEFT JOIN pivot subqueries) + `columnCatalog()` (dynamic STATS list from fixture_statistics)
- [x] `export [date]` action (`src/export.js`) — temp CSV (tmp/, gitignored, BOM for Excel) with README column spec, correlated records only
- [x] API server `src/server.js` (:3001, `npm run serve`): GET /api/records (paginated + multi-sort + filter ops eq/ne/gt/gte/lt/lte/like), GET /api/columns; serves web/dist; graceful shutdown closes knex pool
- [x] `web/` React 19 + Vite 6 + Tailwind 4 datatable (`npm run build:web`; dev :5173 proxies /api → :3001); settings modal (multi-select market + STATS columns, defaults pre-selected, localStorage-persisted); filter query builder; multi-sort headers (shift-click chains)
- [x] API-Football extras: pre-match standings rank/form per team + H2H summary (W-D-L, home perspective) derived from local warehouse (no extra API hits); post-match fixture_statistics as dynamic toggleable columns
- [x] BONUS: fixed pre-existing `_date()` bug (src/utils.js) — valid `Date` instances fell through to `new Date()`; first hit by export since mysql2 returns DATETIME as Date objects
- [x] Score/goals only surfaced once fixture status is final (results-are-canonical; BetPawa reports 0-0 pre-match)
- [x] Verify: export 55 correlated records with odds+rank/form columns; API multi-sort on `O 2.5` + filters (`1 lte 1.5 AND provider eq betika` → 7) + 400 on bad keys; browser-verified datatable/settings/filters/multi-sort via Playwright, 0 console errors
- [x] Commit

## Issues / notes
- 2026-07-02: MySQL (Docker, reachable via 127.0.0.1:3306, client seen as 172.19.0.1) denied `root` with empty password. Halted per DB-connection-failure rule. RESOLVED: user added credentials to `.env` (Laravel-style names: `DB_DATABASE`/`DB_USERNAME`/`DB_CHARSET`/`DB_COLLATION`) — config.js/knexfile.js aligned to those names.
- 2026-07-02: README rewritten with fuller spec → plan revised: fixtures = canonical base; betpawa→betika correlation order; fuzzy confidence matching + `league_aliases` cache table (added to init migration pre-first-run); Phase 6 visualization added (temp CSV export → API + React datatable).
