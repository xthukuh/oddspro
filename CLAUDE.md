# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

oddspro fetches football bookmaker odds and stats from Kenyan bookmakers (BetPawa, Betika) via their public web APIs and normalizes them into a common record format. Plain Node.js (ES modules) with axios as the only dependency — no build step, no framework, no test suite.

## Commands

```sh
npm install                       # install dependencies (axios)
node src/index.js betpawa [date]  # fetch BetPawa games → x-betpawa-output.xx.json
node src/index.js betika [date]   # fetch Betika games → x-betika-output.xx.json
```

`[date]` is optional (defaults to today) and accepts anything `new Date()` parses, or `today`/`now`. `npm start` runs `src/index.js` with no action argument, which only prints "Unsupported action" — always pass an action directly.

There is no test suite (`npm test` exits 1) and no linter.

## Architecture

- `src/index.js` — CLI dispatcher: selects the provider by `process.argv[2]`, writes results as pretty-printed JSON to `x-<provider>-output.xx.json` at the repo root.
- `src/betpawa.js` / `src/betika.js` — one self-contained module per bookmaker. Each exports a single `fetch<Provider>Games(date)` function and deliberately follows the same internal layout:
  1. Shared helpers (`_pint`, `_date`, `_dtime`, `_batch`) — intentionally duplicated in both files; keep them in sync when editing.
  2. An axios client (`<Provider>Client`) preconfigured with browser-mimicking headers; base URL overridable via `BETPAWA_BASE_URL` / `BETIKA_BASE_URL` env vars.
  3. `parse<Provider>Game(game)` — maps the raw API payload to the standardized record (below).
  4. `fetch<Provider>Games(date)` — pages through the provider's list endpoint, then fetches per-match detail via `_batch` (10 concurrent requests, ~50ms delay between pages).

Adding a provider means creating a new `src/<provider>.js` that matches this layout and record shape, then wiring it into `src/index.js`.

### Standardized game record

Both parsers emit the same shape so downstream consumers are provider-agnostic:

`provider, match_id, match_url, start_time (YYYY-MM-DD HH:mm local), home/away team id+name, home/away scores (first half / second half / fulltime), region/category/competition id+name, markets[], metadata (raw provider JSON as a string)`

Each `markets[]` entry: `{type_id, type_name, type_explainer, name, price, handicap, probability}`.

Betika's API does not expose `home_team_id`, `away_team_id`, `region_id`, `region_name`, `category_id`, or `competition_id` — those are always `null` in Betika records.

### Date constraints

- BetPawa: rejects dates before today (returns `[]` with a warning).
- Betika: only today through +7 days (limited by the API's `period_id` mapping); anything else returns `[]`.

## Conventions

- ES modules only (`"type": "module"`); `async/await` throughout.
- 4-space indentation (set in `oddspro.code-workspace` — overrides the usual 2-space Node default), single quotes, semicolons.
- `x-*-output.xx.json` files are fetched API data snapshots — do not delete or regenerate them unnecessarily to avoid redundant API hits.
- `.env` is gitignored and holds API credentials (`X_APISPORTS_URL`, `X_APISPORTS_KEY` for api-sports.io — not yet referenced in code).
