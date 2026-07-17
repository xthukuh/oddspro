# Detour A + B design — AI-review worker, pipeline optimization & AI safety harness (2026-07-17)

Design record for the two urgent detours executed before resuming the M4.3 track
(user request 2026-07-17). Plan: `docs/superpowers/plans/2026-07-17-detour-ab-ai-worker-and-safety.md`.
Detour A merged to `main` `ac54bfc` (suite 653/653, live-verified); Detour B on
`feat/ai-safety-harness`.

## Problem

1. **Detour A:** the daily full sweep took ~85 min (2026-07-16), dominated by
   ~274 sequential grounded Gemini calls inside the hot-picks stage
   (`TIP_AI_MIN_CONFIDENCE=0` reviews every tip; `TIP_AI_DAILY_CAP=250`).
   Light passes re-fetched odds details for matches nowhere near kickoff.
2. **Detour B:** AI calls (Gemini + OpenRouter) had no standard harness -
   each caller hand-parsed replies; no injection guard for grounded web
   content, no runaway-request protection, no per-model bias measurement.

## Detour A — decisions that shape everything

- **Verdict columns are WORKER-OWNED.** The 8 columns (`ai_verdict/ai_reason/
  ai_model/ai_review` + `tip_ai_*`) left the sweep's upsert merge list (the
  settle-columns idiom). The sweep computes rules/tips and never bills AI;
  `src/ai-worker.js` (60s serve tick + `node src/index.js aireview` CLI drain
  for cron-only hosts) owns every verdict write. This also structurally fixed
  the old bug where beyond-cap candidates had stored verdicts NULLed by every
  sweep.
- **Derived pending predicate = auto-resume by construction.** Work is
  selected by "upcoming + hot/tip present + verdict missing-or-stale under
  the adjudicate-rules reuse keys" (kickoff-ASC), never a status column.
  A killed drain resumes for free; nothing to desync.
- **Verdict-time context travels in the review JSON** (`judged: { score }` /
  `{ tip_market, tip_price }`): once the sweep upserts, the row only carries
  the CURRENT evaluation, so reuse must compare against what the verdict
  actually judged. Legacy verdicts without context re-bill once (budget-bounded).
- **`TIP_AI_DAILY_CAP` became an honest per-EAT-day billed budget** enforced
  by the worker (reuse never consumes slots). KNOWN SEMANTICS: the counter is
  in-memory PER PROCESS - the serve worker holds it across ticks; each
  `aireview` CLI invocation starts fresh (cron-only deployment = effectively
  per-invocation, like the old per-run cap). A serve restart resets it (worst
  case one extra cap on a restart day; a billing-timestamp column was
  rejected as YAGNI).
- **Reuse price tolerance** `TIP_AI_REUSE_PRICE_TOL` (config default 0 =
  legacy exact match; `.env` opts into 0.05): a stored tip verdict is reused
  while price drift stays within the relative tolerance; a market re-pick
  always re-fires. Fresh verdicts persist the judged price so drift stays
  measurable (PR-4c honesty; the scorecard's S2 reports it).
- **Odds detail backoff + idle-aware light pass** (`src/db/odds-refresh-rules.js`,
  pure): `ODDS_REFRESH_TIERS` (default `90:0,360:30,1440:120,*:360` - ≤90 min
  to kickoff always refreshes, guaranteeing `is_stale` currency near kickoff;
  invalid/off ⇒ never skip, fail-open) + `lightPassIdle` (skip odds+link when
  nothing is in-play and the next kickoff is beyond
  `AUTO_IDLE_LOOKAHEAD_MINUTES`, clamped ≥ the first tier boundary so idle can
  never starve the always-refresh window). Wired into the light pass ONLY -
  the daily full sweep and manual refresh bypass backoff (correctness
  backstop / explicit human intent). Live-verified: 245+294 detail calls
  excluded per pass.
- **`.HALT` kill-switch** (`src/halt.js`): the file's presence in the app
  root refuses boot (exit 1 - what makes it stick under Passenger
  auto-respawn) and a 30s watcher triggers ONE graceful shutdown path
  (cancel job → stop schedulers/worker/geo → server.close → ≤15s grace →
  closeDb → exit 0). cPanel's Stop button is unreliable; deleting `.HALT` is
  the explicit un-halt.
- **A5:** `/api/columns` catalog pre-warmed ~30s after boot (compute-once
  cache keyed on `data_version` + app version).

Live verification (Checkpoint A): sweep 378 fixtures **75 min → 1.9 s**; drain
31 grounded calls at concurrency 4 in 161 s (avg 19.1 s); second drain
re-billed 0; kill-mid-drain resumed exactly; sweep-after-drain kept 24/26 hot
verdicts (2 re-fired on genuine score change - the old code NULLed all).

## Detour B — the safety harness (requirements 1–5)

Builds on the existing seam (`callModel`, zod payloads, `extractJson`,
`withRetry`, `_screenLeaks`), replaces none of it.

1. **Structured I/O** (`src/ai/harness.js#callStructured`): guard check →
   callModel → `sanitizeReply` → `extractJson` → `schema.parse` →
   observe-only suspicion flags. The harness is the ONLY door; providers
   (`gemini.js`/`openrouter.js`) are transport-only. The adjudicators moved
   to `src/ai/adjudicators.js` (breaks the harness→index→gemini cycle);
   enrichment's 3 call sites migrated. **Regime-neutral: prompt bytes,
   `resolveTask('adjudicate')` routing and the `#p3`/`#e2` tags are unchanged
   (verified by function-body diff) - nothing re-billed.**
   `structuredContract(shape)` renders the standard reply block for NEW
   prompts only.
2. **Hallucination mitigation:** `suspicionChecks` (pure, observe-only:
   out-of-range probabilities, empty-reason confirms, non-renormalizing
   families, verbatim prompt echo - flags feed debugLog, never verdicts;
   the scorecard judges patterns). N-model cross-vendor consensus
   (`consensusVerdict`, majority per field, numeric tolerance vs the panel
   median, disagreement throws - consensus never guesses). Room-for-failure
   prompting stays the FactsPayload nullable-everything precedent.
3. **Creator-bias awareness:** bias is measured, never assumed -
   `scripts/ai-scorecard.js` reports per-model-tag calibration/hit-rates/
   veto value/price drift/Brier + verdict coverage over the settled ledgers.
   Consensus panels must be cross-vendor (`isCrossVendor`, enforced at call
   time; the non-Google blind guard is prior art).
4. **Runaway prevention:** per-run guard (`newRunGuard`/`guardVerdict`/
   `recordCall`) - wall-clock budget `AI_RUN_MAX_MINUTES` (0=off) + circuit
   breaker `AI_BREAKER_AFTER` (5 consecutive transport/parse failures) that
   LATCHES for the run; refusals throw `AiGuardOpen` instantly instead of
   burning 60s timeouts, resolving to 'error' verdicts (fail-open, never
   batch rejections). One guard per drain / per enrich sweep.
   `injectionPreamble()` pins the instruction hierarchy for grounded calls -
   **DARK** (below).
5. **Zero-trust bouncer:** every reply passes zod (tolerant enums → null,
   clamped numbers) → `sanitizeReply` (control-char strip; oversize FLAGS,
   never truncates - truncation would manufacture parse failures) → only
   then persisted. AI output is never executed, never interpolated into SQL,
   and can veto but never promote (unchanged invariant).

### Dark switches (T10) — policy-regime discipline

`AI_INJECTION_PREAMBLE` and `AI_CONSENSUS_TASKS/MODELS/MIN_AGREE` ship OFF
and deliberately **.env-only** (not in the admin settings catalog): flipping
either changes prompt bytes or verdict provenance, which bumps the reuse tag
(`#p3→#p4`, `#e2→#e3`, or an `consensus(...)@N` ensemble base via the pure
`effectivePromptVersion` / harness `ensembleTag`) = one bounded
re-adjudication wave + a dataset regime split. **Enabling either requires an
explicit user go + a dated note in `docs/memory-bank.md`** (templates there) -
the TIP_MIN_PRICE mid-experiment lesson, mechanized. Consensus is wired for
the ADJUDICATE task only; the enrichment tasks are excluded until their tags
get the same treatment, and the blind stream is frozen by policy until the
M4.3 verdict.

## Risks accepted

- Verdict coverage is best-effort pre-kickoff (freeze discipline: a pending
  review whose fixture kicks off drops out - adjudicating post-kickoff is
  the leakage trap). The scorecard's S5 MEASURES the miss rate per day.
- Stale-verdict window ≤ ~60s after a sweep re-picks a tip (review JSON
  self-describes what it judged).
- Legacy rows re-bill once; day budget resets on restart (documented above).
