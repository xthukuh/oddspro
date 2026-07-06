# Web table improvements — filter parity, sort-value tooltips, slips backtest, magic column

Date: 2026-07-06
Status: approved

## Problem

Four gaps in the web datatable and its tools:

1. **Tip filter query error.** `BASE_FIELDS.tip` targets `fp.tip_confidence`
   (number). `_coerce()` turns non-numeric input into `NaN`, which mysql2
   serializes as a bare `NaN` token → `Unknown column 'NaN'` SQL error
   (reproduced with `tip eq "O 2.5"`). Every number-typed field has the same
   landmine. Client-side twin bug: `like` on tip reads `row.tip`, a field
   that does not exist (rows carry `tip_market` / `tip_confidence`).
2. **Sort values are invisible.** Derived sort values (form → points,
   `"gf/ga (avg)"` → avg, score → total goals) are unguessable from the cell
   text, so rankings look arbitrary.
3. **Slips playground is useless on past dates.** Candidates require
   `tip_outcome == null` (pending); on a past date everything is settled, so
   the tool shows "No pending tips" despite frozen last-seen odds being
   available for demo/backtest.
4. **Magic sort is a black box.** When a ✨ strategy reorders the table there
   is no visible score, so the ordering cannot be sanity-checked.

## Design

### 1. Filter parity + tip filter fix

Registry-driven semantics (chosen over UI-only validation and over a separate
`tip_market` filter key).

**Server — `src/db/records.js`:**

- `BASE_FIELDS.tip` gains `like_sql: 'fp.tip_market'`. `_sqlTarget` becomes
  op-aware: `like` conditions resolve to the field's `like_sql` when declared;
  comparison ops keep the numeric `sql` target. Column-to-column (`col`) mode
  is unaffected (`like` is already excluded there).
- `_coerce` throws `TypeError('Invalid numeric filter value for <key>: <value>')`
  when a number-typed field receives unparsable text under a comparison op.
  The server's error handler already maps `TypeError` → 400. `like` values are
  NOT numerically coerced (string-contains on numbers keeps working, e.g.
  `goals like 3`).

**Client — `web/src/filterValues.js`:**

- `_raw` (the `like` extractor) maps `tip` → `row.tip_market` so contains
  matches the visible tip text, mirroring the server.
- Comparison ops need no change: `_compare` already yields `null` for
  unparsable input (row excluded, no crash).

**Tests:** extend the offline node:test suites covering `filterValues.js`;
server-side `_sqlTarget`/`_coerce` behavior verified via a live smoke query
(records.js imports the DB pool and stays outside the offline suite, per the
existing test layout).

### 2. Sortable-value cell tooltips

`DataTable._cellTitle` appends `⇅ sorts as: <value>` to a cell's tooltip when
the derived `sortValue()` differs from the displayed text:

- form (`WWDLW` → 12), h2h (`2W-1D-0L` → 7), rolling-goals strings → avg,
  score `2-1` → 3, `fs:` stats `H / A` → sum, tip → confidence + hot bonus.
- Skipped when the display IS the value (odds prices, ranks, counts) and for
  date columns (order is obvious).

Uses the same `sortValue()` the sorter and client filters use — the indicator
can never disagree with actual ordering.

### 3. Slips backtest on past dates

**Candidates (`web/src/components/BetslipPlayground.jsx`):** gate widens from
pending-only to pending OR settled, still non-vetoed, still one per canonical
fixture. Candidates carry `outcome` (`'hit' | 'miss' | null`) and settled ones
render ✓/✗ in the list. Prices remain the frozen `tip_price` (last-seen at tip
time), so unavailable/concluded matches work naturally — this is the "last
seen odds" demo mode.

**Slip grading — new pure helper `slipOutcome(legs)` in
`src/db/magic-rules.js`** (beside `slipSummary`; offline-tested):

- every leg hit → `{ state: 'won' }` — card shows WON + actual payout
  (stake × combined odds);
- any leg missed → `{ state: 'lost', broken: [api_ids] }` — stake gone,
  broken legs highlighted;
- otherwise → `{ state: 'open', settled: n, total: m }` — "alive, n/m
  settled"; a miss flips it to lost immediately even with pending legs.

Slip cards add the verdict line alongside odds/payout/survival/EV. Stored
slips gain `outcome` per leg; old localStorage entries without it degrade
gracefully to pending. AI-vetoed tips stay excluded (consistent with live
mode; the performance report owns veto measurement).

### 4. Magic values column

When a ✨ strategy is active, `DataTable` injects a synthetic base column
(key `magic`) immediately left of Tip:

- cell: `#rank · score` — rank per unique fixture (both provider rows share
  it), score = `scoreTip(row, id, cal)` to 3 decimals, `—` for tipless rows;
- header: ✨ with the strategy name in the tooltip; clicking it does NOT sort
  and does NOT clear magic (excluded from the sort handler — all other
  headers keep the existing click-clears-magic behavior);
- joins `PIN_KEYS` so it left-pins on horizontal scroll like Score and Tip;
- disappears when magic is off. Not part of the settings catalog or column
  order persistence (ephemeral, presence == magic active).

## Out of scope

No new API endpoints, no DB/schema changes, no settings UI changes, no
changes to strategy scoring or the simulator.

## Decisions log

- Tip filter: `contains` → market text, comparisons → confidence (user-picked).
- Sort-value indicator: tooltip line, only where derived ≠ displayed (user-picked).
- Slips on past dates: full backtest with outcome grading (user-picked).
- Magic column format: `#rank · score`, raw scale, no fake percentages (user-picked).
