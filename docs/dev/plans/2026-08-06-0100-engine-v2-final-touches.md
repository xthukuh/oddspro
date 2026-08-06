# Engine v2 Final Touches: Phase 0 + 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the alignment guard and the Daily MultiBet engine: walk-forward leg calibration, banker-style uncapped-odds slip construction, simulation-tuned defaults, hindsight-free backfill, settle pass, and the read API behind a premium seam.

**Architecture:** Pure zero-import decision modules in `src/db/` (calibration, slip rules, feature gate) with offline node:test coverage; a thin knex orchestrator `src/daily-slip.js` following the `src/hotpicks.js` idiom; one forward-only migration; a dual-purpose simulation/backfill script following `scripts/replay-daily2x.js`. Spec: `docs/dev/specs/2026-08-06-0100-engine-v2-final-touches-design.md`.

**Tech Stack:** Node ES modules, knex/mysql2 via `src/db/connection.js`, zod for external data, node:test.

## Global Constraints

- ES modules, async/await, 4-space indentation, single quotes, semicolons.
- `src/db/*-rules.js` modules are PURE: zero imports (other pure siblings allowed), offline-testable, no config/.env reads.
- All DB access through knex via `src/db/connection.js`; never raw mysql2.
- Migrations forward-only, utf8mb4, snake_case plural tables, `created_at`/`updated_at` on every table.
- Freeze discipline: kickoff comparisons in SQL use the `+03:00`-offset-qualified expression (`KICKOFF_SQL_EXPR` idiom from `src/db/ai-rules.js`); settled columns are owned solely by the settle pass; never rewrite a settled or past-kickoff record.
- Suite must stay green: 1036 tests at start, `npm test` offline.
- Conventional Commits. No em-dashes in any prose or doc. Honesty rule (spec decision 5): report measured numbers plainly, never curtail the experiment because of them.
- Chunked upserts with EXPLICIT merge lists (knex on MySQL silently drops `.onConflict(cols)` targeting; a bare `.merge()` rewrites every column).

---

### Task 0: Phase 0 alignment guard

**Files:**
- Create: `C:\Users\User\.claude\projects\D--Apps-lab-oddspro\memory\engine-v2-alignment-charter.md`
- Modify: `C:\Users\User\.claude\projects\D--Apps-lab-oddspro\memory\MEMORY.md` (add index line)
- Create: `docs/dev/checklists/2026-08-06-0100-engine-v2-final-touches.md`

**Interfaces:**
- Produces: the checkpoint ritual every later task ends with (one dated alignment line appended to the checklist).

- [ ] **Step 1: Write the charter memory file** with frontmatter (`name: engine-v2-alignment-charter`, `type: project`) and body: core objective (optimal top-to-bottom survivability order chained into multi-bet slips whose top few are experimentally "guaranteed"), the five locked decisions from the spec, the honesty rule verbatim (honesty reports, never limits; intention negated only by proof or owner consent), the checkpoint ritual (re-read charter + checklist at phase boundaries and before major commits, append a dated one-line alignment check), links `[[success-bar-daily-2x]]`, `[[working-posture]]`, `[[writing-style]]`.
- [ ] **Step 2: Add the MEMORY.md index line** pointing at the charter.
- [ ] **Step 3: Write the checklist file** listing every task in this plan with status `pending`, plus an `## Alignment checks` section seeded with the first dated entry.
- [ ] **Step 4: Commit** (checklist only; memory lives outside the repo): `git add docs/dev/checklists/... && git commit -m "docs(plan): engine-v2 final touches spec + plan + checklist"` (include the spec and this plan file in the same commit).

---

### Task 1: Pure calibration module `src/db/leg-calibration.js`

**Files:**
- Create: `src/db/leg-calibration.js`
- Test: `tests/leg-calibration.test.js`

**Interfaces:**
- Produces: `bandOf(price) -> string`, `groupOf(market) -> string`, `cellKey({market, price}) -> 'group|band'`, `makeCalibrator({ shrinkK = 50, cells = null }) -> { observe(leg), prob(leg), cell(leg) -> {n, hit}|null, export() -> {shrinkK, cells: {key: {n, hit}}} }`. `leg` shape: `{ market, price, prob, outcome }` with `outcome in ('hit','miss', anything-else-ignored)`.
- Source of truth: lift `bandOf`/`groupOf`/`cellKey`/`makeCalibrator` VERBATIM from `scripts/replay-daily2x.js:50-81`, then add injectable `shrinkK`, `cells` rehydration, and `export()`. Update `scripts/replay-daily2x.js` to import from the new module (delete its local copies) so there is exactly one definition.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bandOf, groupOf, cellKey, makeCalibrator } from '../src/db/leg-calibration.js';

test('bands and groups match the replay taxonomy', () => {
    assert.equal(bandOf(1.01), '1.02');
    assert.equal(bandOf(1.35), '1.35');
    assert.equal(bandOf(9.0), 'long');
    assert.equal(groupOf('O 0.5'), 'O0.5');       // the known trap cell stays isolated
    assert.equal(groupOf('U 4.5'), 'under');
    assert.equal(groupOf('TT:H:O 1.5'), 'tt-over');
    assert.equal(groupOf('X2'), 'dc');
    assert.equal(groupOf('1'), '1x2');
    assert.equal(cellKey({ market: 'O 0.5', price: 1.01 }), 'O0.5|1.02');
});

test('calibrator shrinks from devig toward realized rate and rehydrates', () => {
    const cal = makeCalibrator({ shrinkK: 10 });
    const leg = { market: 'O 0.5', price: 1.01, prob: 0.99 };
    assert.equal(cal.prob(leg), 0.99);                       // no evidence: the book's number
    for (let i = 0; i < 10; i++) cal.observe({ ...leg, outcome: 'miss' });
    assert.ok(cal.prob(leg) < 0.6);                          // evidence drags the trap down
    cal.observe({ ...leg, outcome: 'void' });                // ignored
    assert.equal(cal.cell(leg).n, 10);
    const twin = makeCalibrator(cal.export());               // round-trip
    assert.equal(twin.prob(leg), cal.prob(leg));
});
```

- [ ] **Step 2: Run** `npm test -- --test-name-pattern calibr` (or plain `npm test`), expect FAIL (module missing).
- [ ] **Step 3: Implement** the module: copy lines 50-81 of the replay script verbatim, wrap in exports, add the options object, `cell()`, `export()` (plain-JSON cells for storage on slip rows and reuse across runs).
- [ ] **Step 4: Point `scripts/replay-daily2x.js` at the module** (import, delete local copies; behavior byte-identical since the code moved unchanged).
- [ ] **Step 5: Run** `npm test`, expect PASS, suite count grows.
- [ ] **Step 6: Commit** `feat(engine): extract walk-forward leg calibration into pure src/db/leg-calibration.js`.

---

### Task 2: Pure slip rules `src/db/daily-slip-rules.js`

**Files:**
- Create: `src/db/daily-slip-rules.js` (imports ONLY `./leg-calibration.js`, a sanctioned cross-pure import like tip-rules -> markets)
- Test: `tests/daily-slip-rules.test.js`

**Interfaces:**
- Consumes: `makeCalibrator` instance (Task 1).
- Produces:
  - `DEFAULT_DAILY_SLIP = { minLegs: 2, probFloor: 0.90, maxLegPrice: 1.35, maxPerLeague: 3, minCellN: 0, mood: { green: { legs: 6, meanProb: 0.95 }, amber: { legs: 3, meanProb: 0.92 } } }` (provisional literals; Task 7's simulation finalizes them and records the run).
  - `selectDailyLegs(fixtures, cal, opts) -> legs[]`: `fixtures` = `[{ id, league, menuLegs: [{ market, price, prob }] }]`; picks each fixture's best CALIBRATED leg passing the gates, ranks by calibrated prob desc (tie: lower price, then id asc for determinism), applies the league cap, returns `[]` shape legs `{ id, league, market, price, prob, calProb, cell }`.
  - `constructSlip(legs, opts) -> { legs, combinedOdds, mood } | null`: null when fewer than `minLegs` qualify (the honest no-slip day); combined odds UNCAPPED (spec decision 2).
  - `dayMood(legs, opts) -> 'green'|'amber'|'red'`.
  - `slipOutcomeRollup(legOutcomes) -> { outcome: 'won'|'lost'|'void'|null, legsHit }`: any miss = lost (settles early), all settled + all void = void, all settled otherwise = won, else null (pending). Void legs count as surviving, not as hits.
  - `slipStreaks(slips) -> { current, best, greenRate, played }` over rows `{ status, outcome }` sorted by date asc; `no_slip` days are skipped, not broken.

- [ ] **Step 1: Write the failing tests** (the decision surface, one test per rule):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCalibrator } from '../src/db/leg-calibration.js';
import { DEFAULT_DAILY_SLIP, selectDailyLegs, constructSlip, dayMood, slipOutcomeRollup, slipStreaks }
    from '../src/db/daily-slip-rules.js';

const fx = (id, league, legs) => ({ id, league, menuLegs: legs });
const leg = (market, price, prob) => ({ market, price, prob });

test('gates: floor, price window, one leg per fixture, league cap', () => {
    const cal = makeCalibrator({ shrinkK: 1 });
    const opts = { ...DEFAULT_DAILY_SLIP, probFloor: 0.9, maxPerLeague: 2 };
    const fixtures = [
        fx(1, 'EPL', [leg('U 5.5', 1.05, 0.95), leg('1X', 1.30, 0.85)]),   // best leg passes
        fx(2, 'EPL', [leg('U 5.5', 1.06, 0.94)]),
        fx(3, 'EPL', [leg('U 5.5', 1.07, 0.93)]),                          // league cap drops this
        fx(4, 'Liga', [leg('O 2.5', 1.50, 0.92)]),                        // price window drops this
        fx(5, 'Liga', [leg('X2', 1.20, 0.80)]),                           // floor drops this
    ];
    const picked = selectDailyLegs(fixtures, cal, opts);
    assert.deepEqual(picked.map(l => l.id), [1, 2]);
    assert.equal(picked[0].calProb >= picked[1].calProb, true);            // ranked desc
});

test('construction: uncapped combined odds, min-legs floor, no-slip day', () => {
    const legs = [
        { id: 1, market: 'U 5.5', price: 1.30, calProb: 0.95 },
        { id: 2, market: 'U 5.5', price: 1.30, calProb: 0.95 },
        { id: 3, market: 'U 5.5', price: 1.30, calProb: 0.95 },
    ];
    const slip = constructSlip(legs, DEFAULT_DAILY_SLIP);
    assert.ok(Math.abs(slip.combinedOdds - 1.3 ** 3) < 1e-9);              // nothing caps it
    assert.equal(constructSlip(legs.slice(0, 1), DEFAULT_DAILY_SLIP), null); // < minLegs
});

test('mood thresholds', () => {
    const mk = (n, p) => Array.from({ length: n }, (_, i) => ({ id: i, calProb: p }));
    assert.equal(dayMood(mk(6, 0.96), DEFAULT_DAILY_SLIP), 'green');
    assert.equal(dayMood(mk(3, 0.93), DEFAULT_DAILY_SLIP), 'amber');
    assert.equal(dayMood(mk(2, 0.91), DEFAULT_DAILY_SLIP), 'red');
});

test('rollup: miss settles early, voids survive without hitting', () => {
    assert.deepEqual(slipOutcomeRollup(['hit', 'miss', null]), { outcome: 'lost', legsHit: 1 });
    assert.deepEqual(slipOutcomeRollup(['hit', null]), { outcome: null, legsHit: 1 });
    assert.deepEqual(slipOutcomeRollup(['hit', 'void']), { outcome: 'won', legsHit: 1 });
    assert.deepEqual(slipOutcomeRollup(['void', 'void']), { outcome: 'void', legsHit: 0 });
});

test('streaks skip no-slip days and count green runs', () => {
    const s = (status, outcome) => ({ status, outcome });
    const r = slipStreaks([s('published', 'won'), s('no_slip', null), s('published', 'won'),
        s('published', 'lost'), s('published', 'won')]);
    assert.deepEqual(r, { current: 1, best: 2, greenRate: 3 / 4, played: 4 });
});
```

- [ ] **Step 2: Run** `npm test`, expect FAIL.
- [ ] **Step 3: Implement** the module. Selection per fixture mirrors `buildCard`'s per-fixture best-leg idea (`scripts/replay-daily2x.js:88-102`) but ranks by calibrated prob (banker-style), not efficiency toward a target; gate order: price window, then calibrated floor, then `minCellN` (0 = off), then one-per-fixture best, then global rank, then league cap.
- [ ] **Step 4: Run** `npm test`, expect PASS.
- [ ] **Step 5: Commit** `feat(engine): pure daily-slip rules (gates, banker construction, mood, rollup, streaks)`.

---

### Task 3: Premium seam `src/db/feature-rules.js`

**Files:**
- Create: `src/db/feature-rules.js`
- Test: `tests/feature-rules.test.js`

**Interfaces:**
- Produces: `FEATURES = { daily_multibet: { minTier: 'user' }, slip_sharing: { minTier: 'user' } }`; `featureAllowed(user, feature) -> boolean` (unknown feature throws; `user` is the resolved session user or null; v1 semantics: any signed-in user allowed, guest false). The future subscription work touches only this module plus a `users.tier` column.

- [ ] **Step 1: Test:**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { featureAllowed } from '../src/db/feature-rules.js';

test('premium seam v1: signed-in allowed, guest denied, unknown feature throws', () => {
    assert.equal(featureAllowed({ id: 1, role: 'user' }, 'daily_multibet'), true);
    assert.equal(featureAllowed(null, 'daily_multibet'), false);
    assert.throws(() => featureAllowed({ id: 1 }, 'nope'), /unknown feature/);
});
```

- [ ] **Step 2: Run (FAIL), implement, run (PASS).**
- [ ] **Step 3: Commit** `feat(engine): premium feature seam (structural only, everything allowed for signed-in)`.

---

### Task 4: Migration `daily_slips`

**Files:**
- Create: `src/db/migrations/20260806000001_daily_slips.js`

**Interfaces:**
- Produces: table `daily_slips` used by Tasks 5, 6, 7.

- [ ] **Step 1: Write the migration** (columns per spec):

```js
export async function up(knex) {
    await knex.schema.createTable('daily_slips', table => {
        table.increments('id');
        table.date('slip_date').notNullable().unique();
        table.enu('status', ['published', 'no_slip']).notNullable();
        table.enu('mood', ['green', 'amber', 'red']).notNullable();
        table.json('legs').notNullable();          // self-contained; [] on no_slip days
        table.decimal('combined_odds', 10, 2).nullable();
        table.integer('legs_total').notNullable().defaultTo(0);
        table.integer('legs_hit').nullable();
        table.enu('outcome', ['won', 'lost', 'void']).nullable();  // NULL = pending
        table.string('algo_version', 32).notNullable();
        table.boolean('backfilled').notNullable().defaultTo(false);
        table.datetime('computed_at').notNullable();
        table.datetime('settled_at').nullable();
        table.timestamps(true, true);
    });
}
export async function down(knex) { await knex.schema.dropTable('daily_slips'); }
```

- [ ] **Step 2: Run** `npm run migrate`, verify `daily_slips` exists (`node -e` knex describe or a mysql client).
- [ ] **Step 3: Commit** `feat(db): daily_slips table (migration batch 22)`.

---

### Task 5: Orchestrator `src/daily-slip.js` + CLI + scheduler wiring

**Files:**
- Create: `src/daily-slip.js`
- Modify: `src/index.js` (new action `dailyslip`), `src/pipeline.js` (step after hot picks), `src/auto-refresh.js` (light pass settles slips)
- Test: `tests/daily-slip-rules.test.js` already covers the decisions; this layer stays thin (loader + upsert), verified end-to-end in Task 7.

**Interfaces:**
- Consumes: `buildTipBooks` (`src/db/tip-rules.js`), `marketMenu` (`src/db/ladder-rules.js`), `tipOutcome` (`src/db/tip-rules.js`), Tasks 1-2 modules, `canonicalMarket` (`src/markets.js`), `tipMarketLabel` (`src/db/magic-rules.js`).
- Produces: `buildDailySlip(date?) -> { slip, skipped }`, `settleDailySlips() -> settledCount`, `dailySlipPayload(date)`, `dailyTimelinePayload(days = 30)`.

- [ ] **Step 1: Implement the loader + builder.** Shape (follow `src/hotpicks.js` loader idioms; kickoff SQL via the `+03:00` offset expression):
  - `_calibrationCells(beforeDate, windowDays = 90)`: settled final fixtures in the window strictly before `beforeDate` with their matches' `odds_markets` rows (stale included: the last-seen price IS the historical price); per fixture build `marketMenu(buildTipBooks(rows, names))`, settle each leg with `tipOutcome`, feed a `makeCalibrator()`; return the calibrator. Runs once per build (daily cadence), bounded window keeps it O(minutes) worst case.
  - `buildDailySlip(date = today EAT)`: upcoming correlated fixtures of `date` whose kickoff is still future; per fixture menu legs via the same book path; `selectDailyLegs` + `constructSlip` + `dayMood`; legs enriched with teams/league/kickoff/label (`tipMarketLabel`), per-provider prices (match `canonicalMarket(row).key === leg.market` per provider), calibrated prob, cell evidence `{n, hit}`, and a one-line plain-language reasoning string ("94% calibrated from 187 similar legs, priced 1.22"). Upsert by `slip_date` with EXPLICIT merge list, and NEVER merge over a row whose legs have started kicking off (freeze: skip the upsert when the stored row has any leg with kickoff <= now, or when `settled_at` is set). No-slip days upsert `status='no_slip', legs=[], mood='red'`.
  - `settleDailySlips()`: pending `daily_slips` rows (outcome NULL) joined against canonical final scores by the legs' fixture ids; grade each leg with `tipOutcome(market, ft_home, ft_away)`, write leg outcomes back into the JSON, roll up with `slipOutcomeRollup`, set `legs_hit`/`outcome`/`settled_at` once. Only writer of those columns.
  - `dailySlipPayload(date)` / `dailyTimelinePayload(days)`: read rows, attach `slipStreaks` stats; no recomputation.
- [ ] **Step 2: Wire the CLI** in `src/index.js` (`dailyslip` action, close pool on exit) and the pipeline step in `src/pipeline.js` AFTER hot picks (the slip reads the same warehouse state the tips were computed from); add `settleDailySlips()` to the light pass in `src/auto-refresh.js` right after `settleHotPicks()` (cheap SQL, no fetches).
- [ ] **Step 3: Run it once for real:** `node src/index.js dailyslip`, then inspect the row (`node -e` select). Expect either a published slip with legs JSON or an honest no-slip row.
- [ ] **Step 4: Run** `npm test` (suite stays green; this layer added no pure logic).
- [ ] **Step 5: Commit** `feat(engine): daily multibet builder + settle + CLI/pipeline/light-pass wiring`.

---

### Task 6: Read API + premium gating

**Files:**
- Modify: `src/server.js` (two GET routes with `optionalAuth`)
- Test: route logic delegates to pure modules already tested; guard behavior verified by hand with curl in Step 3.

**Interfaces:**
- Consumes: `dailySlipPayload`/`dailyTimelinePayload` (Task 5), `featureAllowed` (Task 3).
- Produces: `GET /api/daily-slip?date=` and `GET /api/daily-slip/timeline?days=`.

- [ ] **Step 1: Add routes** following the `/api/hotpicks` pattern: `optionalAuth`; when `featureAllowed(req.user, 'daily_multibet')` is false answer the teaser `{ teaser: true, legs_total, mood, auth_required: true }` (counts only, no legs); otherwise the full payload. Timeline gated the same way (teaser: streak stats only).
- [ ] **Step 2: Restart serve, curl both routes** signed-out (teaser) and with a session bearer (full).
- [ ] **Step 3: Commit** `feat(api): daily-slip + timeline routes behind the premium seam`.

---

### Task 7: Simulation grid + hindsight-free backfill `scripts/simulate-daily-slip.js`

**Files:**
- Create: `scripts/simulate-daily-slip.js`
- Modify: `src/db/daily-slip-rules.js` (bake the winning `DEFAULT_DAILY_SLIP`), checklist, research doc `docs/research/2026-08-06-daily-multibet-simulations.md`

**Interfaces:**
- Consumes: `load/index/derive` from `scripts/simulate.js` (the proven bulk loader with information cutoffs), Tasks 1-2 pure modules, `db` handle from simulate.js.
- Produces: the baked defaults + backfilled `daily_slips` history (`--write`, refuses production DB name for ledger writes EXCEPT `daily_slips` backfill which targets production deliberately, gated behind `--write-daily` + a confirmation flag `--yes`).

- [ ] **Step 1: Build the harness** on the replay script's skeleton: load once, per-day menu legs, walk-forward calibrator observing strictly-prior days, `selectDailyLegs` + `constructSlip` per day per parameter set. Grid (kept honest and bounded): `probFloor in [0.88, 0.90, 0.92, 0.94]`, `maxLegPrice in [1.20, 1.35, 1.60]`, `maxPerLeague in [2, 3]`, `minCellN in [0, 30]`. Score: green-day rate, then best streak, then flat P&L. Seeded/deterministic (no RNG anywhere), temporal behavior identical to the replay showcase. Print a policy-regime warning when any live tip knob changed inside the window (reuse the mine's discipline).
- [ ] **Step 2: Run the grid** on the warehouse (`--db oddspro`) and on `oddspro-v2`; record ALL cell results in the research doc (no cherry-picking; the doc shows the whole grid).
- [ ] **Step 3: Bake the winner** into `DEFAULT_DAILY_SLIP` with a dated comment citing the run; set `algo_version` to `v1-sim-2026-08-06`. Adjust mood thresholds from the observed distribution (green = top-third days, red = bottom-third; record the literals).
- [ ] **Step 4: Backfill** `--write-daily --yes`: write historical `daily_slips` rows walk-forward, `backfilled = true`, `computed_at` = the day's first leg kickoff (the honest as-of stamp), settled from known scores in the same pass.
- [ ] **Step 5: Verify** timeline payload end-to-end: `curl /api/daily-slip/timeline` shows the backfilled history with streaks; `npm test` green.
- [ ] **Step 6: Write the research doc** (green rate, streaks, P&L per construction, the winning set, what is licensed/forbidden per the honesty framing) and update the checklist + alignment check.
- [ ] **Step 7: Commit** `feat(engine): daily-slip simulation grid, baked defaults, backfilled timeline` then a docs commit for the research doc.

---

## Self-review

- Spec coverage: Phase 0 (Task 0), calibration layer (Task 1), slip rules (Task 2), premium seam (Task 3), storage + freeze + settle (Tasks 4-5), API (Task 6), simulations + backfill + battle-test verdict (Task 7). Phases 2-4 are explicitly out of this plan and get their own plan files.
- Placeholders: none; provisional literals in Task 2 are real values with the finalization step named (Task 7 Step 3).
- Type consistency: leg shape `{ market, price, prob, outcome }` for the calibrator everywhere; `selectDailyLegs` output feeds `constructSlip` and the JSON enrichment in Task 5; `slipStreaks` consumes `{ status, outcome }` rows in both Task 5 payloads.
