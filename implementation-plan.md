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
- NOTE: zod caught `league.round` = null on live data (schema fixed) — keep schemas tolerant on nullable fields
- [x] Commit

## Phase 4 — Match linking (revised per 2026-07-02 README: fixtures = canonical base)
- [x] Name normalizer + fuzzy similarity scorer with `LINK_MIN_CONFIDENCE` threshold (default 0.85)
- [x] `link` action, provider order **betpawa → betika** (betika also scores against linked betpawa records; kickoff ±30min window; competition/league similarity included)
- [x] `team_aliases` + `league_aliases` learning + auto-link after odds/fixtures ingestion
- [x] Scorer iteration after live near-miss review: best-of(bigram dice, token-set dice, 0.9×overlap coefficient, initialism match); reserve markers II≡B≡2; club-type prefixes (JK/NK/US/AS/CS/CR/RS...) as noise; competition = corroborating bonus (+0.1×sim) never a veto; 0.05 runner-up margin guard
- [x] Verify: betpawa 26/47 (55%), betika 29/164 (18% — most unmatched lack an API-Football fixture that day); 14/14 spot-checks correct incl. initialism/word-flip/reserve cases; 55 links → 31 distinct fixtures (cross-bookmaker convergence); 110 team + 29 league aliases learned. Alias fast-path exercise pends next day's fresh matches.
- NOTE: tuning knobs for user: `LINK_MIN_CONFIDENCE` (.env), weights/margin in `src/link.js` `_confidence()`. Alias cache growing as designed: 1,475 team + 132 league aliases by 2026-07-03
- [x] Commit

## Phase 5 — Deep stats & standings
- [x] `stats` action — statistics + lineups + events per final correlated fixture (fetch-once flags; empty responses only flagged 48h post-kickoff; serial DB writes)
- [x] `standings` action — per league/season on correlated fixtures; delete+replace rows; teams upserted for FK safety
- [x] Deadlock fix: `_batch` concurrency 1 for delete+insert transaction workloads (parallel workers deadlocked on InnoDB index gap locks)
- [x] Verify: standings 204 rows / 15 league-seasons, re-run idempotent (204 again), 3 table-less comps skipped; stats action correctly targets 0 fixtures at 6:45 AM (nothing final+correlated yet) with 0 API calls
- [x] Full stats-path live check VERIFIED 2026-07-03: `fixture_statistics` 252 rows / 12 fixtures (9 stat types each), `fixture_lineups` 7 rows / 4 fixtures, `fixture_events` 387 rows / 35 fixtures — rows land once leagues publish; fetch-once flags match (12/4/35)
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

## Phase 7 — Default `npm run start` pipeline (added 2026-07-02)
- [x] `src/pipeline.js` — `runStartPipeline(days)`: full sweep today..+N days (default 3), ordered for fewest server hits: fixtures per date → results → betpawa/betika odds per date → link once → stats → standings; `[start k/7]` step banners
- [x] `src/index.js` — no action / `start [days]` / bare number (`npm run start -- 5`) dispatches the pipeline
- [x] `src/db/store.js` — `completedMatchIds(provider, from)`: exclusion set so scrapers skip per-game detail requests for completed matches (saveMatches would discard them anyway); wired into pipeline AND single betpawa/betika actions
- [x] `src/utils.js` `_progress()` helper — periodic `n/total` logs in the scraper detail batches and the deep-stats batch
- [x] Fewer-hits ordering: date-scoped fixtures fetch refreshes today's statuses first (shrinks results' per-id refresh set); results completes matches BEFORE odds scrapes; link runs once instead of 12 auto-link passes
- [x] BUGFIX (caught in live run 1): `Number(null) === 0` made the default sweep 1 date instead of 4 — switched to `parseInt` (null/undefined → NaN)
- [x] BUGFIX (caught in live run 2): standings rows with `team.id = null` (TBD playoff/bracket placeholder slots) crashed zod validation at 60/71 leagues — such rows are now skipped pre-parse (no FK target to store anyway)
- [x] Verify: live `npm run start` end-to-end — 4-date sweep (fixtures 111/203/570/276), results settled 6, betpawa 37+126+161+104 games, betika 168+138+244+108, single link pass (betpawa 268 + betika 319 fuzzy-linked), stats fetch-once, standings 71 league/seasons → 1116 rows; quota-guarded throughout (~149.8k remaining)
- [x] Update `CLAUDE.md` (commands + architecture entry for `src/pipeline.js`)
- [x] Commit

## Phase 8 — Focused-date refresh button (added 2026-07-02)
- [x] `src/pipeline.js` `runDateRefresh(date, onStep)` — single-date subset: fixtures → results (skipped for future dates) → betpawa/betika odds (completed-exclusion) → link once → deep stats (skipped for future dates); standings stays owned by the full sweep; `onStep` narrates progress
- [x] `src/server.js` — `POST /api/refresh?date=YYYY-MM-DD` starts a single-slot background job (400 bad date, 409 + in-flight job when busy — parallel refreshes would deadlock on delete+insert gap locks); `GET /api/refresh` poll endpoint
- [x] `web/src/api.js` — `startRefresh()` (409 resolves to the in-flight job), `fetchRefreshStatus()`
- [x] `web/src/App.jsx` — Refresh button beside the date picker: disabled without a focused date, amber + live step label while running, 2s polling, table reload on completion, picks up an in-flight refresh on page load
- [x] Verify: endpoints via curl (idle/400/202/409); live browser flow via Playwright — click → "Refreshing 2026-07-02 — betika odds…" → idle + table reload in ~45s, 0 console errors; empty date disables the button; today-refresh cost only 9 betpawa + 127 betika detail hits (completed games pre-excluded), settled 14, stats for 8 fixtures
- [x] NOTE: stale pre-change `node src/server.js` (PID 19088) held :3001 and 404'd the new endpoints — killed and restarted with new code; server restart required after pulling these changes
- [x] Commit
- [x] Security hardening (post-review finding: CSRF/unauthenticated state-changing endpoint): `POST /api/refresh` requires `X-Requested-With` header (custom headers force a CORS preflight the server never approves — kills cross-site POSTs); server binds `API_HOST` (default `127.0.0.1`, LAN exposure now opt-in). Verified: 403 without header, 400 with header+bad date (no scrape burned), loopback-only bind via netstat, button flow re-verified in browser (31s refresh, 0 console errors)

## Phase 9 — Freshness, stale odds & compact datatable (added 2026-07-02)
- [x] Test harness FIRST (safeguard before behavior changes): `npm test` = `node --test "tests/*.test.js"` — `tests/markets.test.js` (canonical mapping incl. type_name-never-type_id invariant + whereMarket SQL via disconnected knex builder), `tests/snapshots.test.js` (zod contract of the standardized game record over the frozen `x-*-output.xx.json` scraper outputs; legacy null holes filtered — live `_batch` rejects on error), `tests/diff-odds.test.js` (all stale-diff scenarios)
- [x] Migration `20260702000002_odds_markets_stale_flag.js` — `odds_markets.is_stale` (default false; existing rows read fresh, no backfill)
- [x] `src/db/odds-diff.js` (pure, zero imports) — `oddsIdentity` (type_name/name/handicap, numeric handicap normalization: mysql2 DECIMAL strings vs snapshot numbers, NUL delimiter) + `diffOddsRows` → `{staleIds, deleteIds}`
- [x] `src/db/store.js` — diff-based odds refresh replaces blanket delete+insert (vanished markets kept flagged stale, re-listed markets revive); explicit `updated_at: db.fn.now()` on the matches UPDATE (ON UPDATE CURRENT_TIMESTAMP skips no-op updates). Verified live: 2 consecutive betika scrapes, row totals stable (no identity-mismatch duplication), only genuine churn flagged (14→104 stale)
- [x] `src/db/records.js` — rows gain `updated_at`, `markets_stale` (fresh-shadowed keys stripped), `available` (`!TERMINAL_STATUSES(status) && !completed_at && freshCount > 0`; TERMINAL = RESULT + CANC/ABD); market sort/filter pivots exclude stale; `status` moved out of STAT_COLUMNS
- [x] `src/export.js` — `status` column after `goals` (CSV parity with the UI)
- [x] `web/` — Status base column right of Goals; rainbow row tints cycled per `api_id` (same fixture across providers shares a tint); row `title` freshness tooltip; stale prices greyed slate-400 + "No longer offered"; unavailable matches unlinked ("Betting unavailable") with per-provider Settings re-enable toggle (`oddspro.links.unavailable`, default off — betpawa serves concluded pages ~6h); persisted column keys sanitized against the catalog; compact `text-xs` + tighter padding; self-hosted Inter Variable (`@fontsource-variable/inter`, Tailwind `@theme --font-sans`); navbar Date label dropped
- [x] Verify: `npm test` 14/14; migration on populated DB (274k rows fresh); live double-scrape store round-trip; API fields + market-sort via curl; CSV header; full browser pass via Playwright (columns, tints, tooltips, stale cell, unlink + toggle, settings sections, 0 console errors); temp stale flags reverted
- [x] NOTE: stale pre-change `node src/server.js` (PID 17244) held :3001 — killed and restarted with new code (recurring: restart server after backend changes)
- [x] Commits: `test:` harness → `feat:` stale retention (store) → `feat:` read layer → `feat:` frontend → `docs:` this update

## Phase 10 — Historical pre-match snapshots + rolling-goals columns (added 2026-07-02)
- [x] TDD first: `tests/prematch-calc.test.js` (11 tests, offline) written and watched fail before the module existed — h2hSummary parity (orientation both venues, strict kickoff cutoff, null-score skip), computePrematch (window caps, opponent exclusion, venue-oriented gf/ga, h2h_count beyond window, empty history), formatGoals
- [x] `src/db/prematch-calc.js` (pure, zero imports) — `h2hSummary` moved verbatim from records.js `_h2hSummary`; `computePrematch` (pair-level H2H window + per-side vs-others window); `formatGoals` → `"8/5 (2.6)"`
- [x] Migration `20260702000003_prematch.js` — `fixtures.history_fetched_at` (fetch-once flag) + `fixture_prematch` table (typed columns keyed by fixture_id, FK CASCADE)
- [x] Config: `PREMATCH_TEAM_WINDOW` / `PREMATCH_H2H_WINDOW` (default 5/5) in `src/config.js` + `.env.example`
- [x] `fetchApisportsHistory()` (apisports.js) — per upcoming correlated fixture: 2× `/fixtures?team=&last=` + 1× `/fixtures/headtohead` (no `last` → true all-time meeting count); items filtered to FINAL_STATUSES pre-save (future h2h meetings must not leak into the results refresh set); saved via `_saveFixtureItems` upserts (never deletes); per-run team dedupe Set; serial batch
- [x] `src/prematch.js` `updatePrematchSnapshots()` — upsert `fixture_prematch` for upcoming correlated fixtures; `kickoff > NOW()` selection IS the freeze; single-statement chunked `onConflict().merge()` (no delete+insert)
- [x] Pipeline: `runStartPipeline` steps 8 (history) + 9 (prematch) after standings (snapshot needs local history + fresh rank/form); `runDateRefresh` gains both for today/future dates; CLI actions `history` / `prematch`
- [x] Read layer (records.js): snapshot-preferred merge (presence of row wins wholesale — null snapshot rank ≠ fall back to live standings); live derivation fallback for pre-feature fixtures; new STAT_COLUMNS `h2h_count`, `home/away_goals_h2h`, `home/away_goals_oth` (display-only, snapshot-only); zero frontend changes (catalog-driven)
- [x] Verify: `npm test` 25/25; migration on populated DB; live `history` run — 332 fixtures, 9,417 historical fixtures backfilled (~1,150 requests, quota 148,846 left); `prematch` — 332 snapshots, re-run idempotent; spot-check (332/332 full 5-game windows, 295 with H2H, e.g. Trans Narva–Levadia 65 meetings "5W-14D-46L"); read layer serves compact strings per provider pair; 0 snapshots on past fixtures
- [x] Live freeze check VERIFIED 2026-07-03: 12 concluded fixtures hold snapshots, 0 written after kickoff, 3 already diverge from the moved live standings (e.g. fixture 1520753: frozen home rank 13 / form DLWWW vs live rank 9 / WDLWW) — the freeze holds while the world moves
- [x] Docs: CLAUDE.md (commands, architecture, invariants) + this checklist
- [x] Commit

## Post-phase-10 touches
- [x] 2026-07-03 user commit `602ed3c`: web header date navigation — `[OP]` branding, Today / ‹ prev / next › buttons, date picker bounds (min `2026-07-02`, max +7 days), noon-anchored date math (avoids UTC day-shift), `showPicker()` on focus/click, cursor-pointer polish
- [x] 2026-07-03 retrospective: remaining live checks closed with read-only DB evidence (stats path, snapshot freeze — see §5/§10); README rewritten from spec-draft to accurate project README; memory-bank goals synced to phases 1–10. Warehouse health at check time: 9,704 fixtures, 2,009 bookmaker matches (betpawa 345/510 linked, betika 400/1499), 384 frozen snapshots, 389,500 odds rows (993 stale)
- [~] Alias fast-path live observation, refined 2026-07-03 after a fresh sweep showed `0 via alias`: forensic check (matches linked today vs aliases created before today) proved all 91 of the day's new links were fuzzy because 85/91 involved never-seen team names — teams recur weekly, not daily, so a 2-day-old cache can't hit yet. Mechanism verified correct (raw-name exact Map lookup precedes fuzzy scoring in `src/link.js`; 193 aliases learned today, cache ~1,668 team + 132 league). Expect first "via alias" counts ~2026-07-08+ when 07-02's teams play again. The 142/543 "examined, unmatched" leftovers are chronic sub-threshold near-misses (0.50–0.85) with no fixture or too-different names — permanent residents until threshold tuning

## Phase 11 — Automation & prediction scoping (added 2026-07-03)
- [x] Windows Task Scheduler task `oddspro-pipeline` → `scripts/pipeline-task.cmd` (cd to repo, `npm run start`, append `logs/pipeline.log`), daily 08:00. Smoke-tested via `schtasks /run`: all 9 steps, exit 0, 0 errors, 227k+ odds rows saved, 19 newly-listed betika matches picked up
- [x] `docs/prediction-scoping.md` — prediction-phase scoping draft: warehouse offerings (frozen snapshots = leak-free features, closing odds = baseline), two dataset strategies, 7 open questions. NOT approved for implementation — awaits brainstorm with user

## Phase 12 — Over 2.5 hot picks 🔥 (rule-based, added 2026-07-03)
- [x] Design: logical deduction only (no ML) — strict AND concurrence gates over leak-free history aggregates + BetPawa vig-removed implied probability + API-Football `/predictions` boost/veto + optional OpenRouter AI adjudicator (env-gated, fail-open). Spec: `C:\Users\User\.claude\plans\` plan file; supersedes the Python/XGBoost direction in `docs/prediction-scoping.md`
- [x] Migration `20260703000001_hotpicks.js` — `fixtures.predictions_fetched_at` (fetch-once flag) + `fixture_api_predictions` (API evidence, raw json kept) + `fixture_predictions` (pick ledger: hot/score/signals/prices/ai_verdict/outcome, PK fixture_id)
- [x] `src/db/goals-rules.js` (pure, zero imports) — `impliedProbability` (two-way devig), `teamGoalsAggregates`/`h2hGoalsAggregates` (kickoff-cutoff, vs-others semantics), `apiPredictionSignal` (signed under_over line → support/contradict/neutral), `scoreOver25` (strict AND gates + composite confidence score + signals audit trail)
- [x] TDD: `tests/goals-rules.test.js` — 15 tests (devig, cutoffs, windows, each gate independently, H2H veto thinness, API neutrality, requireMarket backtest mode, boundary values). `npm test` 40/40
- [x] Backtest `scripts/backtest-hotpicks.js` — 10,678 finished fixtures replayed with kickoff cutoffs, 100-combo grid; baseline over-2.5 rate 54.3%, shipped defaults (window 7, over-rate ≥0.6, avg-total ≥3.2) = 73.2% stats-only precision (358 flagged); market/API gates only tighten go-forward
- [x] `fetchApisportsPredictions()` (apisports.js) — fetch-once `/predictions` per upcoming correlated fixture; live run 409/409 saved, rerun 0 targets (idempotent)
- [x] `src/hotpicks.js` `updateHotPicks()` — settle (canonical FT → hit/miss, owned by settle pass) → evaluate ALL upcoming correlated snapshot-backed fixtures (non-hot rows kept as calibration ledger) → AI adjudication (verdict reuse when score unchanged = no re-billing; veto flips hot, never promotes; error keeps rule verdict) → chunked onConflict merge upsert; `kickoff > NOW()` selection IS the freeze. `hotpicksSummary()` for the web chip
- [x] AI adjudicator `src/ai.js` (OpenRouter, `HOTPICK_AI_MODEL` default gpt-4o-mini) — first prompt over-vetoed (37/37, citing thin-H2H/threshold-edge non-reasons); rewritten with named red-flag criteria + full aggregates → 16 confirmed / 21 vetoed with substantive reasons
- [x] Config: `HOTPICK_*` thresholds (defaults imported from goals-rules — no drift) + `OPENROUTER_API_KEY`/`OPENROUTER_URL`/`HOTPICK_AI_MODEL` in `src/config.js` + `.env.example`; real key in gitignored `.env` only
- [x] Pipeline steps 10 (predictions) + 11 (hotpicks), `STEPS = 11`; `runDateRefresh` gains both for today/future dates; CLI actions `predictions` / `hotpicks`
- [x] Read layer: `fixture_predictions` LEFT JOIN (1:1, count-safe) → row fields `hot`/`hot_score`/`hot_outcome`/`hot_reason`/`hot_signals`; `hot`+`hot_score` in BASE_FIELDS (sortable/filterable, FilterBuilder picks them up automatically); `GET /api/hotpicks` summary endpoint
- [x] Web: 🔥 badge on fixture cell (🔥✓/🔥✗ once settled, tooltip = AI reason or signal audit), header accuracy chip (30d hit-rate, else pending count); `npm run build:web` clean
- [x] Verify: migration on populated DB; backtest table prints; predictions fetch-once; hotpicks idempotent (16 hot stable across reruns); server endpoints + `hot eq 1` filter live-checked via browser (badges + chip render); orphan-free (verify server stopped)
- [ ] Settlement observation (~2026-07-04+): first picks settle → hit/miss populate, chip switches from "16 pending" to a hit-rate; confirm frozen picks never rewritten post-kickoff

## Phase 12b — "Tip" column + completed-games toggle (added 2026-07-03)
- [x] Migration `20260703000002_tips.js` — `fixture_predictions` += `tip_market/tip_price/tip_confidence/tip_outcome` (tip_outcome owned by settle, like outcome)
- [x] `src/db/tip-rules.js` (pure, zero imports) — `teamOutcomeAggregates`/`h2hOutcomeAggregates` (W/D/L + per-line over rates), `bestTip` (safest bettable outcome across 1X2/DC/all O/U lines; confidence = devigged market 0.6 + stats 0.3 + API percents 0.1, renormalized; DC probs derived from the devigged 1X2 book; price floor `TIP_MIN_PRICE` 1.2 excludes junk odds — the hidden-gem mechanic; `TIP_MIN_CONFIDENCE` 0.5 floor), `tipHit` (settles any canonical market)
- [x] Tests `tests/tip-rules.test.js` — 13 tests (aggregates, devig, price floor, DC derivation, stats corroboration both directions, thin-sample neutrality, O/U complement, API blend, floors, tipHit matrix). Suite 53/53
- [x] Writer: `_loadMarkets` generalizes odds loading to all canonical groups via `marketKey` (per-group provider preference — no cross-provider devig); tips computed beside hot gates; tip settle pass (pure tipHit, grouped whereIn updates); PICK_COLUMNS extended
- [x] Read layer: `tip` base column (sorts/filters by `fp.tip_confidence`) + `tip_*` row fields; web `Tip` column right of Goals (`🔥 O 2.5 · 74%` style, ✓/✗ once settled, price in tooltip)
- [x] "Show completed games" settings toggle (default on): `queryRecords({completed:false})` → `?completed=0` → localStorage `oddspro.show.completed`; hides terminal-status fixtures + completed matches
- [x] Verify: 53/53 offline; live run 393 evaluated / 388 tips / 16 hot unchanged (AI verdicts reused); healthy tip spread (13 markets, conf 50–84%, `12`/`O 1.5`/`U 3.5-4.5`/DC dominate); HTTP 205→117 rows with completed=0; browser-checked Tip column + toggle; stale :3001 server restarted (pid 20960 left serving)

## Phase 12c — Web UX round (added 2026-07-03, user change requests)
- [x] Missed tips render red (whole tip text + ✗; hits keep the calm ✓)
- [x] Frozen odds greyed: `available === false` (concluded / no live markets) greys ALL the row's prices like stale ones ("Frozen - betting unavailable" tooltip)
- [x] Providers future-proofed: `columnCatalog()` discovers `providers` from `matches`; "Visible providers" multi-select filters rows server-side (`?providers=a,b`); localStorage `oddspro.providers.visible` (null = all known, so newly-integrated bookmakers appear automatically)
- [x] Settings modal redesigned: three sections (Table columns / Providers / Behavior) with compact `MultiSelect.jsx` dropdowns (count summary button → checkbox panel with Defaults/All/None) replacing the checkbox grids
- [x] Pagination removed: `per_page='all'` in queryRecords (CSV export still pages at 500), whole selected date rendered at once, record-count footer, `Pagination.jsx` deleted
- [x] Column reordering: drag pills in settings (HTML5 DnD, drop inserts before target, Reset order), `applyOrder` + `BASE_COLUMNS` exported from DataTable, order persists in `oddspro.cols.order`
- [x] Verify: 53/53 offline; API checks (205 rows unpaged, betpawa-only 102, catalog providers); browser-checked modal, frozen-grey FT rows, saved order `[fixture, tip, start_time]` renders first; server restarted (pid 11584)

## Phase 12d — Web UX round 2 (added 2026-07-04, user change requests)
- [x] Navbar decluttered: hot-picks accuracy chip removed entirely (`fetchHotpicks` + state/effect/memo deleted; row-level 🔥 badges remain); date-picker calendar icon inverted via `.date-input-dark::-webkit-calendar-picker-indicator` (was near-black on the dark navbar)
- [x] Client-side sorting for EVERY column, descending first (desc → asc → off; shift-click multi-sort kept): new `web/src/sortValues.js` registry — form "WWDLW"→points (W3/D1), h2h "2W-1D-0L"→points, rolling-goals "gf/ga (avg)"→parsed avg (format cross-referenced with `formatGoals`), score→total goals, `fs:*` "H / A"→sum, tip→confidence + (hot ? 1 : 0) so 🔥 picks top desc, nulls always last; `sort` param dropped from `fetchRecords` (header clicks never hit the network; server sort untouched for CSV)
- [x] New columns: `Updated`/`Locked` base timestamp columns (row `locked_at` = `m.completed_at` surfaced; both in BASE_FIELDS → filterable), `Season`/`Round` stat columns beside League (`f.round` newly selected; both default on, so also in CSV)
- [x] Per-column cell tooltips (`CELL_TITLES` registry; row-level "Updated …" title removed): API ID → canonical `fixture_api` name (new `teams` join) + league·season·round; Score → start/teams+goals/timestamp; Goals → split score+timestamp; H2H+Meetings → recent matchup list from new `h2h_meetings` row field (derived from the already-fetched H2H rows, `h2hSummary` rules, newest-first, capped 10, "+N more"); Status → glossary; headers → definitions + abbreviated labels (`ID`, `Mtgs`, `H:GvO`…) via `HEADER_META`
- [x] Sticky chrome: scroll container `overflow-auto max-h-[calc(100vh-8.5rem)]`; header row `sticky top-0` and Score column pinned first + `sticky left-0` (backgrounds/edge shadows on the sticky cells — opaque tints cover scrolled-under content, `group-hover` tracks row hover)
- [x] Rainbow tints → two alternating tones (`bg-white`/`bg-slate-100`) per canonical fixture group; enabled-but-empty market/stat columns omitted from render (base columns always show)
- [x] Date survives refresh via URL (`?date=YYYY-MM-DD`, `?date=all` for cleared view, clean path for today; lazy init + `popstate` for back/forward; `changeDate` wraps all navigation)
- [x] FilterBuilder: rows right-justified (`justify-end`), Enter applies, and column-to-column comparisons — `val`/`col` RHS toggle swaps the value input for a column select; wire shape `{key, op, col}` resolved server-side via `_sqlTarget` with identifier binding (`??`), `like`+col rejected 400
- [x] Verify: 53/53 offline; build clean; temp :3999 server smoke — row carries `locked_at/season/round/fixture_api/home_team/away_team/h2h_meetings` (≤10), `1 lt col 2` → 119/205 rows (0 violations), bad col / like+col → 400; Playwright-driven UI — desc-first cycle, 🔥-topped Tip sort, nulls last, 0 extra network on sort, sticky both axes (geometry + screenshot), two-tone rows, URL round-trip incl. back/forward, filter col-mode applied `1 < 2` → 57 records; temp server killed (orphan-free)

## Issues / notes
- 2026-07-02: MySQL (Docker, reachable via 127.0.0.1:3306, client seen as 172.19.0.1) denied `root` with empty password. Halted per DB-connection-failure rule. RESOLVED: user added credentials to `.env` (Laravel-style names: `DB_DATABASE`/`DB_USERNAME`/`DB_CHARSET`/`DB_COLLATION`) — config.js/knexfile.js aligned to those names.
- 2026-07-02: README rewritten with fuller spec → plan revised: fixtures = canonical base; betpawa→betika correlation order; fuzzy confidence matching + `league_aliases` cache table (added to init migration pre-first-run); Phase 6 visualization added (temp CSV export → API + React datatable).
