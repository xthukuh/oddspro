# Detour A + B plan — AI worker, pipeline optimization & safety harness (2026-07-17)

Repo-side condensation of the executed plan (the full working plan with
T-level detail lived in the session plan files). Design record:
`docs/superpowers/specs/2026-07-17-detour-ab-ai-worker-and-safety-design.md`.
Baseline suite 613/613.

## Branch 1 — `perf/pipeline-detour-a` (merged to `main` `ac54bfc`, suite 653/653)

- **T1** `src/db/adjudicate-rules.js` (pure) + tests: `priceWithinTolerance`,
  verdict-time context readers (`hotVerdictContext`/`tipVerdictContext` off
  the review JSON's `judged`), `canReuseHotVerdict`/`canReuseTipVerdict`
  (market re-pick always re-fires), shared pending predicates
  (`hotReviewPending`/`tipReviewPending` - worker and summary counts can
  never drift), `selectTipReviews` (reuse never consumes budget),
  `latencyStats`, `marketLine`. Knobs `HOTPICK_AI_CONCURRENCY` (4),
  `TIP_AI_REUSE_PRICE_TOL` (0; `.env` 0.05), both catalog `live:true`.
- **T2** Sweep slim-down: the 8 verdict columns left `PICK_COLUMNS` + the row
  literal (worker-owned; the settle-columns idiom); both in-sweep AI batches
  deleted; read-only reusable-veto re-apply kept (`hot` stays sweep-owned;
  AI can veto, never promote); `pending_reviews` surfaced in the return +
  `hotpicksSummary()`.
- **T3** Adjudicator transport retry: `_adjudicate` onto the retried
  `complete()`; text-level `parseVerdict` split out of `parseAiReply`.
- **T4** `src/ai-worker.js` + `node src/index.js aireview`: 60s unref'd tick
  (skips while a refresh job runs), derived-predicate selection (+03:00
  projection, kickoff-ASC), per-EAT-day billed budget (in-memory per
  process), `_batch` at `effective('HOTPICK_AI_CONCURRENCY')` then
  SEQUENTIAL PK updates, fresh reviews persist verdict-time `judged`
  context, fresh veto sets `hot=0`, per-call kickoff re-check, 5-consec-
  error abort.
- **T5** `src/db/odds-refresh-rules.js` (pure) + tests: `parseOddsTiers`
  (`ODDS_REFRESH_TIERS`, default `90:0,360:30,1440:120,*:360`),
  `oddsRefreshDue` (fail-open true), `lightPassIdle` +
  `AUTO_IDLE_LOOKAHEAD_MINUTES` (120, clamped ≥ first tier).
- **T6** `store.oddsExcludeIds` (union with `completedMatchIds`; +03:00
  DATE_FORMAT projection) wired into the light pass only; full sweep +
  manual refresh bypass backoff. A5: `/api/columns` pre-warm.
- **T7** `.HALT` kill-switch (`src/halt.js`): boot refusal exit 1 + own 30s
  watcher + one graceful-shutdown path; gitignored.
- **Checkpoint A** (all passed): sweep 75min→1.9s; drain 31 calls @ c4 in
  161s; auto-resume/reuse verified (2nd drain re-billed 0); worker-owned
  columns survived a mid-drain sweep; backoff excluded 245+294 calls; .HALT
  boot-refusal exit 1 + runtime graceful exit 0.

## Branch 2 — `feat/ai-safety-harness` (Detour B)

- **T8** `src/db/ai-guard-rules.js` (pure, 30 tests): `injectionPreamble`,
  `sanitizeReply` (oversize FLAGS, never truncates), `suspicionChecks`
  (observe-only), `parseConsensusModels`/`isCrossVendor`/`consensusVerdict`/
  `consensusFor`, run-guard state machine (`newRunGuard`/`guardVerdict`/
  `recordCall`, latches once tripped), `structuredContract`.
- **T9** `src/ai/harness.js#callStructured` + migration: adjudicators moved
  `gemini.js` → `src/ai/adjudicators.js` (gemini.js transport-only, cycle
  broken), enrichment's 3 call sites migrated, `resolveTask('adjudicate')`
  added. ZERO prompt-byte/tag changes (diff-verified) - re-bills nothing.
  Guard knobs `AI_RUN_MAX_MINUTES` (0) / `AI_BREAKER_AFTER` (5), catalog
  `live:true`; one guard per drain / per enrich run; refusals → 'error'
  verdicts. 16 harness tests (DI-injected callModel/getProvider).
- **T10** DARK switches: `AI_INJECTION_PREAMBLE` (grounded prompts only -
  adjudicator `_protocol` + enrichment facts prompt; bumps #p3→#p4 / #e2→#e3
  via pure `effectivePromptVersion` while on) and `AI_CONSENSUS_TASKS/
  MODELS/MIN_AGREE` (cross-vendor panels, ADJUDICATE task only,
  ensemble-aware `aiModelTag` via the harness's `ensembleTag`). Both OFF,
  .env-only; enabling = explicit go + dated memory-bank note (templates in
  `docs/memory-bank.md`).
- **T11** `scripts/ai-scorecard.js` (read-only): S1 hot adjudicator per tag
  (+veto-saved units), S2 tip reviewer (+price drift vs judged context),
  S3 blind Brier/reliability, S4 error verdicts/day, S5 per-day verdict
  coverage of settled rows.
- **T12** this docs pass (specs/plans, implementation-plan milestone,
  CLAUDE.md, DEPLOYMENT.md, memory-bank templates, .env.example coherence).

## Verification

Offline suite per task (613 → 653 → 705+). Harness regression: one `aireview`
drain + one enrich run post-migration must re-bill nothing and keep tags
byte-identical; `node scripts/ai-scorecard.js` runs read-only. Invariants:
no rewrite of settled/past-kickoff rows anywhere; AI veto-only; freeze idioms
(+03:00-safe `kickoff > NOW()`) asserted in pure tests.
