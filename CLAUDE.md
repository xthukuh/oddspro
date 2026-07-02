# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

oddspro is a MySQL data warehouse for football bookmaker odds and stats. It scrapes odds from two Kenyan bookmakers (BetPawa, Betika), ingests canonical fixture/result/stats data from API-Football (api-sports.io), and correlates bookmaker matches to canonical fixtures via fuzzy matching with learned aliases. Plain Node.js (ES modules); knex/mysql2 for the DB layer; zod validates all external data.

Source spec and progress tracking live in `implementation-plan.md` (phases 1–6 done: warehouse, ingestion, linking, deep stats, visualization).

## Commands

```sh
npm install
npm run migrate                     # knex migrate:latest (forward-only migrations)

npm run start [-- days]             # DEFAULT full pipeline (src/pipeline.js): fixtures + odds for today..+3 days
                                    # (`npm run start -- 5` overrides the sweep), then results, link once, stats, standings
node src/index.js betpawa [date]    # scrape BetPawa odds → DB, then auto-link
node src/index.js betika [date]     # scrape Betika odds → DB, then auto-link
node src/index.js fixtures [date]   # API-Football fixtures for date → DB, then auto-link
node src/index.js results           # refresh unfinished past-kickoff fixtures; settle scores; mark matches completed
node src/index.js link [provider]   # correlate bookmaker matches ↔ canonical fixtures
node src/index.js stats             # statistics + lineups + events for final correlated fixtures (fetch-once)
node src/index.js standings         # refresh league tables for correlated leagues
node src/index.js export [date]     # temp CSV of the date's correlated records → tmp/ (gitignored)

npm run serve                       # visualization API server on :3001 (serves web/dist when built)
npm run build:web                   # build the React frontend → web/dist/
cd web && npm run dev               # frontend dev server on :5173 (proxies /api/* → :3001)
```

`[date]` defaults to today; accepts anything `new Date()` parses, or `today`/`now`. All actions are idempotent and cron-able. There is no test suite and no linter.

`.env` (gitignored, see `.env.example`) holds MySQL credentials (`DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD/DB_CHARSET/DB_COLLATION` — Laravel-style names) and API-Football credentials (`X_APISPORTS_URL`, `X_APISPORTS_KEY`). Validated in `src/config.js` (zod).

## Architecture

Pipeline: **odds scrapers + fixtures ingester → MySQL warehouse → linker correlates → results settle → deep stats accumulate**.

- `src/index.js` — CLI dispatcher; every action closes the shared knex pool on exit. No action (or `start`/a bare day count) runs `src/pipeline.js`.
- `src/pipeline.js` — default full sweep (`npm run start`), ordered for fewest server hits: fixtures per date first (a date fetch also refreshes today's statuses, shrinking the results refresh set), then results (completes matches so scrapers skip their per-game detail requests via the `completedMatchIds()` exclusion set), then odds per provider per date, then a single link pass, then stats + standings.
- `src/betpawa.js` / `src/betika.js` — bookmaker scrapers (browser-mimicking axios clients against undocumented public APIs). Both emit the same standardized game record consumed by `store.saveMatches()`.
- `src/apisports.js` — API-Football client + all its fetchers. Quota-guarded (`x-ratelimit-requests-remaining` header, halts at `APISPORTS_MIN_REMAINING` floor), paginated, zod-validated. Fixtures are fetched with `timezone=Africa/Nairobi` so kickoffs align with bookmaker wall-clock times.
- `src/link.js` — correlation. API-Football fixtures are the **canonical base record**; `matches.fixture_id` is the link. Provider order matters: betpawa first, betika last (betika lacks identifier attributes and additionally scores against betpawa matches already linked to a candidate fixture). Fuzzy scorer = best of bigram-Dice / token-set / overlap-coefficient / initialism over normalized names; competition similarity is a bonus (+0.1×sim), never a veto; acceptance needs `LINK_MIN_CONFIDENCE` (default 0.85) plus a 0.05 margin over the runner-up. Confident links cache `team_aliases` / `league_aliases` for instant future correlation.
- `src/db/connection.js` — the only knex instance (never use raw mysql2). Session `time_zone` is pinned to +03:00 in `knexfile.js` so SQL `NOW()` compares correctly against stored EAT wall-clock datetimes.
- `src/db/store.js` — odds persistence: upsert `matches` by `(provider, provider_match_id)`, then delete+insert `odds_markets` (latest snapshot only, no history). Never touches `completed_at`/`fixture_id` (owned by results/link).
- `src/utils.js` — shared helpers (`_date`, `_dtime`, `_batch`). `_batch` runs promises with bounded concurrency; keep DB-writing batches at concurrency 1 — parallel delete+insert transactions deadlock on InnoDB index gap locks.
- `src/markets.js` — canonical odds market columns (1, X, 2, 1X, X2, 12, U/O 0.5–6.5; defaults 1.5–4.5). Single registry drives both the JS odds pivot and the SQL sort/filter conditions. Match markets by `type_name`, never `type_id` (betika reuses ids across different markets).
- `src/db/records.js` — read layer for visualization: `queryRecords()` (correlated records only; pagination, multi-sort, filters; market columns sortable via LEFT JOIN pivot subqueries) and `columnCatalog()` (STATS columns discovered dynamically from `fixture_statistics`). Pre-match rank/form (standings) and H2H (fixtures history) are derived locally — no API hits. Score/goals are only surfaced once the fixture status is final (bookmaker pre-match scores are garbage).
- `src/export.js` / `src/server.js` — CSV export action and the :3001 Express API (`GET /api/records`, `GET /api/columns`; `sort`/`filters` are JSON-encoded query params validated against the column registries — unknown keys are a 400).
- `web/` — React 19 + Vite 6 + Tailwind 4 datatable. Column selections (markets + STATS) persist in localStorage; the settings modal renders whatever `/api/columns` returns, so new stat types appear without frontend changes.

### Key invariants

- **Fetch throttling:** `matches.completed_at` set ⇒ odds refreshes skip the match. Fixtures reaching a terminal status (`FT/AET/PEN/AWD/WO/CANC/ABD`) complete their linked matches; unlinked matches complete 4h after start (fallback).
- **Fetch-once stats:** `fixtures.stats_fetched_at`/`lineups_fetched_at`/`events_fetched_at` guarantee each final fixture costs at most 3 detail requests ever. Empty responses only set the flag after 48h post-kickoff (minor leagues may never publish stats). Never delete or refetch immutable API data.
- **Results are canonical:** the `results` action copies authoritative scores from final fixtures into linked matches (bookmaker-parsed scores are unreliable for upcoming games — BetPawa reports 0-0, Betika null).
- **Betika null fields:** `home_team_id, away_team_id, region_id, region_name, category_id, competition_id` are always null (not exposed by its API).
- Migrations are forward-only; never edit an applied migration.

## Conventions

- ES modules, `async/await`, 4-space indentation (workspace setting — overrides the usual 2-space Node default), single quotes, semicolons.
- All external data (API responses, env) through zod schemas; keep field schemas tolerant (`nullable().optional()`) — live data has taught this (`league.round` can be null).
- `x-*-output.xx.json` files at the root are legacy fetched-data snapshots — do not delete.
