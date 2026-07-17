# Betslip playground — slip autogeneration + hide-used toggle

Date: 2026-07-06
Status: approved (user: "proceed autonomously until you're done")

## Problem

"Fill from top" always takes the top `maxLegs` ranked candidates, so repeated
clicks re-create the same slip. Tips already placed on a slip also clutter the
drag list.

## Design (UI-only, `web/src/components/BetslipPlayground.jsx`)

- **Used-tip tracking:** `usedIds` memo — the set of `api_id`s across all
  slips' legs. A tip is "used" while it sits on any slip; removing the slip or
  leg frees it.
- **Fill from top autogenerates:** each click builds a slip from the top
  `maxLegs` UNUSED candidates (ranked order preserved) — successive clicks
  walk down the ranking (ranks 1-4, then 5-8, …) until the day's tips are
  exhausted. The final slip takes the remainder (may be short; the existing
  min-odds warning covers it). Button disables when nothing unused remains
  (tooltip: "All tips are already on slips").
- **Hide-used toggle:** checkbox beside the stake/legs/odds inputs filters
  used tips out of the candidate list. Purely visual — Fill always skips used
  regardless. Persisted as `hideUsed` in the existing `oddspro.betslips`
  config blob, **default ON**; old stored configs without the key pick up the
  default via the existing spread-merge. List header shows the hidden count;
  empty list distinguishes "All tips are on slips." from "No tips on this
  view."

## Untouched

Candidate ranking, drag/+ mechanics, slip grading/backtest, per-date slip
persistence, `live`/"gone" semantics, all pure modules and the server.

## Decisions log

- Both features, Fill always skips used (user-picked over toggle-governed or
  Fill-only).
- Autogenerate until exhaustion (user follow-up), remainder slip allowed.
- `hideUsed` defaults ON (approved with the design).
