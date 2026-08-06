# Engine v2 Final Touches: Phase 3 plan (frontend v2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Same effort as the 2026-08-06-0100 spec.

**Goal:** Rebuild the strategy menu around the v2 calibration layer (banker/target/value, banker default), upgrade `estimateLegProb` to leg-cell calibration, make Sure Bets = banker top-N, and ship the Daily MultiBet timeline UI.

### Task 1: engine (magic-rules + magic.js)
- `legCellProb(market, price, devig, legCells)` in magic-rules (cellKey from the pure leg-calibration sibling; shrink toward devig, the makeCalibrator formula).
- Three STRATEGIES appended: `banker` (rowScore: banker leg's calibrated prob; scores tipless-but-bankered rows; fallback tip estimate), `target` (efficiency: survival cost per unit of log-odds, negated so higher = better), `value` (calibrated edge: p x price - 1). All total via fallbacks (LODO replay cal has no leg_cells).
- `scoreTip` gains the rowScore path (strategy.rowScore?.(row, cal) before the tip guard).
- `estimateLegProb`: prefer the leg cell when `cal.leg_cells` carries n >= 30 for the tip's cell; else existing bucket path.
- `sureBetsSelection`: rank by shared `bankerProb(row, cal)` (banker top-N per spec), fallback to the old tip estimate when no banker.
- `magic.js`: `settledTipRows` adds the four `tip_banker_*` columns; `magicSortSummary` attaches `calibration.leg_cells = loadCalibrator(today).export()` (from daily-slip.js) and filters the payload `strategies` to the v2 trio ranked by replay stats.

### Task 2: web
- Default sort = `banker` (the stored-sort revalidation drops stale ids automatically).
- Daily MultiBet: api.js `getDailySlipTimeline(days)`; `DailyMultibet.jsx` modal (Sheet idiom): streak chips, today's card with per-leg collapsible reasoning + provider price toggle, reverse-chronological timeline with mood dot / won-lost badge / backfilled tag; guest sign-in nudge. Opened from a MagicMenu row (the Sure-bets row precedent).

### Task 3: verify + docs
Suite green, `build:web` green, `/api/view?strategy=banker` E2E via PAT, `/api/magic-sort` payload carries leg_cells + trio. CLAUDE.md: EV headline refresh (-5.3% live) + magic-rules blurb. api.md strategies example. Checklist, confirmed-facts, resume point.
