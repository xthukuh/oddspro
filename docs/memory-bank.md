# oddspro — Memory Bank

Project goals, standards, and hard-won lessons. Keep updated when major issues are resolved.

## Goals & state (2026-07-03)

- MySQL data warehouse: bookmaker odds (BetPawa, Betika) + API-Football canonical fixtures/results/stats, correlated via fuzzy matching with learned aliases. Overview: `README.md` (rewritten 2026-07-03 as an accurate project README); progress: `implementation-plan.md`; architecture: `CLAUDE.md`.
- **Phases 1–10 built, verified, committed.** 1–5: warehouse schema, odds persistence, API-Football ingestion, fuzzy linking with alias learning, deep stats + standings. 6: visualization (`src/markets.js` registry → `export` CSV → `src/server.js` API :3001 → `web/` React 19/Vite 6/Tailwind 4 datatable). 7: `npm run start` default full pipeline (`src/pipeline.js`, today..+3 days, fewest-hits ordering). 8: focused-date web refresh button (`runDateRefresh` + single-slot `/api/refresh` job; CSRF header guard + loopback-only bind). 9: `npm test` offline harness + stale-odds retention (`odds_markets.is_stale`, diff instead of delete+insert) + compact datatable (status column, rainbow fixture tints, freshness tooltips, unavailable-match unlinking). 10: frozen pre-match snapshots (`fixture_prematch`, `kickoff > NOW()` selection IS the freeze) + fetch-once team-history backfill + rolling-goals columns via pure `src/db/prematch-calc.js`.
- Post-phase-10: user commit `602ed3c` added web header date navigation (Today/‹/›, min 2026-07-02, max +7 days, noon-anchored date math).
- Live checks closed 2026-07-03 (read-only DB evidence): **stats path** — statistics 252 rows/12 fixtures, lineups 7/4, events 387/35; **snapshot freeze** — 12 concluded fixtures, 0 snapshots written post-kickoff, 3 already diverge from moved live standings (fixture 1520753: frozen rank 13/DLWWW vs live 9/WDLWW).
- Still open: alias fast-path observation (high "via alias" counts) on the next fresh `npm run start` — cache stands at 1,475 team + 132 league aliases.

## Resolved issues (do not re-learn these)

1. **`_batch` race (src/utils.js):** originally resolved when the queue emptied while up to N tasks were still in flight — callers got partial arrays ("Found 37" vs 47 saved; old x-*.json dumps may contain holes/nulls). Fixed: resolve only when queue empty AND pending === 0.
2. **`_batch` crash bug:** catch handler called bare `warn()` → ReferenceError on any batch failure. Fixed to `console.warn` during extraction to utils.js.
3. **InnoDB gap-lock deadlocks:** parallel delete+insert transactions on the same table (standings, fixture stats) deadlock on unique-index gap locks. Rule: DB-writing `_batch` workloads run at concurrency 1.
4. **Timezone skew:** datetimes are stored as EAT wall-clock; MySQL server runs UTC. Session `time_zone` pinned to +03:00 via knex pool `afterCreate` (knexfile.js) so `NOW()` comparisons are correct. Fixtures fetched with `timezone=Africa/Nairobi`.
5. **zod vs live API:** api-sports fields go null unexpectedly (`league.round`). Keep response schemas tolerant: `.nullable().optional()` on anything not structurally essential.
6. **Correlation scoring lessons:** competition-name similarity must be a bonus, never a veto (identical team names were rejected at 0.816 when weighted 0.2); initialisms (BFA), token reordering (Flora Tallinn), reserve markers (II ≡ B), and club-type prefixes (JK/NK/US/AS/CS/CR/RS) all need explicit handling. Scorer = best-of(bigram dice, token-set dice, 0.9×overlap coefficient, initialism).
7. **`_date()` Date-instance bug (src/utils.js):** a valid `Date` argument short-circuited the single boolean chain and fell through to `new Date()` — every value became "now". Latent until Phase 6 because all earlier callers passed strings; mysql2 returns DATETIME columns as `Date` objects. Fixed 2026-07-02 with a dedicated ternary arm for valid Dates.
8. **Market identity:** map provider odds to canonical columns by `type_name`, never `type_id` — betika reuses `type_id` 19 across different team-total markets ("Z.PSV TOTAL" vs "ZWC.BELGIUM TOTAL"). Verified spellings live in `src/markets.js`.
9. **Pre-match bookmaker scores are garbage:** BetPawa reports 0-0 and Betika null for upcoming games — visualization/export only surface score/goals when the fixture status is final (`FT/AET/PEN/AWD/WO`).
10. **`Number(null) === 0` coercion trap:** a `param = null` default made the start pipeline sweep 1 date instead of 4 — `Number(null)` is `0` (valid integer), so the "invalid → default" fallback never fired. Rule: strict-parse optional CLI/config args with `parseInt(v, 10)` (null/undefined → NaN). Caught only by a live run; `node --check` and review both passed.
11. **Standings placeholder rows:** live `/standings` data can contain rows with `team.id = null` (TBD playoff/bracket slots) — crashed zod at 60/71 leagues once the 4-day sweep widened league coverage. Skipped pre-parse (no FK target to store). Same family as lesson 5: live data keeps finding new nulls.
12. **`cmd | tee log` masks exit codes:** the first pipeline verification "passed" (exit 0) while node had actually crashed — the pipeline exit is tee's. Verify long runs by reading the output tail, or use `set -o pipefail`.

## Environment facts

- `.env` uses Laravel-style DB names: `DB_DATABASE`, `DB_USERNAME` (not DB_NAME/DB_USER), plus `DB_CHARSET`/`DB_COLLATION`.
- MySQL runs in Docker, reachable at 127.0.0.1:3306 (client seen as 172.19.0.1). On connection failure: halt and let the user resolve (global rule).
- API-Football plan is high-volume (~150k requests/day) — quota is not a practical constraint, but the quota guard (`APISPORTS_MIN_REMAINING`) stays.
- Tuning knobs: `LINK_MIN_CONFIDENCE` (.env, default 0.85); weights/margin in `src/link.js` `_confidence()`.
