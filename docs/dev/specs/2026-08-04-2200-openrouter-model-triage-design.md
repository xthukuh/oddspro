# OpenRouter model triage — design spec

**Date:** 2026-08-04 22:00 · **Status:** DESIGNED, not yet built (the Gemini→OpenRouter
provider swap itself SHIPPED this session — see the memory-bank regime entry).
**Research basis:** live OpenRouter catalog audit 2026-08-04 (338 models; free tier
collapsed to 14 NVIDIA-heavy `:free` ids in Jul 2026; endpoints API exposes per-endpoint
uptime/latency; `/api/v1/models` carries pricing + `supported_parameters` +
Artificial-Analysis benchmark indices; announcements have no RSS — the models-API diff IS
the ground truth).

## Purpose

Keep oddspro always on the best *value-per-cost* models (free tier first-class, cheapest
paid tier in scope) without a human babysitting a fast-moving catalog. Surface the
current shortlist in the admin panel with pros/cons + best-use-per-model, and optionally
auto-switch the live task routing when a better qualified model appears.

## Architecture: self-contained add-on (user requirement)

Everything lives under **`src/modeltriage/`** with its OWN storage table and a thin seam,
so a future session can lift the directory out as a standalone tool:

```
src/modeltriage/
  index.js        # the seam: getShortlist(task), triageTick(), startTriageScheduler()
  catalog.js      # fetch + diff /api/v1/models and /models/{id}/endpoints (no auth)
  score.js        # PURE ranking rules (zero imports): value score per task profile
  qualify.js      # capability qualification probes (JSON contract, latency, refusal)
  store.js        # persistence via one JSON-blob settings-style table `model_triage`
```

- **No oddspro imports inside catalog/score/qualify** beyond the shared retry helpers —
  the extraction seam. `index.js` is the only file allowed to touch oddspro config/db.
- Storage: one table `model_triage` (migration): `id`, `kind` ('snapshot'|'qualification'
  |'shortlist'), `payload` JSON, `created_at`. Append-only snapshots → diffs are derivable;
  the newest `shortlist` row is what the admin panel and auto-switch read.

## The triage cycle (background, LOW frequency)

Weekly by default (`TRIAGE_INTERVAL_HOURS`, default 168; a manual "Run triage now" admin
button) — an unref'd timer in the serve process, quiesced during maintenance windows like
the geo tick:

1. **Catalog pull** (free, no key): `/api/v1/models` → per model: pricing (prompt/
   completion/web_search/cache), context, `supported_parameters` (structured_outputs /
   response_format / tools), `created` (new-model detection), AA benchmark indices.
   Diff vs the last snapshot → `added` / `delisted` / `price_changed` events (a delisted
   `:free` model that our routing uses = a LOUD admin alert).
2. **Candidate filter** (pure `score.js`): per task profile (adjudicate/facts/blind/
   anchored/bulk) — hard requirements (context ≥ X, non-Google for blind, vendor ≠
   anchored's for blind, tools/web-composability for grounded tasks), then value score =
   capability proxy (AA intelligence index; absent → conservative default) / blended
   $-per-call at that task's token profile. `:free` models cost the daily-cap risk, not $0:
   the score charges them a configurable "flakiness tax" instead.
3. **Qualification probes** (`qualify.js`, budget-capped, only for NEW or CHANGED
   candidates): 3 tiny probes per candidate — (a) strict-JSON contract probe (zod-parsed),
   (b) reasoning sanity probe with a known answer, (c) latency/empty-reply check
   (the "OpenRouter reply carried no message content" failure mode observed live).
   Per-endpoint `uptime_last_30m` from the endpoints API folds in as a health gate.
   Results persist as a `qualification` row: pass/fail per probe + latency + notes.
4. **Shortlist build**: per task, ranked candidates with pros/cons strings (context,
   price, JSON enforcement, uptime, benchmark, probe results) + a PRIMARY/FALLBACK
   recommendation. Persisted as a `shortlist` row.

## Admin panel (new "Models" card in the admin section)

- The current shortlist per task: model, vendor, $/M in/out, context, JSON-enforcement
  badge, uptime, probe verdicts, pros/cons — and which model the LIVE routing uses now.
- Catalog events feed (added/delisted/price-changed since last visit).
- **Auto-switch toggle** (`TRIAGE_AUTO_SWITCH`, default OFF): when ON, a shortlist PRIMARY
  that differs from the live routing key writes the new model id through the standard
  settings PUT (admin_audit dates it — the policy-regime discipline is automatic) and the
  reuse tags re-key as they already do on any model change. When OFF, the panel shows a
  one-click "adopt" button per task instead.
- Guardrails on auto-switch: never switch blind to a vendor matching anchored; never
  switch more than one task per tick; a switch is refused while the candidate has < N
  qualification passes; every switch lands an admin_audit row + a loud log line.

## Env/settings keys (all in the settings catalog, group `ai-triage`)

`TRIAGE_ENABLED` (default off), `TRIAGE_INTERVAL_HOURS` (168), `TRIAGE_AUTO_SWITCH` (0),
`TRIAGE_PROBE_BUDGET` (max billed probe calls per tick, default 12),
`TRIAGE_FREE_FLAKINESS_TAX` (score penalty for `:free`, default 0.15).

## Explicitly out of scope (v1)

News/announcement scraping (no RSS exists; the models-API diff covers ground truth),
per-league model specialization, and multi-provider triage beyond OpenRouter (the seam
allows it later — `catalog.js` takes a base URL).

## Standing decisions carried from the research

- Current routing (shipped 2026-08-04): adjudicate `openai/gpt-5.6-luna` (grounded,
  web plugin `parallel`), facts + anchored `deepseek/deepseek-v4-flash-0731`, blind
  `nvidia/nemotron-3-super-120b-a12b:free`. Est. ≤ ~$8/month at max volumes.
- The one-time **$10 OpenRouter credit top-up** (unlocks 1,000 free req/day vs 50) is the
  single highest-leverage spend available — user-gated, surfaced here rather than nagged.
- Free-endpoint flakiness is normal: keep transport retries + fail-open, and let the
  breaker (`AI_BREAKER_AFTER`) guard drains.
