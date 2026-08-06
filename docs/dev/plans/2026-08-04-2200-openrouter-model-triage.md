# OpenRouter model triage — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-contained `src/modeltriage/` add-on that keeps oddspro on the best value-per-cost OpenRouter models: weekly catalog pull + diff, pure value scoring per task profile, budget-capped qualification probes, a persisted shortlist, an admin "Models" card, and guard-railed optional auto-switch through the standard settings PUT.

**Architecture:** Five-file split per the spec (`index.js` seam / `catalog.js` fetch+diff / `score.js` pure rules / `qualify.js` probes / `store.js` persistence). Only `index.js` imports oddspro config/db/settings; `store.js` takes an injected knex handle and `qualify.js` an injected `call` function, so the directory lifts out as a standalone tool. One append-only `model_triage` table (`kind` snapshot|qualification|shortlist, JSON payload). Weekly background tick in the serve process via an hourly due-check (late-reads settings, survives restarts without re-running), quiesced during maintenance like the geo tick.

**Tech Stack:** Node ES modules, zod (external data), knex (injected), global `fetch` for the no-auth catalog API, `src/ai/openrouter.js` `complete()` injected for billed probes, node:test offline suite, React admin card.

**Spec:** `docs/dev/specs/2026-08-04-2200-openrouter-model-triage-design.md` (same stamp).

## Global Constraints

- 4-space indentation, single quotes, semicolons, ES modules, async/await (repo conventions).
- All external data (OpenRouter API replies, probe replies) through tolerant zod schemas.
- `catalog.js`/`score.js`/`qualify.js` import NOTHING from oddspro except `src/db/retry-rules.js` / `src/db/net-rules.js` (the "shared retry helpers" the spec allows). `score.js` is ZERO-import pure.
- Migrations forward-only; table gets `created_at`/`updated_at` (repo DB standard) even though rows are append-only.
- Env/settings keys exactly: `TRIAGE_ENABLED` (off), `TRIAGE_INTERVAL_HOURS` (168), `TRIAGE_AUTO_SWITCH` (0), `TRIAGE_PROBE_BUDGET` (12), `TRIAGE_FREE_FLAKINESS_TAX` (0.15) — settings-catalog group `ai-triage`, all `live:true`.
- Auto-switch guardrails: never create a blind/anchored vendor collision; at most ONE task switch per tick; a switch needs all-probes-passed qualification; every switch goes through `settings.setOverrides` (admin_audit dates it) + a loud log line.
- Current routing keys (adopt/auto-switch targets): adjudicate→`HOTPICK_AI_MODEL`, facts→`AI_FACTS_MODEL`, blind→`AI_BLIND_MODEL`, anchored→`AI_ANCHORED_MODEL`. `bulk` profile is advisory-only (no settings key, never switched).

---

### Task 1: Migration + config + settings catalog

**Files:**
- Create: `src/db/migrations/20260804000001_model_triage.js`
- Modify: `src/config.js` (new `TRIAGE_*` block near the AI keys)
- Modify: `src/db/settings-rules.js` (new `ai-triage` group, 5 entries)

**Interfaces produced:** table `model_triage` (`id` increments PK, `kind` string(16) indexed with `id`, `payload` JSON, timestamps). Config keys with the spec defaults; catalog entries all `live:true`; `TRIAGE_AUTO_SWITCH` is `regime:true` (enabling it lets the tick change which model generates verdicts).

- [ ] Migration with `table.increments('id')`, `table.string('kind', 16).notNullable()`, `table.json('payload').notNullable()`, `table.timestamps(true, true)`, `table.index(['kind', 'id'])`; down drops the table.
- [ ] Config: `TRIAGE_ENABLED: boolStr('0')`, `TRIAGE_INTERVAL_HOURS: z.coerce.number().int().min(1).default(168)`, `TRIAGE_AUTO_SWITCH: boolStr('0')`, `TRIAGE_PROBE_BUDGET: z.coerce.number().int().min(0).default(12)`, `TRIAGE_FREE_FLAKINESS_TAX: z.coerce.number().min(0).max(1).default(0.15)`.
- [ ] Settings catalog group `ai-triage` (labels/hints per entry; AUTO_SWITCH regime).
- [ ] `.env.example`: commented TRIAGE block.
- [ ] `npm test` still green; commit `feat(modeltriage): model_triage table + TRIAGE_* config/settings keys`.

### Task 2: `score.js` pure rules + offline tests

**Files:**
- Create: `src/modeltriage/score.js` (ZERO imports)
- Create: `tests/modeltriage-score.test.js`

**Interfaces produced (consumed by catalog.js diff callers, index.js, tests):**
- `TASK_PROFILES` — `{ adjudicate, facts, blind, anchored, bulk }`, each `{ key, label, settingKey|null, minContext, needsStructured, needsWeb, tokensIn, tokensOut, callsPerDay }`.
- `modelVendor(id)` → lowercase vendor prefix (duplicated ~4 lines from ai-rules — sanctioned zero-import duplication).
- `isFree(m)` → id ends `:free` OR zero prompt+completion pricing.
- `blendedCostPerCall(pricing, profile)` → USD per call at the profile token mix (pricing is per-token USD strings from the API).
- `capabilityOf(m, fallback = 0.35)` → normalized 0..1 from AA index (`aa` field, 0-100), conservative default when absent.
- `valueScore(m, profile, { flakinessTax = 0.15 } = {})` → free: `capability × (1 − flakinessTax)`; paid: `capability / (1 + costPerCall × 100)` (a 1¢ call halves value).
- `hardFilter(m, profile, { blindVendorBan } = {})` → `{ ok, reasons[] }` (context floor, structured-output support when `needsStructured`, web/tools when `needsWeb`, non-Google + vendor ≠ anchored's for blind).
- `diffCatalog(prev, next)` → `{ added[], delisted[], price_changed[] }` events (`{ id, ... }` rows; price compare on prompt/completion).
- `uptimeOk(uptime, floor = 90)` → health gate (null uptime passes — absence of evidence).
- `prosCons(m, profile, qual)` → `{ pros[], cons[] }` strings (price, context, JSON enforcement, uptime, benchmark, probe results).
- `rankCandidates(models, task, opts)` → filtered+sorted `[{ model, score, reasons }]`.
- `buildShortlist({ models, quals, routing, opts })` → `{ tasks: { [task]: { candidates[], primary, fallback } } }` where candidates carry pros/cons + probe verdicts; PRIMARY needs qual passes + uptime gate.
- `planSwitch({ shortlist, routing, quals, opts })` → at most ONE `{ task, settingKey, from, to, reason }` or `null`, enforcing every guardrail above.

- [ ] Write failing tests first (node:test, offline): free-tax scoring beats an expensive paid twin; blind hard filter rejects Google + anchored's vendor; diffCatalog catches add/delist/price-change; planSwitch returns one switch max, refuses <3 probe passes, refuses vendor collision, null when primary == current; buildShortlist sinks unqualified candidates from PRIMARY.
- [ ] Run `node --test tests/modeltriage-score.test.js` → fails (module missing).
- [ ] Implement `score.js`; run test → green.
- [ ] Commit `feat(modeltriage): pure value-scoring + shortlist/switch rules (offline-tested)`.

### Task 3: `catalog.js` fetch + normalize

**Files:**
- Create: `src/modeltriage/catalog.js` (imports: zod + shared retry helpers only)
- Create: `tests/modeltriage-catalog.test.js` (normalization only — no network)

**Interfaces produced:**
- `normalizeModel(raw)` → `{ id, name, vendor, created, context, pricing: { prompt, completion, web_search }, structured, tools, free, aa } | null` (tolerant zod; junk rows → null, never a throw).
- `fetchCatalog({ baseUrl = 'https://openrouter.ai/api/v1', fetchImpl = fetch })` → normalized array (retry via withRetry+isRetryableNetworkError).
- `fetchEndpoints(id, { baseUrl, fetchImpl })` → `{ uptime, latency } | null` (best per-endpoint `uptime_last_30m`; null on any failure — health gate treats null as unknown).

- [ ] Tests: normalizeModel tolerates missing pricing/benchmarks, extracts `:free`, AA index from the known paths, drops id-less rows.
- [ ] Implement; tests green; commit `feat(modeltriage): OpenRouter catalog fetch + tolerant normalization`.

### Task 4: `qualify.js` probes

**Files:**
- Create: `src/modeltriage/qualify.js` (imports: zod only; `call` injected)
- Create: `tests/modeltriage-qualify.test.js` (pure evaluators + runProbes with a stub call)

**Interfaces produced:**
- `PROBES` — 3 entries `{ key: 'json'|'reason'|'latency', prompt }`.
- `evaluateProbe(key, text)` → `{ pass, note }` (zod-parsed strict-JSON contract; known-answer reasoning check `{ total: 3, over25: true }`; exact-token echo).
- `runProbes(modelId, { call, maxLatencyMs = 30000 })` → `{ model, probes: { [key]: { pass, ms, note } }, passes, ranAt }`; an empty-reply throw records a fail (the observed live failure mode), transport errors too — never rejects.

- [ ] Tests: evaluator accepts/rejects; runProbes with stubbed call counts passes, records empty-reply failure, measures latency fail over budget.
- [ ] Implement; green; commit `feat(modeltriage): qualification probes (JSON contract / reasoning / latency)`.

### Task 5: `store.js` + `index.js` seam

**Files:**
- Create: `src/modeltriage/store.js` (db injected — zero oddspro imports)
- Create: `src/modeltriage/index.js` (the ONLY oddspro-coupled file)

**Interfaces produced:**
- store: `saveRow(db, kind, payload)`, `latestRow(db, kind)` (JSON decode tolerant of mysql2 string/object).
- index: `triageTick({ force = false } = {})` → summary `{ ran, reason?, events, qualified, switched }`; `getTriageState()` → `{ status, shortlist, routing }` for the admin route; `runTriageNow()` (409-style `{ started:false }` when running); `startTriageScheduler()` / `stopTriageScheduler()` (hourly unref'd due-check: enabled → maintenance quiesce → last-shortlist age ≥ `TRIAGE_INTERVAL_HOURS`).
- Tick pipeline: fetchCatalog → diff vs last snapshot (loud console warning when a delisted model is in live routing) → save snapshot → rank per task → qualify NEW/CHANGED top candidates within `TRIAGE_PROBE_BUDGET` (3 calls each; reuse stored quals otherwise; endpoints uptime folded in) → save qualification → buildShortlist with live routing from `resolveTask(task, effectiveAiConfig())` → save shortlist → when `TRIAGE_AUTO_SWITCH`: `planSwitch` → `setOverrides([[settingKey, id]])` + loud log.

- [ ] Implement store + index; commit `feat(modeltriage): triage cycle seam + append-only store + weekly scheduler`.

### Task 6: server wiring

**Files:**
- Modify: `src/server.js` (import, 2 routes, scheduler start/stop)
- Modify: `src/maintenance.js` (quiesce-policy comment lists the triage tick)

- [ ] `GET /api/admin/triage` (requireAdminRole) → `getTriageState()`; `POST /api/admin/triage/run` (requireAdminRole) → 202/409 via `runTriageNow()`.
- [ ] `startTriageScheduler()` after listen; `stopTriageScheduler()` in shutdown.
- [ ] `npm test` green; commit `feat(modeltriage): admin triage routes + serve scheduler wiring`.

### Task 7: admin "Models" card (web)

**Files:**
- Create: `web/src/admin/ModelsSection.jsx`
- Modify: `web/src/admin/useAdminRoute.js` (+`{ id: 'models', label: 'Models' }`), `web/src/admin/AdminPanel.jsx` (SECTION_BODY), `web/src/api.js` (`getAdminTriage`, `runAdminTriage`)

- [ ] Card per task: candidate table (model, vendor, $/M in/out, context, JSON badge, uptime, probe verdicts), pros/cons, PRIMARY/FALLBACK badges, LIVE marker on the routing's current model; "Adopt" per task (auto-switch off) → `putAdminSettings({ [settingKey]: id })`; auto-switch toggle → `putAdminSettings({ TRIAGE_AUTO_SWITCH })`; events feed; "Run triage now" button with poll-until-done; disabled-state hint when `TRIAGE_ENABLED` is off; $10 top-up note surfaced (never nagged).
- [ ] `npm run build:web` compiles; commit `feat(web): admin Models card - shortlist, adopt, auto-switch, events`.

### Task 8: docs + verification

- [ ] CLAUDE.md: one `src/modeltriage/` architecture bullet + env keys line; QUICK-REFERENCE.md routine line; checklist file final update.
- [ ] Full `npm test` + `npm run build:web`; commit `docs: model-triage module docs + checklist close-out`.

## Self-review notes

- Spec coverage: catalog pull/diff (T3/T5), candidate filter + value score + flakiness tax (T2), probes + uptime gate (T4), shortlist + pros/cons + PRIMARY/FALLBACK (T2/T5), admin card + events + adopt + auto-switch + guardrails (T2/T6/T7), env/settings group (T1), weekly quiesced tick (T5/T6), delisted-live-model loud alert (T5), $10 top-up surfaced (T7). Out-of-scope items stay out.
- Types consistent: `planSwitch` consumes the same `{ settingKey }` the profiles define; store rows round-trip the payload shapes index.js writes.
