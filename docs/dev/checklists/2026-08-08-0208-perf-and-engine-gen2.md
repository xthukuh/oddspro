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

- [x] D1. DONE (121,846 legs / 38 days / 22 dimensions): systemic UNDER bias confirmed in BOTH half-windows (z 4.5 / 7.8) - the deepest inefficiency, already exploited by production cells; short bands underpriced-in-probability but margin-eaten; context-only dims carry ZERO information; 26 in-sample positive-ROI cells (led by under|Australia +14% n=2082) recorded for OOS audit; forward-validated streaks live in the 1.02-1.05 bands (O0.5|strong 99.5% fwd n=182)
- [x] D2. DONE (scripts/evolve-vector.js, 156 generations): profit arm +17.5u train / -3.7u test = TRAIN MIRAGE, fails both-windows (in-sample country edges did not carry); search dropped group|country itself; surviving dims = group|band (1.74 - the production cell key, VALIDATED), group|devig, dir|ou; engine UNDERCLAIMS (59.3% claimed vs 64.4% realized)
- [x] D3. Verdict per pre-committed rule: NO bake (both-windows failed); production calibration validated as the fundamental layer; vector machinery ledgered as the monthly re-audition (one command) as data grows; per-day SELF-CHECK chip shipped in DailyMultibet (claimed vs realized over settled legs, green when honest)

## Added 2026-08-08 (owner): high-value hunt + Hunter arm

- [x] E1. High-odds hunt (scripts/hunt-value-lines.js, 196+257 generations, Dixon-Coles model + hunt cells + streak weapons + reliability cascade): mid band [2.0,3.5) BOTH-WINDOWS POSITIVE (+21.4% train / +32.3% test / +24.9% full, streak 5 @ 1 pick/day); high band positive-but-volatile (reduced trust); moon [6,15) failed OOS everywhere - not offered
- [x] E2. Baked as src/db/value-hunt.js (pure, DEFAULT_HUNT) + Hunter singles card in buildDailySlip v2.1 (singles semantics: never a parlay rollup; tip-contradiction guard; fixture-exclusive vs ladder)
- [x] E3. Timeline re-backfilled (v2.1-hunter): hunter singles +9.6u flat over 74 legs (35.1% at avg ~3.1x); ladder metrics unchanged (additive)
- [x] E4. Scores on slip lines: settle + backfill persist final score per leg; UI renders score chip with hit/miss tick on every settled line
- [x] E5. Browser-verified (local full-access serve): all 4 tier headers + HUNTER SINGLES · 2 BETS on today, per-card WON/LOST, hunter P&L chips, score chips, self-check 74% vs 76% claimed; full records payload carries every market/stat column
- [x] E6. Purpose-obviousness: Daily MultiBet promoted to a first-class nav button (opens the sheet directly)
