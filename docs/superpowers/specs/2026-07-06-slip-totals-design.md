# Betslip playground — one-click full autogeneration + totals bar

Date: 2026-07-06
Status: approved (user directive; autonomy standing for the session)

## Problem

"Fill from top" creates one slip per click — draining a 60-tip day takes 15
clicks. And there is no aggregate view: the playground grades each slip
WON/LOST individually but never totals the virtual book.

## Design

**Fill from top drains the pool (`BetslipPlayground.jsx`).** One click chunks
ALL unused candidates into successive `maxLegs`-sized slips (ranked order
preserved; the last slip takes the remainder). Button tooltip states the count
("Autogenerate N slips from all M unused tips"); still disabled when nothing
is unused. Naming continues the `Slip <n>` sequence.

**Totals — pure `slipTotals(slips, stake)` in `src/db/magic-rules.js`**
(beside `slipSummary`/`slipOutcome`, offline-tested):

- `{ slips, won, lost, open, staked, returned, profit }`
- empty slip cards are skipped (not bets); `staked` = stake × counted slips;
- a slip's state comes from `slipOutcome(legs)`; `returned` sums
  `slipSummary(legs, stake).payout` of WON slips only;
- `profit` = returned − stake × (won + lost) — settled slips only; open
  slips' stakes are not yet lost (the UI shows the open count instead).

**Totals bar (UI).** Rendered under the slips list whenever at least one
non-empty slip exists: `N slips (w won · l lost · o open) · staked X ·
returned Y · P/L ±Z` — P/L green when ≥ 0, red otherwise, with a "settled
slips only" tooltip.

## Untouched

Candidate ranking, hide-used toggle semantics, per-slip cards/grading,
persistence shape (slips store the same fields; totals are derived).

## Decisions log

- One click = full drain (user directive) — replaces click-per-slip.
- P/L excludes open slips (default chosen; open count shown).
- Empty slip cards excluded from totals (default chosen).
