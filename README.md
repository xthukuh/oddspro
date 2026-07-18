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

Only correlated records are visualized. Architecture details live in `CLAUDE.md`; phase-by-phase progress in `docs/dev/implementation-plan.md`; hard-won lessons in `docs/memory-bank.md`; the full docs index is `docs/README.md`.

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

**User accounts (v1.1.0):** set `PIN_PEPPER` (a long random secret) **before** `npm run migrate` — the users migration seeds an admin whose PIN (`ADMIN_SEED_PIN`, default `0000`, changed on first login) is hashed with it, and changing the pepper later invalidates every stored PIN. SMS OTP verification is off by default (`SMS_ENABLED=0` logs codes to the server console for dev); see `.env.example`.

## Commands

All commands, setup sequences, routines, health checks and critical warnings live in
**[QUICK-REFERENCE.md](QUICK-REFERENCE.md)** (the single command reference — Development §1,
Production §2). Annotated semantics: `CLAUDE.md` `## Commands`; system behavior:
`docs/engine/`. Quick start: `npm run start` (full sweep) · `npm run serve` (API :3001) ·
`npm test` (offline suite).

**Automation:** in production the always-on `npm run serve` process refreshes itself — an in-process
scheduler runs a light pass every few minutes and a full sweep once daily (`src/auto-refresh.js`;
knobs `AUTO_LIGHT_MINUTES`/`AUTO_FULL_AT`, `AUTO_REFRESH_ENABLED=0` to opt out locally). A Windows
Task Scheduler task `oddspro-pipeline` runs `scripts/pipeline-task.cmd` (the full sweep) daily at
08:00 → `logs/pipeline.log` as an optional local backup; on the host, cron is an optional backup only.

**Live / deployment:** the app is live at **[oddspro.ke](https://oddspro.ke)** (the 2026-07-12 build; the
repo is at **v1.2.0** — tagged, deploy package built, awaiting the manual upload). It runs on shared cPanel hosting with no SSH — deploys are a **manual local build +
upload** (there is no automatic deploy from `dev`/`main`). See `docs/DEPLOYMENT.md` for the full guide.

## Web UI

`npm run serve` + `npm run build:web` serve a React 19 / Vite 6 / Tailwind 4 datatable on :3001:

- Unpaginated, multi-sort (additive header clicks) datatable of the focused date's correlated records: odds market columns (1, X, 2, 1X, X2, 12, U/O 0.5–6.5) alongside score, goals, status, rank/form, H2H and rolling-goals pre-match stats, and dynamically discovered post-match STATS columns.
- **Betting predictions:** an over-2.5 **hot picks** 🔥 flag and a **Tip** column (the best-supported market per fixture across seven families — 1X2, double chance, O/U, BTTS, draw-no-bet, team totals, odd/even — with a plain-language justification popover) — both frozen at kickoff and settled from canonical final scores. A **✨ magic sort** ranks tips by backtested strategies, a **betslip playground** assembles multi-leg slips (combined odds / payout / EV), and a **🛡 Safe-only** filter cherry-picks the highest-quality legs.
- Date navigation via a custom calendar popover (prev / next / Today) and a per-date **Refresh** button; connected browsers also pick up the in-process auto-refreshes silently (scroll, sort and filters preserved).
- Settings sheet: light/dark/system theme, multi-select market/STATS columns, provider priority and column/sort reordering (persisted in localStorage); an advanced filter builder.
- Freshness tooltips per row; stale market prices greyed; matches with no live markets (or concluded) render unlinked unless re-enabled per provider in Settings. iPadOS-native look, responsive to phone.
- **User accounts (v1.1.0):** phone + 4-digit PIN sign-up with SMS OTP verification, opaque hashed sessions, profile/PIN management, and cross-device settings sync. Guests browse a limited view (no future dates, tip reasoning redacted) — signing in unlocks upcoming games and full detail. Admins get an in-app settings editor and a data-viz lab.
