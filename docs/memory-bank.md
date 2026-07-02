# oddspro — Memory Bank

Project goals, standards, and hard-won lessons. Keep updated when major issues are resolved.

## Goals & state (2026-07-02)

- MySQL data warehouse: bookmaker odds (BetPawa, Betika) + API-Football canonical fixtures/results/stats, correlated via fuzzy matching with learned aliases. Spec: `README.md`; progress: `implementation-plan.md`.
- Phases 1–5 built, verified, committed. Phase 6 (visualization: market mapping → temp CSV export → API :3001 + React datatable) not started.
- Pending verification: full stats path (statistics/lineups/events rows) — run `node src/index.js results` then `stats` after today's correlated matches finish.
- Alias fast-path exercise pends the next day's fresh matches.

## Resolved issues (do not re-learn these)

1. **`_batch` race (src/utils.js):** originally resolved when the queue emptied while up to N tasks were still in flight — callers got partial arrays ("Found 37" vs 47 saved; old x-*.json dumps may contain holes/nulls). Fixed: resolve only when queue empty AND pending === 0.
2. **`_batch` crash bug:** catch handler called bare `warn()` → ReferenceError on any batch failure. Fixed to `console.warn` during extraction to utils.js.
3. **InnoDB gap-lock deadlocks:** parallel delete+insert transactions on the same table (standings, fixture stats) deadlock on unique-index gap locks. Rule: DB-writing `_batch` workloads run at concurrency 1.
4. **Timezone skew:** datetimes are stored as EAT wall-clock; MySQL server runs UTC. Session `time_zone` pinned to +03:00 via knex pool `afterCreate` (knexfile.js) so `NOW()` comparisons are correct. Fixtures fetched with `timezone=Africa/Nairobi`.
5. **zod vs live API:** api-sports fields go null unexpectedly (`league.round`). Keep response schemas tolerant: `.nullable().optional()` on anything not structurally essential.
6. **Correlation scoring lessons:** competition-name similarity must be a bonus, never a veto (identical team names were rejected at 0.816 when weighted 0.2); initialisms (BFA), token reordering (Flora Tallinn), reserve markers (II ≡ B), and club-type prefixes (JK/NK/US/AS/CS/CR/RS) all need explicit handling. Scorer = best-of(bigram dice, token-set dice, 0.9×overlap coefficient, initialism).

## Environment facts

- `.env` uses Laravel-style DB names: `DB_DATABASE`, `DB_USERNAME` (not DB_NAME/DB_USER), plus `DB_CHARSET`/`DB_COLLATION`.
- MySQL runs in Docker, reachable at 127.0.0.1:3306 (client seen as 172.19.0.1). On connection failure: halt and let the user resolve (global rule).
- API-Football plan is high-volume (~150k requests/day) — quota is not a practical constraint, but the quota guard (`APISPORTS_MIN_REMAINING`) stays.
- Tuning knobs: `LINK_MIN_CONFIDENCE` (.env, default 0.85); weights/margin in `src/link.js` `_confidence()`.
