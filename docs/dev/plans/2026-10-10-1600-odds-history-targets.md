# Plan: odds history, target snapshots and the due-queue (2026-10-10)

Spec: `docs/dev/specs/2026-10-10-1600-odds-history-targets.md`. Each step is tested before
the next; `X_APISPORTS_KEY=placeholder npm test` stays green throughout (baseline 1266).

## Steps

1. **Pure rules first.**
   - `src/db/odds-diff.js`: `priceCents`, `diffOddsChanges(existing, snapshot, {baseline})`.
   - `src/db/odds-history-rules.js` (zero imports): EAT clock helpers (`eatWallClock`,
     `parseEatMs`), `observationKind`, `historyGateOpen`, `TARGETS`, `targetAt`,
     `planTargetFreezes`, `targetsPossiblyDue`, `asOfChangeId`, `replayState`,
     `kickoffMoved`, `planDueQueue`, `sweepStepAllowsDue`.
   - Tests: `tests/odds-history-diff.test.js`, `tests/odds-history-rules.test.js`.
2. **Migration** `20261010000003_odds_history.js` (three tables, forward-only).
3. **Knobs**: `src/config.js` defaults + `src/db/settings-rules.js` catalog entries (group
   `refresh`).
4. **Change log write path**: `src/odds-history.js` (DB clock offset, last-observation
   prefetch, `writeObservation`, `materializeTargets`, `oddsHistoryPayload`); `store.js`
   `saveMatches(games, { source })` writes observation + changes in the same transaction,
   then materializes targets best-effort.
5. **Due-queue**: per-event detail fetchers exported from `src/betpawa.js` /
   `src/betika.js` (blanket loops reuse them), `src/odds-due.js` (`dueCandidates`,
   `runDueRefresh`), wiring in `src/auto-refresh.js` (tick lane + sweep lane + light-pass
   target sweep step), `source` tags from `src/pipeline.js`.
6. **Read surface**: `odds_history` feature in `src/db/feature-rules.js`,
   `GET /api/odds-history/:matchId` in `src/server.js`.
7. **Sync tooling**: the three tables join `SYNC_TABLES` (windowed by match like
   `odds_markets`), so a local pull that cascade-deletes a window re-imports its history.
8. **Docs**: engine chapters 01/02/07, `00-README.md` triggers, `QUICK-REFERENCE.md`,
   CLAUDE.md map lines; `npm run check:prose`.

## Verification

- Offline suite (pure rules: diff table, gate, kind, freeze rows, replay, due plan, sweep
  allow-list, settings catalog, feature registry, sync plan).
- Not verifiable offline, owed on first run against a DB: the migration applies on MariaDB,
  a light pass writes observations, `materializeTargets` freezes an opening, the endpoint
  answers. Suggested smoke after `npm run migrate` locally:
  `node src/index.js betpawa` then
  `SELECT kind, COUNT(*) FROM odds_observations GROUP BY kind;` and
  `SELECT target, quality, COUNT(*) FROM odds_target_snapshots GROUP BY 1,2;`.

## Owner decisions (ranked recommendation first)

1. **Storage (23-46 GB/year estimated).** Measure `f` for two days first (spec). Then:
   (a) keep everything (simplest, most accurate, needs disk);
   (b) dictionary-encode identity (about 30% smaller, more write work);
   (c) scope the log to the canonical registry markets (1X2, DC, O/U lines; about 88%
   smaller, loses the long tail);
   (d) exclude virtual competitions. Flip `ODDS_HISTORY_ENABLED` off live if the disk
   alarm fires; the next look re-baselines.
2. **Reschedule after freeze**: keep and flag (built) versus allowing a superseding
   revision row.
3. **`ODDS_DUE_DURING_SWEEP` default on**: the safety argument is in the spec; off restores
   the strict one-writer-at-a-time rule at the cost of morning targets.
