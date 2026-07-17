# M3 — Any-Market Predictions — Design Spec (2026-07-15)

Branch: `feat/m3-any-market-tips` (off `main`, post-v1.1.0 `d926b6b`). Status: **APPROVED** (design reviewed section-by-section in session 2026-07-15).

Supersedes §5 M3 of `2026-07-14-all-markets-coverage-design.md`: the "+EV backtest
gate before a market may be tipped" is replaced by **tip-always + honest labeling +
a Safe-pool maturity floor** (user decision 2026-07-14, confirmed 2026-07-15).

## 1. Goal

Generalize the tip engine beyond 1X2 / Double Chance / Over-Under so the **single
best-supported pick per fixture** is chosen across every stats-backed market family,
labeled with its honestly measured live hit-rate/EV — never gated on being +EV.
Generalize the 🔥 hot pick to other O/U lines. Two paramount properties (user
directives, 2026-07-15):

- **Surest-pick consistency:** widening coverage must not dilute the reliability of
  the top-ranked picks. New markets earn their way up; proven markets keep the top
  slots.
- **Bookmaker-trick resistance:** margin-loading, palpable-error/boosted prices,
  one-sided books, and cross-provider trap prices are detected and excluded early.

## 2. Grounding (code-surface facts, explored 2026-07-15)

- `bestTip` iterates hardcoded `['1','X','2']` / `['1X','X2','12']` / O-U lines
  (`tip-rules.js:258-274`); `tipHit` settles only those and **throws** on any other
  string (`:178`) — called server-side (`settleHotPicks`) and in the browser
  (`App.jsx:182` unguarded; `filterExpr.js` wrapped).
- `hotpicks._loadMarkets` keys rows via the **closed** `marketKey`, so only the 3
  canonical families reach the rules today.
- M2's `canonicalMarket` already emits the vocabulary M3 needs: `GG`/`NG` (btts),
  `DNB1`/`DNB2` (dnb, BetPawa-only), `ODD`/`EVEN`, `TT:<ouKey>` (team totals,
  **home/away collapsed by design** — tips need side resolution), `HTFT:`/`CS:`
  (display-only), `raw:` passthrough. Prediction code deliberately untouched by M2.
- `fixture_predictions.tip_market` is **VARCHAR(8)** (overflows `TT:H:O 1.5`);
  `tip_outcome` is ENUM('hit','miss') (no push/void).
- HT scores are stored (`fixtures.ht_home/ht_away`) but the M3 core needs FT only.
  Corners/cards exist only as free-string `fixture_statistics` — no settlement path.
- `perf-rules.marketGroup` collapses unknown markets into `'other'`;
  `magic-rules.WAREHOUSE_WLO` has anchors only for the canonical families —
  `safePrior` falls back to the global rate for new keys.
- Measured reality (fair board, 22,213 rows): **no market is +EV** (X2 −12.8%,
  12 −8.0%, O 2.5 −5.5%, 1X −4.1%); market AUC beats stats in every group. M3's
  value is coverage + honest measurement + win-probability ranking, not profit.

## 3. Decisions (resolved in session, 2026-07-15)

1. **Candidate scope = stats-backed core:** 1X2, DC, O/U (unchanged) **+ BTTS, DNB,
   team totals, Odd/Even** — every family gets a real rolling-stats probability.
   HT/FT, halves, multigoals, correct score, props stay display-only (excluded from
   the candidate set, never errored on).
2. **One tip per fixture + runners-up** (existing shape) — the single `tip_market`
   is now chosen across ~7 families; runners-up/`tip_breakdown` carry alternatives.
3. **Hot picks generalize to other O/U lines only** (`scoreOverLine`), each line
   backtest-tuned before it may fire; per-family hot gates deferred.
4. **Evidence-eligibility screen stays** (context/thin-sample/no-markets skips);
   only the per-market +EV gate is removed. A confidence computed from meaningless
   form would be dishonest — the opposite of the labeling principle.
5. **EV label surfaces in the TipPopover for everyone** (coarse, aggregate:
   live hit-rate, settled count, flat-stake ROI); blend internals stay behind
   `useShowDetails()` as today.

## 4. Architecture

### 4.1 Family-module registry (`src/db/tip-rules.js`, pure)

`TIP_FAMILIES` registry; each family supplies four pure functions:

| Function | Purpose |
|---|---|
| `book(markets)` | Extract the family's full odds group(s); `null` if incomplete |
| `marketProb(key, book)` | Devigged probability (full-group renormalization) |
| `statsProb(key, aggs)` | Independent stats probability, or `null` if sample absent |
| `settle(key, ftHome, ftAway)` | `'hit' \| 'miss' \| 'void'` |

- Families: `result`, `double_chance`, `over_under` (byte-compatible with today,
  incl. `minUnderLine`), `btts`, `dnb` (draw → `void`), `team_total`
  (side-specific), `odd_even`.
- `bestTip` iterates the registry; blend math, renormalized weights, price floor,
  confidence floor, runners-up shape, and the return contract are unchanged —
  legacy settled rows and `tip_breakdown` JSON stay valid.
- `tipHit` delegates to registry `settle`; **still throws on unknown keys
  server-side** (a persisted unknown key is a bug — fail loud). New `tipHitSafe`
  (returns `null`) for browser call sites.
- **Team-total tip keys are side-specific:** `TT:H:O 1.5` / `TT:A:U 2.5` (tip-layer
  vocabulary, distinct from M2's collapsed display key). Side resolved in the
  hotpicks loader by normalized exact match of the embedded team name in the raw
  odds row against the fixture's home/away names; unresolved side → market excluded
  from candidates. Settlement reads that side's FT goals.

### 4.2 Book-integrity guards (bookmaker-trick mitigation, pure)

`bookIntegrity(group)` runs before any family book reaches `bestTip`:

- **Completeness:** partial books rejected (only Over listed; GG without NG).
- **Overround window:** implied-probability sum must be within
  `TIP_MIN_OVERROUND`–`TIP_MAX_OVERROUND` (default ~1.01–1.30). Below 1.0 =
  palpable-error/boosted price masquerading as a hidden gem; far above =
  margin-loading so heavy the devigged number is meaningless. A rejected book means
  the family simply doesn't enter that fixture's candidate set; if NO family
  survives, the fixture records a `tip_skip_reason` as today.
- **Cross-provider divergence:** when both bookmakers carry the family and their
  devigged probabilities diverge beyond `TIP_MAX_BOOK_DIVERGENCE` (default 0.15
  absolute probability), the market is flagged and excluded (one book is likely a
  trap or error). Threshold tunable; the backtest scripts can validate the default.
- **Margin transparency:** each family book's measured overround persists inside
  `tip_breakdown` — the ledger can prove which families are margin-loaded.

### 4.3 Stats aggregates (extend existing pure helpers)

`teamOutcomeAggregates` / `h2hOutcomeAggregates` gain: both-teams-scored rate
(BTTS), per-side own-goals over rates per line (team totals), total-parity rate
(Odd/Even). DNB reuses win rates renormalized without draws. All under the existing
kickoff-cutoff + **fairness-pairing** rules. Same history rows already bulk-loaded —
no new fetches, zero API cost.

### 4.4 Hot-pick generalization (`src/db/goals-rules.js`)

`scoreOver25` → `scoreOverLine(inputs, line, opts)` (hardcoded `total >= 3` becomes
`total >= ceil(line)`); `scoreOver25` remains as a thin wrapper. Thresholds become a
per-line table seeded by a line-sweep extension of `scripts/backtest-hotpicks.js`;
**a line ships hot-enabled only if its tuned gates clear the precision bar in the
10k-fixture replay.** The existing `market VARCHAR(16)` column records which line
fired; settle SQL becomes line-aware (parses the line from the market string). One
hot pick per fixture — strongest passing line wins.

### 4.5 Data flow (shape unchanged)

hotpicks pass loads odds (now keyed via `canonicalMarket`, filtered to tip families)
+ history + frozen snapshots → eligibility screen (kept; `no_markets` now means "no
tippable family has a complete book") → registry `bestTip` → persist → **freeze at
kickoff** → settle pass (registry, void-aware) → performance ledger → calibration →
labels. Freeze-at-kickoff and settle-exactly-once invariants untouched.

## 5. Reliability enforcement (surest-pick consistency)

- **Warehouse anchors before tipping:** extend `scripts/backtest-sure-tips.js` to
  replay BTTS/DNB/team-totals/Odd-Even over the full warehouse (FT scores exist;
  all four settle offline). Temporal-OOS hit rates become `WAREHOUSE_WLO` anchors.
  **No family ships anchored to the global fallback.**
- **Safe-pool maturity floor:** `safeQualifies` requires the tip's market to have
  ≥ `SAFE_MIN_MARKET_SETTLED` live settled tips (new env knob, default 30, served
  in the `/api/magic-sort` `safe` policy object like other `SAFE_*`). At launch new
  families have 0 live settles → 🛡 Safe slips and the pinned `sure` top ranks stay
  on proven markets; a family earns Safe eligibility automatically as
  `cal.markets[key].n` crosses the floor.
- **Conservative ranking by construction:** `sure_score = safePrior × confidence`
  already beta-shrinks (k=20) toward the anchor; verified + tested, no change.

## 6. The `void` outcome (DNB pushes)

`tip_outcome` gains `'void'`. Voids are **excluded from hit-rate denominators and
contribute 0 to ROI** (stake returned). Touched: `perf-rules.summarizePerformance`
(headlines + buckets + a `voids` count), `magic-rules.computeCalibration` (void
updates no bucket), the settle pass, web footer day hit-rates, outcome toggles
(`Hide hits`/`Hide miss` leave voids visible; `No miss` — a void never blacklists a
market). Renders as a neutral grey pill.

## 7. Honest EV labeling

`computeCalibration`'s per-market bucket (`cal.markets`) additionally carries
flat-stake ROI + raw settled count. TipPopover renders one plain-language line for
**all** users — "Tips on this market have hit 74% of 212 settled picks (ROI −5%)" —
from the already-public `/api/magic-sort` payload; thin markets show "new market —
only N settled tips so far" (the reliability meter). New-family label strings live
in one shared pure helper (server/web verbatim import, the magic-rules idiom) so
`TT:H:O 1.5` reads "Home team over 1.5 goals" in the popover, runners-up, betslip
leg switcher, and the AI prompt.

## 8. Web hardenings

- Wrap the unguarded `tipHit` at `App.jsx:182` with `tipHitSafe`.
- Verify/harden the tip-filter prefix regex (`filterExpr.js`, R26b `[H|M]?\d?:`)
  against colon-bearing keys (`TT:…`) with tests.
- `perf-rules.marketGroup` becomes a stable **superset**: adds
  `btts`/`dnb`/`team_total`/`odd_even`, existing branches untouched, unknown still
  `'other'` — magic-sort calibration cells keep their identities.
- AI `reviewTip` prompt names the market in plain words via the shared label
  helper; verdict-reuse (market+price key) already tolerates any string.
- `void` pill styling + footer/toggle semantics (§6).

## 9. Migrations (batch 12, forward-only)

1. `fixture_predictions.tip_market` VARCHAR(8) → **VARCHAR(32)**.
2. `tip_outcome` ENUM('hit','miss') → **ENUM('hit','miss','void')**.

No new tables. Hot-pick `market VARCHAR(16)` already fits every O/U line key.

## 10. Testing (TDD, offline)

Per-family registry tests (book/devig/statsProb/settle incl. DNB void + TT side
resolution), book-integrity cases (partial book, sub-1.0 overround, margin-loaded
book, provider divergence), void ledger math (perf-rules + calibration), Safe
maturity floor, `scoreOverLine` parameterization, filter-prefix collision, and a
**byte-compatibility test**: legacy fixtures through the new engine reproduce
today's exact tips. Backtest-script smoke tests. Suite stays green (478+).

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| New markets dilute the surest pick | Warehouse anchors + Safe maturity floor + shrunk `safePrior` (§5) |
| Bookmaker margin/trap prices | Book-integrity guards (§4.2) |
| Unknown persisted key breaks settle | Registry is the only writer of `tip_market`; server throw stays loud; browser uses `tipHitSafe` |
| Calibration cell identity breakage | `marketGroup` superset, never a replacement |
| AI review cost creep | `TIP_AI_DAILY_CAP` unchanged — top-confidence tips still capped |
| Betika lacks DNB/Odd-Even | One-provider-full-group rule already handles BetPawa-only families |
| `tip_market` overflow | VARCHAR(32) migration before any new-key write |

## 12. Out of scope

- HT/FT, halves, multigoals, correct score, player props as tip candidates
  (display-only; the registry design makes them a later increment).
- Corners/cards settlement (no numeric warehouse path).
- Per-family hot-pick gates beyond O/U lines.
- Profitability claims (the vig stands; labels measure, never advertise).
