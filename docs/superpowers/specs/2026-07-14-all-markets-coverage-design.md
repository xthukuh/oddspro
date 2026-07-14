# All-Markets Coverage — Design Spec (2026-07-14)

Branch: `feat/all-markets-coverage` (off `main`). Status: **DRAFT — awaiting review.**

## 1. Goal

Use **all** markets the bookmakers expose, not just the canonical ~20 (1X2 / Double
Chance / Over-Under). Per the approved shape: capture them, **surface** them on the
web frontend (columns, filters, sort, export, settings), and **feed predictions**
on the markets where that is tractable and evidence-supported.

## 2. Current state (grounded in DB inventory + code-surface map)

The inventory (`tmp/market-inventory.mjs`) and the code map show the gap is **not**
where it first seemed:

- **Storage is already generic.** `odds_markets` stores every market a scraper
  emits, keyed by raw `(type_name, name, handicap)`; `store._marketRows` and
  `odds-diff` filter nothing. **BetPawa already has 133 distinct market types
  stored** (Correct Score, HT/FT, Multigoals, Handicaps, BTTS, DNB, Odd/Even,
  Clean Sheet, Win-to-Nil, team totals, corners, bookings, goalscorer props…).
  → **Capture is mostly a solved problem.**
- **Scrapers are already generic parsers.** Only BetPawa's request-level
  `view.marketTypes` allowlist (6 opaque IDs — evidently broad *groups*, since 133
  types come through) is a fetch-side gate. Betika is unfiltered.
- **The read layer is the choke point.** `records.js` `columnCatalog()` serves the
  **fixed** `MARKET_COLUMNS` registry (unlike `providers`/`stats`, which it
  discovers from data); `_sqlTarget`/`markets.whereMarket` are bespoke-per-family
  and `throw` on unknown keys; `_hydrate` fetches all `odds_markets` rows but
  **drops any row `marketKey()` doesn't recognize** before it reaches the frontend.
- **The frontend is ~90% already dynamic** — it renders whatever the catalog/rows
  contain (`App.jsx`, `columns.js`, `SettingsModal`, `FilterBuilder`, `DataTable`,
  `sortValues`, `filterExpr`, `exportCsv` all key by arbitrary market string).
- **Predictions are hard-wired to 3 families** (`hotpicks._loadMarkets`,
  `tip-rules.bestTip`/`tipHit`, `perf-rules.marketGroup`) with bespoke devig +
  closed settlement switches that `throw` on unknown markets.

**Conclusion:** this is a **surfacing + market-identity** problem (M2), not a
capture problem (M1); predictions (M3) are a separate, harder, per-family effort.

## 3. The hard problem — cross-provider market identity

BetPawa and Betika spell the *same* market differently. A naive "discover distinct
`(type_name, name, handicap)`" would present one real market as two columns. We need
a **deterministic canonicalizer**: provider `(type_name, name, handicap)` → a
**canonical market key** + **group** + **display label**, with:

- **Full family coverage** (not just the 3 canonical families): a rule table /
  normalizer mapping known provider spellings across all families to stable keys.
- **A catch-all passthrough**: any *unrecognized* market still gets a deterministic
  key (e.g. `raw:<provider-normalized>`), so nothing is silently dropped — it's
  visible, filterable, and flagged "unnormalized" rather than lost.
- **Cross-provider unification** for recognized markets (the existing
  `markets.test.js` invariant — both spellings resolve to one key — generalized).

This is the central design decision. **Recommended: a rule-based canonicalizer**
(pure, deterministic, offline-testable — extends today's `markets.js` approach to
all families) over a learned alias table, because market spellings are a small
closed vocabulary per provider (unlike team names), so rules are simpler and don't
need the fuzzy `link.js` machinery. Keyed on `type_name` **never** `type_id`
(Betika reuses ids — existing invariant).

## 4. Cardinality / sparsity guard

"Everything" includes markets that must **not** become table columns: Anytime
Goalscorer (2,029 outcome names over 71 matches), Next/Last Goalscorer,
Player-to-be-Carded, full Correct-Score (46–68 outcomes). These are stored and
**filterable**, but each market carries a **`columnizable`** classification derived
from outcome-cardinality + match-coverage:

- **column** — low-cardinality, well-covered (1X2, O/U lines, BTTS, DNB, team
  totals, Odd/Even, DC…): eligible as a table column, opt-in via Settings.
- **grouped** — medium cardinality (Correct Score, Multigoals, HT/FT, Winning
  Margin): surfaced as a collapsible group / detail view, not flat columns.
- **filter-only** — huge cardinality / player props: stored + queryable, never a
  column, excluded from the default catalog.

The guard is data-driven (thresholds), so it self-adjusts as coverage grows.

## 5. Architecture & decomposition

### M1 — Capture (small)
- Confirm Betika's stored breadth (inventory) — parser already unfiltered.
- **Optional, low priority:** discover additional BetPawa `marketTypes` group IDs
  (or test an unfiltered request) to widen fetch beyond the current 6. Since 133
  types already land, this is incremental, not foundational. No schema change.

### M2 — Surface everything (the core deliverable)
- **`src/markets.js` → generic canonicalizer**: `canonicalMarket(row) → {key, group,
  label, columnizable}` replacing the closed `marketKey`; keep the canonical keys
  stable for backward compat. `whereMarket` → generic `whereMarketIdentity(qb, key)`
  that builds a WHERE from the canonical key's `(type_name set, name set, handicap)`.
- **`src/db/records.js`**: `columnCatalog()` **discovers** markets from `odds_markets`
  (like `stats`/`providers`), tagged with group + `columnizable`; `_hydrate` pivots
  by canonical key (all recognized + raw passthrough); `_sqlTarget` uses the generic
  WHERE builder. Preserve `min(price)` + fresh/stale semantics per identity.
- **Frontend**: extend the market `MultiSelect` + `FilterBuilder` with a **grouped,
  searchable** market taxonomy (Result / Goals / Both-Teams / Halves / Handicaps /
  Team-totals / Specials); extend the `DataTable` tooltip glossary; **canonical
  markets stay the default columns** (no UX regression — extras are opt-in).
- **Tests**: shift `markets.test.js` from a static input→output table to **property
  assertions** (idempotence, `type_name`-not-`type_id`, cross-provider unification,
  raw-passthrough never drops); generic read-layer tests; keep `perf-rules`
  `marketGroup` a stable **superset** classifier so magic-sort calibration cells
  don't break.

### M3 — Predictions on new markets (gated, per-family, honest)
- Extend `_loadMarkets` to shape new family inputs; add per-family **devig** +
  **`tipHit` settlement** rules (BTTS, team totals, DNB, HT/FT, Multigoals — the
  tractable families where our stats can produce an independent probability).
- **Non-negotiable honesty gate** (the map's flagged trap): a market may only
  surface a *recommended tip* after it clears a **backtest evidence bar**
  (leak-free OOS precision + price-aware +EV/CI, per the fair-comparison rigor).
  Until then it is **settled + measured but never tipped** — wired into the
  performance ledger so its true hit-rate/EV is visible.
- **Display-only families**: correct score, exact goals, goalscorer/player props —
  devig + display, **never tipped** (our stats can't model them; a "tip" there is
  just the bookmaker's favorite). `bestTip`/`tipHit` must **not** throw on them —
  they're simply excluded from the tip candidate set, not errored.
- **Reality check** (from the audit): most new markets will measure **−EV**
  (BTTS/team-totals already shown −EV). M3's value is *honest measurement +
  optionally a few evidence-passing win-probability markets*, not profit. The
  ~13-day odds window also caps M3 validation now (≥30-day bar applies).

## 6. Sequencing

**M1 (confirm/optional) → M2 (ship the display/data win) → M3 (gated, incremental
per family).** M2 is self-contained and shippable on its own; M3 lands family by
family behind the backtest gate. Each phase: TDD, `npm test` green, browser-verify
M2, no regression to the canonical default view.

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cross-provider duplicate columns | Canonicalizer unification (§3) + property tests |
| Column explosion / unusable UI | Cardinality guard (§4) + grouped searchable taxonomy + canonical-only default |
| Silent unvalidated tips on exotic markets | M3 backtest gate; display-only families never enter the tip candidate set (§5 M3) |
| `throw`-on-unknown breaks pipeline | Replace closed switches with recognize-or-passthrough; `tipHit` excludes (not errors) untippable markets |
| Magic-sort calibration breakage | `marketGroup` becomes a stable superset, not a replacement |
| Thin sample for M3 validation | Same ≥30 odds-day bar as beat-the-book; measure-first, tip-later |

## 8. Out of scope

- Profitability claims on new markets (the vig stands; measure, don't promise).
- Learned/fuzzy market aliasing (rules suffice for the closed market vocabulary).
- Retro-settling historical exotic markets beyond what canonical scores allow.

## 9. Decisions (resolved 2026-07-14)

1. **M2 default view: promote BTTS + DNB** into the default columns alongside the
   canonical 1X2/DC/O-U (both low-cardinality, well-covered, commonly bet). All
   other markets remain opt-in.
2. **M3 first families: BTTS + team totals + DNB**, each behind the backtest
   evidence gate before it can surface a recommended tip. Other families
   (HT/FT, Multigoals, correct-score, props) are M2 display/filter only for now.
3. **M1 BetPawa fetch widening: deferred** — 133 market types already land from the
   current 6 group IDs; further market-group discovery is a later increment.
