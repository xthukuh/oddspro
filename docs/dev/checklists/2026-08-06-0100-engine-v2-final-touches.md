# Engine v2 Final Touches: checklist

Spec: `docs/dev/specs/2026-08-06-0100-engine-v2-final-touches-design.md`
Plan (Phase 0+1): `docs/dev/plans/2026-08-06-0100-engine-v2-final-touches.md`

## Phase 0: alignment guard
- [x] Charter memory file written (global auto-memory) + MEMORY.md index line
- [x] This checklist created
- [x] Spec + plan + checklist committed (e5afd17)

## Phase 1: Daily MultiBet engine — COMPLETE 2026-08-06
- [x] Task 1: `src/db/leg-calibration.js` extracted pure + tests, replay script repointed (637463b)
- [x] Task 2: `src/db/daily-slip-rules.js` (gates, construction, mood, rollup, streaks) + tests (105817c)
- [x] Task 3: `src/db/feature-rules.js` premium seam + tests (b50bc0d)
- [x] Task 4: `daily_slips` migration applied, batch 22 (34f57e8)
- [x] Task 5: `src/daily-slip.js` builder + settle + CLI `dailyslip` + pipeline/light-pass wiring + live smoke run (fcab5b8; caught + fixed the CURDATE-as-Date EAT off-by-one)
- [x] Task 6: `GET /api/daily-slip` + `/api/daily-slip/timeline` behind premium seam, curl-verified teaser vs full (ecaa08a)
- [x] Task 7: 3 simulation grid rounds (158 cells), `DEFAULT_DAILY_SLIP` baked (prob/0.96/top-6 = 86.7% green, streak 8), 35-day walk-forward backfill, research doc `docs/research/2026-08-06-daily-multibet-simulations.md` (a55ab55)

## Phase 2: rendered-output API + PATs — COMPLETE 2026-08-06
Plan: `docs/dev/plans/2026-08-06-0100-engine-v2-phase2-rendered-api-pats.md`
- [x] `src/pat-rules.js` pure crypto module + tests (mint/hash/route matrix)
- [x] Migration batch 23 `personal_access_tokens` (bigint FK lesson: users.id is bigIncrements)
- [x] `src/pats.js` service (create+audit, list view, idempotent revoke, throttled resolve)
- [x] Server wiring: optionalAuth opat_ path (read-only 403), dual-auth admin mint/list/revoke
- [x] `src/view.js` + `GET /api/view` (strategy sort, safe/sure/daily flags, one-of-each, safe-only)
- [x] Admin → API tokens section (mint with one-time reveal, revoke), build:web green
- [x] E2E verified live: mint via ADMIN_TOKEN, PAT reads view/daily-slip full, PAT 403/401 on writes+admin, guest 401 on view, revoke kills, one-of-each 208→110
- [x] docs/guides/api.md extended (PAT flow + /api/view with captured example)

## Phase 3: frontend v2 + timeline UI — COMPLETE 2026-08-06
Plan: `docs/dev/plans/2026-08-06-0100-engine-v2-phase3-frontend-v2.md`
- [x] `legCellProb`/`bankerProb` + v2 strategies (banker rowScore/target/value) in magic-rules
- [x] `estimateLegProb` prefers evidence-backed leg cells (n>=30); `scoreTip` rowScore path
- [x] Sure Bets = banker top-N (calibrated; tip path kept as no-banker fallback)
- [x] `magic.js`: banker ledger columns, `calibration.leg_cells` attached, payload menu = trio
- [x] Web: default sort `banker`, `DailyMultibet.jsx` timeline modal (streaks, reasoning,
      provider toggle, backfilled tags, guest nudge), MagicMenu row, api wrapper
- [x] Verified live: payload trio + 77 leg cells; /api/view banker top = calibrated 97.2%
      X2@1.01; sure count 9→10 under banker ranking; target prefers odds-bearing legs;
      suite 1054/1054; build:web green
- [x] CLAUDE.md EV headline refreshed (−5.3% live) + v2 menu/Daily MultiBet notes; api.md updated

## Phase 3.5: error-feedback calibration (owner directive 2026-08-06) — COMPLETE
- [x] leg-calibration v2 options: recency decay (halfLifeDays) + hierarchical league layer (leagueK), byte-compat defaults, tests 15/15
- [x] Grid round 4 (construction pinned): league layer REFUTED (75.8% vs 86.7%, thin-sample inflation); decay identical at n=35
- [x] Decay BAKED at half-life 30 (`v1.1-heal-2026-08-06`) for the healing property; league plumbing kept inert for re-tests
- [x] Research doc round-4 section; suite 1056/1056

## Phase 3.6: evolution loop (owner directive 2026-08-06) — COMPLETE
- [x] `scripts/evolve-daily-slip.js`: deterministic coordinate-descent, train/test split,
      streak-feature dimensions; converged gen 5 (~85 evals)
- [x] Champion BAKED v1.2-streak: floor 0.95, top-5, streak-first ranking (unbroken cells
      first) — full window 91.2% flat / 88.2% with decay, best streak 8 -> 12; test-tail tie
      recorded honestly; hard streak gates rejected (starve publishing)
- [x] Timeline regenerated (30/34 green, streak 12); suite 1057/1057; research doc round 5

## Phase 3.7: multi-card days (owner directive 2026-08-06) — COMPLETE
- [x] grouping-daily-slip.js battle test: all splits 100% any-green (35/35); split-2x2 baked
      (v1.3-cards, batch 25 cards columns, per-card settle, card-sectioned timeline UI)
- [x] Backfill regenerated: 32/32 multi-card days any-green, 28/32 both-green; suite 1059/1059

## Phase 4: shareable user slips — COMPLETE 2026-08-06
- [x] slip-code.js (Crockford 6-char + tolerant normalize) + tests; user_slips batch 24
- [x] user-slips.js (sanitized legs, server odds, collision-retried mint, anonymous by-code
      load, light-pass settle); session-only routes behind slip_sharing seam
- [x] Web: playground Save (share-code note) + My slips sheet (timeline, copy, load-by-code
      as provenanced copy, delete); build green
- 2026-08-06 06:20 EAT alignment check: all owner directives this session executed and
  battle-tested; honesty rule held on every bake (any-green is labeled survival, not
  profit); no drift. Full effort now delivered: Phases 0-4 + 3.5/3.6/3.7.

## Alignment checks
- 2026-08-06 05:10 EAT: Phase 3 boundary. Core objective served directly: the DEFAULT
  table order is now the calibrated survival ranking (banker), the menu is the v2 trio,
  and the Daily MultiBet timeline is user-visible with honest backfilled labeling.
  One calibration layer end to end (grids -> daily slip -> menu -> slip meters), no
  second definition. EV headline refreshed to the live number (honesty rule: reported
  plainly, experiment continues). No drift.
- 2026-08-06 04:05 EAT: Phase 2 boundary. Grounding objective served: /api/view gives
  Claude and n8n the owner's exact rendered view (verified against live data, daily-slip
  flags consistent with the backfilled timeline). Security invariants verified by
  behavior, not assertion (read-only matrix, admin exclusion, one-time plaintext,
  revoke). Verification rule honored: the migration FK failure was diagnosed to root
  cause (bigint users.id) instead of worked around. No drift.
- 2026-08-06 01:10 EAT: session start; charter written; work in flight (Phase 0/1) serves the core objective; no rule drift.
- 2026-08-06 02:50 EAT: owner added two standing rules, both executed: (1) verification
  discipline - charter updated, confirmed-facts ledger created, reverification pass run
  (grid re-run reproduced the winner line exactly; freeze behavior confirmed live via a
  scratch past-kickoff row; teaser/full re-captured); (2) API documented with REAL captured
  examples in docs/guides/api.md. No drift; no escalation-worthy doubts open.
- 2026-08-06 02:15 EAT: Phase 1 boundary. Core objective served: the Daily MultiBet timeline exists and judges the algorithm (86.7% green, streak 8, hindsight-free). Honesty rule honored both ways: negative flat P&L reported plainly AND the experiment continues (pre-registered next steps in the research doc). Owner decisions intact: combined odds uncapped (the depth cap bounds LEGS, licensed by "realistic limits and strict selection checks"); premium seam structural only; no live knob moved without dating (algo_version stamps the regime). No drift found.
