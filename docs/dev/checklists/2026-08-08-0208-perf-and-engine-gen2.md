# Perf + engine gen-2 - checklist

Spec: docs/dev/specs/2026-08-08-0208-perf-and-engine-gen2-design.md

- [x] 0. Data refreshed (full sweep ran; odds/results/tips current to 02:25 EAT, enrich tail still running)
- [x] A1. Perf audit: magic-sort COLD 25s (the stall), records 0.47s/32KB gz, daily-slip 17ms, static already immutable-1y
- [x] A2. magic-sort folded into the 30s warm tick (boot + day-roll + recycle covered): first-hit 25s -> 452ms verified
- [x] A3. API_DETAILS knob (settings group bot, live): signed-in payloads strip tip_breakdown/AI reviews/hot signals (~113-256KB/day raw) when the prod build never renders them; CLI/CSV/machine bearers never slimmed; tier-keyed cache slot
- [x] A4. Measurements above; re-measure on prod post-deploy
- [x] B1. Diagnosis: only profitable tip pockets = TT U 1.5 (+5.3u, 72.2%); O 1.5 worst (-46.4u); banker ledger 94.4% but sub-break-even at <1.2 prices; >=1.45 zone: TT/O3.5/GG carry signal, 1X2-derived markets efficiently priced
- [x] B2. Contradiction audit: 383 tip-vs-banker directional conflicts; NO guard existed anywhere (contradicts() was unwired); FOUND+FIXED the settle defect (decided days froze legs null: live 08-06 true 6/10 not 1/10, 08-07 true 2 cards WON not 0) - the "live collapse" was mostly settle+population-skew artifacts
- [x] B3. Gen-2 harness scripts/evolve-gen2.js: 313 evaluated generations (descent + pair widening + per-tier refine), errorBoost error-feedback, both-windows rule; champion any-green 83.8% full / 83.3% test, streak 13, anchor 64.9%@1.61x (+1.7u), top3 positive EVERY window
- [x] B4/B5. Owner granted overhaul freedom mid-session; baked as selectLadderCards/DEFAULT_GEN2 + buildDailySlip v2.0 (eligibility screen, tip+cross-card contradiction guards, anchor-strict day verdict); timeline backfilled honestly (24/37 anchor-green, 31/37 any-card); suite 942/942; live 08-08 slip = anchor 1.61x + double 2.07x + top3 3.42x, grand honestly absent
- [x] B6. DailyMultibet ladder UI: tier chips + tooltips with honest replay records, per-card WON/LOST, ladder explainer
- [x] B7. isRetryableApiError: 403/408/429/5xx exponential backoff (4 tries, 1.5s base) on api-sports GETs; tested
- [ ] B8. QUEUED (pre-registered, next engine iteration): wire fixture_statistics (shots/corners/cards, 28.5k rows already warehoused) into the goal model as walk-forward-provable features; also team-total cell splits once months of ledger exist
- [ ] B9. Fetch-economy: fetch-once flags already cover immutables; 403 backoff closes the biggest waste (aborted sweeps refetching). QUEUED: per-phase sweep checkpointing (resume a failed sweep mid-phase)
- [x] C1. Docs synced (CLAUDE.md current-state, QUICK-REFERENCE routines)
- [ ] C2. OWNER GREEN LIGHT -> stop live server warning -> deploy (--db --app --web) -> restart -> smoke
- [ ] C3. Re-tag v1.4.0 at the shipped HEAD (owner)

## Added 2026-08-08 (owner): independent market-pattern investigation

- [ ] D1. Wide-net investigation: odds markets vs outcomes over every settled fixture with pre-kickoff odds; multi-dimensional feature categorization; per-dimension information content; FORWARD-validated unbroken-streak cells (no selection bias)
- [ ] D2. Vector-memory learner: per-day self-evaluating walk-forward engine (dimension-weight backprop on misses, anomaly quarantine, streak weaponization, accuracy-enforcement governor); high-count deterministic meta-search, both-windows rule
- [ ] D3. If test-confirmed better than the gen-2 ladder ranking: bake as the fundamental ranking core + per-day self-evaluation stored on the timeline
