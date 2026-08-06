# Engine v2 Final Touches: design

**Date:** 2026-08-06 · **Branch:** `feat/engine-v2` · **Status:** approved by owner 2026-08-06

Owner brief (2026-08-06): programmatic access to the exact rendered front-end output,
personal access tokens for third-party integrations (n8n), a "Daily MultiBet" slip
timeline with realistic backfilling as the v2 engine's battle test, shareable user
betslips with human-friendly codes, a frontend v2 refactor of the magic sorts, and a
standing self-alignment mechanism against context drift.

## Decisions locked with the owner

1. **Build order:** Algorithm → API → Frontend → Shared slips (owner approved the
   recommended order over the literal brief order).
2. **Algorithm goal:** banker-style max survival with UNCAPPED combined odds. On strong
   days take every leg that passes the strict gates (milk more where safe), on weak days
   shrink toward the minimum of 2, and publish an honest no-slip entry when fewer than 2
   qualify. Never force a leg to hit a target.
3. **Premium prep:** structural seam only. One pure `featureAllowed(user, feature)`
   gate wired where premium checks will live; everything stays visible for now. No
   billing, no plans, no enforcement.
4. **Magic sorts:** rebuild the menu around v2. Legacy 11 strategies leave the UI
   (code kept for replay); three calibration-powered strategies replace them.
5. **Honesty rule (owner, 2026-08-06, verbatim intent):** honesty is a reporting
   standard, never a limitation on experimental efforts. Intention is negated only by
   proper proof or by the owner's consent. We label results honestly AND keep running
   the ambitious experiment.

## Phase 0: Alignment guard

- Global memory file `engine-v2-alignment-charter.md` (auto-memory dir) holding: the
  core objective (the most optimal top-to-bottom survivability order, chained into
  multi-bet slips whose top few are experimentally "guaranteed" survivable), the
  standing rules (unbounded capability, survival-first reporting, honest labeling
  without experimental limitation, never move a live knob mid-experiment without dating
  it, writing style), and the checkpoint ritual.
- Checkpoint ritual: at every phase boundary and before every major commit, re-read the
  charter and the live checklist, then record a one-line dated alignment check in the
  checklist. Drift found = stop and re-ground before continuing.
- Checklist: `docs/dev/checklists/2026-08-06-0100-engine-v2-final-touches.md` tracks
  all phases with per-item status.

## Phase 1: Daily MultiBet engine

### Calibration layer (shared, pure)

Extract `makeCalibrator` from `scripts/replay-daily2x.js` into pure zero-import
`src/db/leg-calibration.js`: per-cell (market group × price band) realized hit rates
from PRIOR days only, beta-shrunk (k=50) toward the devigged implied probability.
Walk-forward by construction, so estimates tighten automatically as the settled ledger
grows, with no future re-tuning required. Shared by: the simulation harness, the
production slip builder, and (Phase 3) `estimateLegProb` upgrades.

### Slip rules (pure)

New `src/db/daily-slip-rules.js` (zero imports beyond other pure modules):

- **Candidate gate** (strict AND): calibrated leg probability ≥ floor; price inside the
  candidate window (default pool ≤ 1.35 per the calibration audit, sim-tunable); market
  cell has ≥ minimum settled observations; one leg per fixture (its best calibrated
  leg); per-league cap (default 3) against correlated legs.
- **Construction:** rank qualifiers by calibrated probability descending, take all that
  pass. Combined odds are UNCAPPED by design (decision 2). Fewer than 2 qualifiers ⇒
  no-slip entry for the day.
- **Day mood:** green/amber/red from pool depth and mean calibrated probability of the
  taken legs, stored on the slip and shown in the UI. Thresholds fixed by simulation.
- **Slip outcome rollup:** won (all legs hit or void), lost (any leg missed), void
  (all legs void), pending. Legs settle individually via the existing `tipOutcome`
  taxonomy (hit/miss/void).

### Simulation harness

`scripts/simulate-daily-slip.js`: hindsight-free replay over the warehouse (and the
`oddspro-v2` replay env) across a parameter grid (prob floor, price window, league cap,
cell maturity minimum, mood thresholds). Scored by green-day rate, then best/mean
streak, then flat P&L. The winning set is baked into `DEFAULT_DAILY_SLIP` in the pure
module with the run date and numbers recorded here and in a research doc. Guardrails
from the mine discipline: temporal OOS split, no re-rolling until it looks good
(seeded), and a policy-regime note if any live knob changed mid-window.

### Storage and settle

Migration `20260806000001_daily_slips`: table `daily_slips`, one row per EAT day
(`slip_date` unique):

- `slip_date DATE` (unique), `status ENUM(published, no_slip)`,
  `mood ENUM(green, amber, red)`, `legs JSON` (self-contained: fixture id, teams,
  kickoff, market key + label, per-provider prices, chosen price, calibrated prob,
  plain-language reasoning), `combined_odds DECIMAL`, `legs_total`/`legs_hit` INT,
  `outcome ENUM(won, lost, void) NULL` (pending = NULL), `algo_version VARCHAR`,
  `backfilled BOOL`, `computed_at`, `settled_at`, standard timestamps.

Freeze discipline (house idiom): the builder upserts the current day's slip only while
ALL its legs are pre-kickoff under `KICKOFF_SQL_EXPR`; a leg that kicks off pins itself
(never swapped); once any leg kicks off the slip row is frozen except for the settle
columns. The settle pass (extension of `settleHotPicks`) grades legs from canonical FT
scores and writes `legs_hit`/`outcome`/`settled_at` exactly once.

Backfill: the replay generator writes historical `daily_slips` rows walk-forward
(pre-kickoff odds only, prior-days calibration only), `backfilled = true`, so the
timeline is honest about live vs replayed entries. The backfilled timeline is the v2
battle test: its green-day rate and streaks are the verdict.

### API

`GET /api/daily-slip?date=` (one slip) and `GET /api/daily-slip/timeline?days=`
(recent entries plus streak stats: current streak, best streak, green-day rate).
Read-gated through the premium seam (currently: signed-in allowed; guests get a teaser
count only). Wired into the serve pipeline after hot picks so the day's slip reflects
the latest tips.

## Phase 2: Rendered-output API + personal access tokens

### Rendered view endpoint

`GET /api/view?date=` returns the FINAL client-rendered dataset, computed server-side
by running the same pure pipeline the browser runs (`magic-rules` is already shared
verbatim): records → strategy scoring/sort → safe selection → sure bets → daily-slip
membership. Response rows carry rank, sort scores, safe/sure/daily flags, the full tip
justification (`tip_breakdown`), AI reviews, and plain-language labels
(`tipMarketLabel`). Query params: `date`, `strategy`, `toggles` (safe-only,
one-of-each, provider order), defaulting to the app's default view. This closes the
visual-automated consumption gap: Claude and n8n read exactly what the owner sees.

### Personal access tokens

Migration `20260806000002_personal_access_tokens`: `id`, `user_id` FK (CASCADE),
`name`, `token_hash CHAR(64)` (sha256 only, session idiom), `prefix VARCHAR(12)`
(display identification), `scopes JSON` (v1: `["read"]`), `last_used_at`,
`expires_at NULL`, `revoked_at NULL`, `created_by` FK (SET NULL), timestamps.

- Token format: `opat_` + 32 random bytes base64url. Shown ONCE at mint.
- Resolution: bearer starting `opat_` resolves through the PAT table to the owning
  user's access tier, restricted to read-only GET routes. PATs are NEVER valid on
  admin or mutating routes, regardless of the owner's role.
- Admin UI: an "API tokens" card (mint for a user, list with prefix + last-used,
  revoke). Mint/revoke audit rows ride `admin_audit`.

## Phase 3: Frontend v2 refactor + timeline UI

- **Strategy menu v2:** three strategies replace the legacy 11 in the UI, all powered
  by `leg-calibration`: `banker` (calibrated survival order, the DEFAULT sort, same
  order the Daily MultiBet uses), `target` (efficiency-greedy toward a user-chosen
  combined-odds target), `value` (calibrated edge tilt, price × calibrated prob − 1).
  Legacy strategies remain exported for replay/analysis but leave the menu.
- `estimateLegProb` upgrades to the calibrated layer (served through the
  `/api/magic-sort` payload so client and server stay one implementation).
- **Sure Bets = banker top-N** (closes the open engine-v2 wiring item).
- **Daily MultiBet UI:** nav entry opening a timeline modal (Sheet idiom): today's
  card on top (legs, per-leg collapsible reasoning, combined odds, mood badge),
  reverse-chronological past days with won/lost badges, current/best streak counters,
  provider toggle (one entry per provider vs all), `backfilled` marker on replayed
  entries, sign-in nudge for guests.

## Phase 4: Shareable user slips

Migration `20260806000003_user_slips`: `id`, `user_id` FK (CASCADE),
`code CHAR(6)` unique (Crockford base32, no ambiguous chars, ~1.07e9 space, collision
retry on insert), `title`, `legs JSON` (self-contained, same leg shape as
`oddspro.betslips`), `combined_odds`, `outcome ENUM(won, lost, void) NULL`,
`legs_total`/`legs_hit`, `source_code CHAR(6) NULL` (provenance of a copied slip),
`created_at` (the timeline stamp), `settled_at`.

- Save from the betslip playground (signed-in); "My slips" personal timeline reuses
  the Daily MultiBet timeline component.
- Load by code: enter a code, the slip opens in edit mode, saving mints the user's own
  copy with a new code and `source_code` provenance.
- Settle: the same settle pass grades saved slips (virtual-bet testing).
- Sharing sits behind the premium seam (`slip_sharing`).

## Premium seam (cross-cutting)

Pure `src/db/feature-rules.js`: `featureAllowed(user, feature)` over a small feature
registry (`daily_multibet`, `slip_sharing`). v1 semantics: signed-in ⇒ allowed, guest
⇒ teaser. The future subscription work changes ONLY this module plus a `users.tier`
column when it arrives.

## Testing

Every decision surface is a pure offline-tested module: `leg-calibration`,
`daily-slip-rules` (gates, construction, mood, rollup), `pat-rules` (token
format/hash/scope checks), `slip-code` (alphabet, collision retry), `feature-rules`,
settle rollup. Suite must stay green (1036 at start). Server routes get the usual
thin-loader treatment with logic pushed into the pure modules.

## Delivery

Each phase lands as its own commit series on `feat/engine-v2`, checklist updated per
item, alignment check recorded at each phase boundary. Research findings from the
simulation runs land in `docs/research/` with the standard honesty framing: report
what was measured, keep the experiment ambitious (decision 5).
