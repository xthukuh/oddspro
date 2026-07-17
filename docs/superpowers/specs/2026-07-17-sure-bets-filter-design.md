# Sure Bets — daily top-10 safe list (design)

Date: 2026-07-17. Status: IMPLEMENTED 2026-07-17 (branch `feat/sure-bets-filter`,
plan `docs/superpowers/plans/2026-07-17-sure-bets-filter.md`, suite 714/714,
browser-verified). Execution note: the pool is gated by the DEFAULT_SAFE
LITERALS exactly as §3.1 states — wiring it to the env-merged effective policy
was tried first and starved the list to zero-days on a host with
SAFE_MIN_PARTS=3 (§2's "tighter starves", live-confirmed); §5 already excludes
env/user tunability from v1.
Owner intent (verbatim goal): "a custom filter for magic called sure-bets only …
the best top 10 multibet safe list daily. Warning where no viable options exist
or showing just the available ones."

## 1. Evidence base (read-only replays, 2026-07-17)

Engine accuracy at design time (settled ledger, 1,163 tips / 15 days,
2026-07-03..17): tips 70.7% hit at avg price 1.36 vs 73.4% break-even
(−4.2% flat ROI); hot picks 69.6% vs 74.4% break-even (−7.0%). The engine
picks winners well and still loses the vig — every Sure-bets claim below is a
SURVIVAL claim, never an EV claim.

Two replays of a daily "top-N safe list" (shipped safe gates), both with the
tips frozen at kickoff (no result leakage in any selection field):

- LODO (day D scored by calibration from all other days — the
  `simulateStrategies` convention).
- STRICT WALK-FORWARD (day D uses only days < D, expanding window — zero
  look-ahead; demanded by the user mid-design and it confirmed LODO).

Findings (all small-n; 15 days total, 8 in the current TIP_MIN_PRICE=1.35
regime — labels stay honest):

1. Pool volume: ~8–9 qualifying legs/day at cap 10; 2/15 zero-days (both
   early cold-start days with thin prior calibration).
2. Per-leg quality is FLAT (~71–76%) across every ranking tried (`sure`,
   `confidence`, `market`, `agreement`, `cal_conf`, `cal_market`,
   `price_band`, raw `estimateLegProb`). No ranker separates good from
   better inside the gated pool at this sample size.
3. The `sure` strategy's TOP ranks underperform (rank #1 realized 63–64%
   vs ~85% at ranks 8–10, n≈14/rank) — short-priced favourites at the top
   are the weakest legs. Anomaly, consistent across scopes, not yet
   actionable beyond "don't sort Sure bets by `sure`".
4. `estimateLegProb` is well calibrated where the mass is (predicted 73.0%
   vs realized 73.5%, n=381 in [0.7,0.8)) and OVERCONFIDENT above 0.8
   (83% claimed / 71% real, n=28) — never render a leg as near-certain.
5. Quality floors above the gates control volume, not quality (t=0.78
   starves to zero in the current regime); the volume tier fills 10/day but
   drags full-slip survival to 0%; max-precision starves (1 leg / 8 days).
6. Multibet math: at ~75% legs a 10-leg accumulator survives ~5–7% of days
   (replay: 7.1% LODO, 0% volume tier). A top-3 slip landed 43% of the last
   7 walk-forward days (theory 0.72³≈37%). The honest product is the LIST +
   small guided slips, not a 10-leg ticket.

## 2. Decisions

- POOL = the shipped safe gates UNCHANGED (`DEFAULT_SAFE`: minParts 2,
  minAgreement 0.65, maxPrice 1.6, minSamples 6, minMarketSettled 30 via
  the supplied calibration). Measured as tight as the pool tolerates;
  looser adds the worst legs, tighter starves. One gate definition
  everywhere — no second taxonomy.
- RANK = `estimateLegProb` DESC (the calibrated posterior the betslip
  already displays). Statistically tied with the alternatives (finding 2)
  but self-consistent — the number we sort by IS the number the survival
  meter shows — and it sidesteps the `sure` top-rank anomaly (finding 3).
- CAP = 10/day ("top 10"), SHOW WHAT EXISTS: "Sure bets — N of 10 today";
  thin days show N<10 with no padding; N=0 shows an explicit warning
  ("No sure bets today — no fixture passed the safety gates"). Zero
  quality floor beyond the gates (finding 5).
- GUIDED SLIPS, not one big slip: a one-tap "Top-3 slip" into the existing
  betslip playground (suggested slip size 3; survival meter live-collapses
  as legs stack, which teaches the multibet math better than any warning).
- SIGNED-IN ONLY: guests lack `tip_breakdown` (redacted server-side), so
  the gates cannot evaluate — and the "why" is the guarded secret anyway.
  Guests see a sign-in nudge on the toggle.
- NO generation-side changes, no new env knobs in v1, no ledger rewrites,
  no +EV claims. Constants live in the pure module; admin tunability can
  follow later if live use demands it.

## 3. Components

1. `src/db/magic-rules.js` (pure, shared verbatim server/web):
   - `DEFAULT_SURE_BETS = { maxPerDay: 10, slipSize: 3 }`.
   - `sureBetsSelection(rows, cal, opts = DEFAULT_SURE_BETS)` → ordered
     `[{ row, prob }]`: dedup one row per canonical fixture (`api_id`,
     same idiom as `safeSelection`), gate via `safeQualifies(row,
     DEFAULT_SAFE, cal)`, rank by `estimateLegProb(tipView(row), cal)`
     desc (null prob = excluded), stable ties, slice `maxPerDay`.
     Returns probs so consumers never recompute or drift.
2. Server: NO changes. The web already receives `calibration` from
   `GET /api/magic-sort` and imports magic-rules verbatim.
3. Web:
   - Toggle `oddspro.show.sureBets` — a "Sure bets" row in the ✨ Magic
     sheet (`MagicMenu.jsx`), disabled with a sign-in nudge for guests.
   - Filter: membership by `api_id` over the WHOLE loaded selection
     (computed before other row-hiding toggles, exactly like Safe-only,
     so filters/toggles never change who wins the cap); all provider rows
     of a qualifying fixture survive.
   - `ViewPills.jsx` chip: "Sure bets (N of 10)" with `×` off; the pill is
     where N lives. N=0 renders the warning banner in place of the chip
     (toggle stays on; the user sees WHY the table is empty).
   - Interaction with 🛡 Safe only: independent toggles; when both are on
     their membership filters AND (Sure bets ⊆ safe pool by construction,
     so in practice Sure bets wins — both pills stay visible and honest).
   - "Top-3 slip" action (in the Magic sheet row / pill): seeds a slip
     with the top `slipSize` legs via the existing betslip persistence
     (`oddspro.betslips`; legs are self-contained) and opens the
     playground — `slipSummary` already shows survival/EV there.
4. Tests (offline, node:test — extends the magic suite):
   `sureBetsSelection` ordering by prob, cap enforcement, thin-day
   passthrough (N<10 unpadded), empty pool → `[]`, one-per-fixture dedup,
   gate reuse (a `safeQualifies` reject never enters), prob carried on
   entries; web membership helper covered in `filterValues` tests.
5. Docs: `docs/safety-net-protocol.md` gains a "Sure bets" section (the
   honest numbers above + suggested stakes); CLAUDE.md web/magic notes get
   one line each.

## 4. Honesty contract (rendered in UI copy where details are allowed)

Per-leg ~72–76% live; top-3 slip ≈ 40% of days at combined odds ~2.4–3.5;
a full 10-leg stack survives ~5–7% of days; flat-stake EV remains ≈ −vig.
Sure bets maximizes the chance a small slip SURVIVES; it does not promise
profit. `VITE_SHOW_DETAILS=0` builds keep methodology hidden as everywhere
else; the feature itself (list, counts, warnings) still works.

## 5. Out of scope (v1)

Auto-split portfolios, tier pickers, admin knobs/env overrides, guest
access, any change to tip generation or `DEFAULT_SAFE`, footer changes,
re-ranking research beyond finding 3 (tracked as a future analysis, only
via replay scripts).
