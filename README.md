# ODDS PRO

MySQL data warehouse for football bookmaker odds and stats, with a web datatable for informed betting tips.

It scrapes odds from two Kenyan bookmakers (**BetPawa**, **Betika**), ingests canonical fixture/result/stats data from **API-Football**, and correlates bookmaker matches to canonical fixtures via fuzzy matching with learned aliases. Everything is idempotent and cron-able; the whole sweep runs as one command.

## How it works

- **API-Football fixtures are the canonical base record.** Bookmaker matches are correlated to them by kickoff window, fuzzy team-name similarity (bigram-Dice / token-set / overlap / initialism scoring over normalized names) and competition-name similarity as a corroborating bonus. Confident links are cached as `team_aliases` / `league_aliases`, so correlation gets faster and more accurate as data grows.
- **Provider order matters:** BetPawa correlates first; Betika last, because its API exposes no identifier attributes (`home_team_id, away_team_id, region_id, region_name, category_id, competition_id` are always null) — it additionally scores against BetPawa matches already linked to a candidate fixture.
- **Results are canonical.** Authoritative scores come from final API-Football fixtures, never from bookmaker pages (BetPawa reports 0-0 and Betika null for upcoming games). Completed matches are excluded from further odds refreshes.
- **Deep stats accumulate fetch-once.** Statistics, lineups, events, team history (last-N + full head-to-head) and league standings are fetched at most once per fixture and never refetched or deleted.
- **Pre-match snapshots freeze at kickoff.** `fixture_prematch` rows (rank, form, H2H, rolling-goals aggregates) are upserted while a fixture is upcoming and never written after kickoff — historical pre-match stats stay exactly as they were, unaffected by later matches.
- **Vanished odds markets are kept, flagged stale** — the last-seen price survives for display (greyed in the UI) and revives if the market is re-listed.

Only correlated records are visualized. Architecture details live in `CLAUDE.md`; phase-by-phase progress in `implementation-plan.md`; hard-won lessons in `docs/memory-bank.md`.

## Providers

- **API-Football** - root data provider via REST API *[v3.9.3](https://www.api-football.com/documentation-v3)* service. Credentials can be found in the `.env` file.

- **[BetPawa](https://betpawa.co.ke)** - Bookmaker 1, odds market data provider via undocumented public API data scraping *(see `./src/betpawa.js`)*.
- **[Betika](https://betika.com)** - Bookmaker 2, odds market data provider via undocumented public API data scraping *(see `./src/betika.js`)*.

## Setup

```sh
npm install
cp .env.example .env    # fill in MySQL (DB_*) and API-Football (X_APISPORTS_*) credentials
npm run migrate         # forward-only knex migrations
```

## Commands

```sh
npm run start [-- days]             # DEFAULT full pipeline: fixtures + odds for today..+3 days
                                    # (`npm run start -- 5` overrides), then results, link, stats,
                                    # standings, team history, pre-match snapshots

node src/index.js betpawa [date]    # scrape BetPawa odds → DB, then auto-link
node src/index.js betika [date]     # scrape Betika odds → DB, then auto-link
node src/index.js fixtures [date]   # API-Football fixtures for date → DB, then auto-link
node src/index.js results           # refresh unfinished past-kickoff fixtures; settle scores
node src/index.js link [provider]   # correlate bookmaker matches ↔ canonical fixtures
node src/index.js stats             # statistics + lineups + events for final correlated fixtures
node src/index.js standings         # refresh league tables for correlated leagues
node src/index.js history           # backfill team last-N + head-to-head for upcoming fixtures
node src/index.js prematch          # upsert pre-match snapshots (frozen once kickoff passes)
node src/index.js export [date]     # temp CSV of the date's correlated records → tmp/

npm run serve                       # visualization API server on :3001 (serves web/dist when built)
npm run build:web                   # build the React frontend → web/dist/
cd web && npm run dev               # frontend dev server on :5173 (proxies /api/* → :3001)

npm test                            # offline node:test suite (no DB / live APIs)
```

`[date]` defaults to today; accepts anything `new Date()` parses, or `today`/`now`.

**Automation:** a Windows Task Scheduler task `oddspro-pipeline` runs `scripts/pipeline-task.cmd`
(the full sweep) daily at 08:00, appending to `logs/pipeline.log` (gitignored). Manage it with
`schtasks /query|/change|/delete /tn oddspro-pipeline`.

**cPanel deployment:** see `docs/DEPLOYMENT.md` for the shared-hosting deployment guide
(manual build-and-upload, no SSH and no `deploy` branch required).

## Web UI

`npm run serve` + `npm run build:web` serve a React 19 / Vite 6 / Tailwind 4 datatable on :3001:

- Paginated, multi-sort (shift-click chains) datatable of the focused date's correlated records: odds market columns (1, X, 2, 1X, X2, 12, U/O 0.5–6.5) alongside score, goals, status, rank/form, H2H and rolling-goals pre-match stats, and dynamically discovered post-match STATS columns.
- Date navigation (Today / prev / next) with a per-date **Refresh** button that re-fetches fixtures, results and odds for the focused date in the background.
- Settings modal: multi-select market and STATS columns (defaults pre-selected, persisted in localStorage); advanced filter query builder.
- Freshness tooltips per row; stale market prices greyed; matches with no live markets (or concluded) render unlinked unless re-enabled per provider in Settings.
