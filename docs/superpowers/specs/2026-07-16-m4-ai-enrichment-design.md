# M4.1 — AI Enrichment Layer (design)

> Brainstormed 2026-07-16 with the user. Status: APPROVED design, pending spec
> review → implementation plan. Predecessor: M3 any-market tips (merged `1ef8890`).
> Parent backlog: `docs/emergence-patterns-m4-backlog.md`.

## 1. Why this exists

The M4 backlog proposed a retrospective pattern-mining layer over the settled
tip ledger. A read-only look at the warehouse **before** designing it changed
the plan, and those measurements are the spec's foundation.

### 1.1 What the data actually says (measured 2026-07-16)

| Substrate | Rows | Consequence |
|---|---:|---|
| Final fixtures (warehouse) | 28,327 | Deep, but **price-blind** |
| Final fixtures **with odds** | 1,558 (14 days) | The only place EV is measurable |
| Settled tips | 1,038 (13 days) | 739 hit / 299 miss = 71.2% |
| Settled tips w/ `tip_breakdown` | 1,025 | Runner-up configs minable |
| Settled tips w/ **`tip_ai_review`** | **41** | Founding thesis **untestable** |

Live per-market performance (1,037 settled, void excluded):

| Market | n | Hit % | Avg odds | Break-even | ROI |
|---|---:|---:|---:|---:|---:|
| `O 3.5` | 14 | 78.6 | 1.50 | 66.8 | +18.8% |
| `U 5.5` | 22 | 86.4 | 1.29 | 77.2 | +11.3% |
| `X2` | 108 | 75.0 | 1.43 | 70.0 | +5.6% |
| `O 2.5` | 98 | 70.4 | 1.44 | 69.6 | +0.4% |
| `O 1.5` | 190 | 72.1 | 1.32 | 75.6 | −4.7% |
| `1X` | 101 | 73.3 | 1.30 | 76.7 | −5.2% |
| `U 4.5` | 142 | 70.4 | 1.32 | 75.7 | −7.1% |
| `U 3.5` | 126 | 64.3 | 1.43 | 69.8 | −8.1% |
| `12` | 215 | 70.7 | 1.29 | 77.7 | −9.2% |
| **Overall** | **1,037** | **71.2** | — | — | **−4.3%** |

(1,037 not 1,038: the table excludes markets with n<5 — a single `O 0.5` tip.
No `void` rows exist yet; M3's new families have no settled tips.)

Two findings recorded here so they are not re-derived later:

- **H1 (O/U cascade) has a precise bar, not a vague one.** `O 1.5` — the
  cascade's proposed "safe landing" — is already tipped 190 times, hits 72.1%,
  and **loses 4.7%** because the book prices it at 1.32 (needs 75.6%). The
  safety is real and *already in the price*. H1 survives only if the
  **conditional** rate (O 1.5 given we'd tip O 3.5/O 2.5) clears ~75.6%.
  "Usually clears" is not the test.
- **`TIP_MIN_UNDER_LINE=3.5`** (a local `.env` override of the 4.5 default) let
  126 `U 3.5` tips through at −8.1%. But `U 4.5` also loses (−7.1%), so a revert
  would not have saved money, and tuning to 5.5 off 14 days is hindsight-fitting.
  Left as-is pending a pre-registered test (M4.2). Documented inline in `.env`.

### 1.2 The finding that reshaped the milestone

Gemini's veto — the entire current use of AI — does not discriminate:

| Verdict | Hit | Miss | Hit rate |
|---|---:|---:|---:|
| `confirm` | 21 | 7 | **75.0%** |
| `veto` | 24 | 9 | **72.7%** |

n=61, so the 2.3pp gap is noise; the honest claim is *no evidence of
discrimination*. The practical claim is sharper: **the veto flags tips that win
~73% of the time**, consistent with v1's contradiction-vetoes measuring
net-negative. A frontier model is being spent on a boolean that carries no
information.

The user's read (2026-07-16): *"adjudication may be too limited a task. We can
expand its contribution to enrich and improve our algorithm's accuracy."*
This spec is that expansion.

### 1.3 The constraint that forces the shape

**AI reviews cannot be backfilled.** `HOTPICK_AI_WEB=1` attaches Gemini's
`google_search` tool; pointed at a played fixture it retrieves the final score
and "predicts" it perfectly. Every backfilled row would be leakage that
*resembles* brilliance. Ungrounded, the model's training data may still contain
the result.

Therefore the AI ledger can only grow **forward**, and collection is
**wall-clock-bound, not compute-bound**. No amount of budget or parallelism
shortens it. That makes this milestone the long pole and the reason it precedes
the mining harness (M4.2), which needs no new data.

**Already actioned 2026-07-16** (`.env`, refactored + documented):
`TIP_AI_MIN_CONFIDENCE 0.80→0`, `TIP_AI_DAILY_CAP 30→250`, `HOTPICK_AI_WEB 0→1`
— accrual goes from ~3/day to ~130+/day on the *existing* v2 prompt, so data
banks while this layer is built.

## 2. Goal and non-goals

**Goal.** Turn AI from a boolean adjudicator into a measurable, multi-signal
evidence source, and begin forward collection of features the warehouse cannot
see.

**Non-goals — load-bearing, not throat-clearing:**

- **Nothing feeds `bestTip`, confidence, `magicSortRows`, `safeQualifies`, or
  any ranking.** This milestone fills a tank. Whether the water is drinkable is
  M4.3's question, answered by replay, not by assertion.
- No new mining scripts (M4.2).
- No live UI surfacing of insights beyond removing the unjustified veto
  strike-through.
- No claim that any of this is +EV. Every market remains −EV on real odds
  (−4.3% measured). This layer buys *evidence*, not profit.

## 3. Architecture

### 3.1 Three calls per fixture

Facts are extracted **once** by the grounded model; both reasoners then work the
**identical evidence**, so any disagreement is reasoning difference rather than
one model simply knowing more.

| # | Kind | Provider | Sees | Emits |
|---|---|---|---|---|
| 1 | `blind` | Gemini (grounded) | teams, date, our rolling stats. **No odds, no tip** | typed facts + `sources` + probability distribution |
| 2 | `blind` | OpenRouter (non-Google) | same stats **+ call 1's facts**. **No odds, no tip** | probability distribution |
| 3 | `anchored` | Gemini | everything: tip, price, stats, facts | probability for *our* tipped outcome + read of public consensus |

Call 2 depends on call 1 within a fixture; fixtures run concurrently.

**Why `blind` must be a separate call.** The moment a prompt mentions our tip or
the book's price, the model anchors — which is the exact bias being measured.
`anchored − blind` on the same fixture and same model is a **paired
measurement** of the anchoring effect, quantified per fixture rather than
inferred across groups. This is the user's *"it just agrees with the bookmaker"*
observation rendered as a number.

**Why the OpenRouter model must be non-Google.** Model consensus between two
Google models is Gemini agreeing with itself. Reasoner independence is a
correctness requirement of the experiment, not a preference. `openrouter/auto`
is disqualified for the same reason: an auto-router silently varies the model
per fixture, so the measurement would not know which brain it measured. The
default must be a **pinned, non-Google** model.

**Chosen default: `openai/gpt-5.6-terra`** (verified present in OpenRouter's
live `/api/v1/models` on 2026-07-16 — 342 models listed; $2.50/M prompt tokens,
1.05M ctx). Rationale: a different lab entirely from Gemini, which maximizes
reasoner independence — the property the consensus signal is built on.

- Zero-cost fallback: **`meta-llama/llama-3.3-70b-instruct:free`** (131k ctx),
  the closest real ID to the user's `openrouter/free` suggestion — that literal
  string is **not** a valid model ID.
- Verify the ID against the live list again at implementation; OpenRouter
  deprecates and renames. Do NOT pick a model from training memory — the
  2026-07-16 fetch surfaced whole model families absent from it.

### 3.2 Fixed market set for `blind`

A blind call cannot be asked about "our tip" (it has not seen one), so it emits
a distribution over a fixed set, comparable to any tip we later made:
`1`, `X`, `2`, `O 2.5`, `U 2.5`, `GG`, `NG`. Probabilities within each family
are normalized by the parser, not trusted from the model.

### 3.3 Modules — mirroring existing prior art

```
src/ai/index.js       provider seam. PROVIDERS = { gemini, openrouter };
                      ONE getProvider(task) swap point. Directly mirrors
                      src/sms/index.js, which already solved this shape.
src/ai/gemini.js      today's src/ai.js _adjudicate, extracted
src/ai/openrouter.js  new; OpenAI-compatible chat-completions
src/db/ai-rules.js    PURE (zero-import): prompt builders, per-kind zod schemas,
                      model-tag math, task→provider/model resolution, fact
                      schema versioning. Offline-testable, per the convention
                      every other rules module here follows.
src/ai-parse.js       exists; extended with the new per-kind schemas
```

Retries reuse `withRetry` + `isRetryableNetworkError`. **Fail-open is preserved**:
an AI error never breaks the pipeline, exactly as today.

### 3.4 Persistence

New table `fixture_ai_insights` (migration batch 13):

| Column | Type | Notes |
|---|---|---|
| `fixture_id` | BIGINT UNSIGNED | FK → `fixtures.id` **ON DELETE CASCADE** |
| `kind` | ENUM(`blind`,`anchored`) | one row per (fixture, kind, provider) |
| `provider` | VARCHAR(32) | `gemini` / `openrouter` |
| `model_tag` | VARCHAR(64) | full tag incl. `+search` / `#p<N>` |
| `schema_ver` | SMALLINT UNSIGNED | the "room to add later" lever |
| `payload` | JSON | facts + probabilities |
| `sources` | JSON NULL | grounding citations |
| `created_at` / `updated_at` | TIMESTAMP | per house convention |

**PK `(fixture_id, kind, provider)`.** Upserted while `kickoff > NOW()`; frozen
thereafter.

`schema_ver` + a JSON payload is the deliberate answer to the user's *"leave
room for anything important we may need to add later"*: a new fact field costs a
version bump, **not** a forward-only migration.

**Fact payload v1** (all nullable — absent evidence must be distinguishable from
"no problem found"):

- **availability** — `out_count` per side, named key absences, `top_scorer_out`,
  `first_choice_gk_out`
- **motivation** — per-side stakes enum (`dead_rubber` / `must_win` /
  `title_race` / `relegation` / `secured` / `normal`), `rotation_risk`
- **congestion** — `days_since_last` per side, `bigger_match_within_4d`
- **lineup** — `xi_confirmed`, `manager_change_recent`, `gk_change`
- **extra** — free-form escape hatch; promoted to typed fields when it earns it

### 3.5 Config split

The settings catalog **excludes secrets by construction** (CLAUDE.md), so:

- **API keys → `.env` only.** `GEMINI_API_KEY`, `OPENROUTER_API_KEY`.
- **Model + behaviour → catalog,** admin-editable live: per-task provider/model,
  `AI_ENRICH_ENABLED`, `AI_ENRICH_CAP`, `AI_ENRICH_CONCURRENCY`.

This gives the runtime control the user asked for without putting keys in a DB
row.

New `src/config.js` keys: `OPENROUTER_API_KEY`, `OPENROUTER_URL`,
`OPENROUTER_MODEL`, `AI_ENRICH_ENABLED`, `AI_ENRICH_CAP`,
`AI_ENRICH_CONCURRENCY`, `AI_BLIND_MODEL`, `AI_ANCHORED_MODEL`.

### 3.6 The invariant that protects everything

> **An AI call must never touch a past-kickoff fixture.**

Selection is `kickoff > NOW()` — the same freeze idiom as `fixture_prematch`,
tips, and hot picks. A grounded call on a played match retrieves the score.
This gets an **explicit test assertion**, not merely a convention, because the
failure mode is silent and looks like success.

### 3.7 Concurrency and scale

Today's AI calls are serial (`_batch(..., 1)` — that concurrency exists to avoid
InnoDB deadlocks on **DB writes**, which does not apply to network calls).
Enrichment uses bounded concurrency (`AI_ENRICH_CONCURRENCY`, default 4).

`AI_ENRICH_CAP` (default 200) bounds **fixtures enriched per run**, not
individual calls — one fixture always gets its full 3-call set or none, so a cap
can never truncate a fixture into a half-measured state (a `blind` with no
`anchored` is useless for the paired measurement). Fixtures are taken
soonest-kickoff first.

At 191 upcoming fixtures × 3 calls = 573 calls; at concurrency 4 ≈ 12 min/sweep.
Reuse is keyed on `(fixture, kind, provider, model_tag)` + tip identity, so
steady-state re-billing covers only genuinely new/changed fixtures.

### 3.8 Veto: recorded, no longer acted on

`tip_ai_verdict` continues to persist (so the ledger can prove what following the
vetoes *would* have cost), but the veto no longer alters presentation — the web
strike-through is removed. Justification is §1.2: there is no evidence it
discriminates, so it must not shape what the user sees. Reversible the moment it
earns its place on data.

`hot = false` on veto (hot picks) is **unchanged** in this milestone — different
gate, different evidence base, out of scope.

## 4. Testing

Offline (`node:test`, no DB/network), per house convention:

- `ai-rules`: prompt builders emit no odds/tip in `blind` (**the anchoring
  guard, asserted directly**), per-kind zod parse/reject, model-tag math,
  task→model resolution, fact schema versioning, probability normalization.
- `ai/index`: `getProvider` routing, fail-open on provider error, retry
  classification.
- **Leakage assertion**: the selection helper rejects `kickoff <= NOW()`.
- Suite must stay green (currently **516/516**).

Live verification before merge: one real sweep, confirming rows land in
`fixture_ai_insights` with both providers present and `sources` populated.

## 5. Risks

| Risk | Mitigation |
|---|---|
| **Leakage via grounded search on played fixtures** | `kickoff > NOW()` selection + explicit test assertion. The failure is silent and flatters — highest-severity risk here. |
| OpenRouter model deprecated / renamed | Pinned model in config; verify against the live model list at implementation; fail-open means a dead provider degrades rather than breaks. |
| Cost blowout | User explicitly owns AI economy ("unlimited AI plan"); `AI_ENRICH_CAP` still bounds per-run calls. |
| Sweep wall-clock growth | Bounded concurrency + cap; enrichment is fail-open and interruptible. |
| **Mining the collected features later produces false positives** | Not this milestone's job, but pre-registered in M4.2: temporal-OOS/LODO with selection correction. Precedents: X2 "+15% EV" **refuted**; runner-up swap net-negative (+108/−128). |
| Prompt changes invalidate comparability | `model_tag` carries `#p<N>`; a prompt-version bump re-adjudicates upcoming only. Settled rows are frozen forever. |

## 6. What comes next (NOT this spec)

- **M4.2 — mining harness.** Read-only, runs in parallel with collection, needs
  no new data. Pre-registered tests: H1 O/U cascade (conditional rate vs the
  ~75.6% bar), H2 runner-up configurations (1,025 rows), H3 miss-commonality
  (299 misses — thin; strict OOS), plus the `TIP_MIN_UNDER_LINE` and
  `SAFE_MIN_PARTS=3` overrides.
- **M4.3 — AI-feature mining (~2 weeks out).** Once ~1,800 rows accrue: is AI
  probability calibrated? does anchoring degrade it? is consensus an anti-signal
  (the founding thesis)? does model disagreement predict? Only survivors reach
  ranking, and only via replay evidence.

## 7. Guardrails inherited (non-negotiable)

- **Frozen ledger.** Settled/past-kickoff rows are never rewritten. Self-healing
  means recalibration + replay-gated rules, never history edits.
- **Price-blind ≠ bettable.** A pattern must survive at real odds. Warehouse
  precision has already proven *anti-correlated* with live ROI once.
- **Mine freely, ship skeptically.** Multiple comparisons will manufacture false
  positives. Everything faces OOS replay before it touches ranking.
- **AI never promotes.** It may inform or flag; a promotion path must earn its
  way in via replay evidence.
- **Honest labels over hopeful ones.** No market is +EV; overall flat-stake EV is
  −4.3%. This layer buys evidence, not profit.
