# Performance + AI-Economy Plan (2026-07-21)

Origin: user asks on 2026-07-21 mid the admin-dashboard program — (a) speed up slow
processes (`npm run start` pipeline + web app), (b) tighten AI spend "as economical as
possible, prefer free OpenRouter models" (financial pressure). Three read-only
investigations were run; their actionable findings + the user's decisions are captured
here so implementation can proceed in a fresh session without re-running the research.

**Status (updated 2026-07-21, session 11): A1 DONE (`a50e978`), section B DONE (`428704a`),
section C RESOLVED (`38e4278`) — C1 shipped, C2 REFUTED (not shipped), C3 measured and its
refactor REJECTED.** Sections A2 (user-gated live `.env`), D and E remain open. M10 + M11 of
the admin program are DONE and committed (through `6dddcb1`).

**Session-11 progress detail (section C — every item's "measure first" gate fired):**
- **C1 DONE** — `src/betika.js` `limit` 10 → 50. Probe before change: the API honours
  `limit=50` and `limit=100` exactly (identical response shape + keys), and a `limit=100`
  walk returned the SAME 116 unique `parent_match_id`s as a `limit=10` walk (0 overlap,
  0 missing, 0 extra) — so pagination is genuinely limit-based, not a fixed internal page.
  Chose 50 over 100 deliberately: the walk terminates on `len < limit`, so if the server
  ever caps page size below the requested value the day truncates SILENTLY with no error;
  50 takes most of the win (170 → 34 pages on a 1694-game day) well inside the verified
  ceiling. Verified live: 116 games in 3 pages instead of 12.
- **C2 REFUTED — do not retry this shape.** The plan's premise was inverted. It assumed
  `status` was non-selective so the `fetched_at` columns must be selective; measurement says
  BOTH are non-selective — `stats_fetched_at IS NULL` matches **94.8%** of rows
  (35,476 / 37,413). Creating the three candidate indexes and re-running EXPLAIN: the
  optimizer **still chose `type=ALL`** and ignored them. Forcing them proves the predicted
  plan is reachable (`Using union(probe_stats, probe_lineups, probe_events)`) but it
  estimates **65,292 rows on a 37,413-row table** and runs **57.2ms vs 16.4ms** — 3.5×
  SLOWER. An index whose range scan returns 95% of the table loses to a sequential read.
  The real selectivity is the CONJUNCTION (final ∧ correlated ∧ missing-flag → 410 rows),
  which no single-column index expresses. Also: the **508ms that motivated C2 was a
  cold-cache artifact** — warm baseline is 18.6ms. There was never a bottleneck here.
  Probe indexes dropped; `fixtures` is back to its original 6 indexes; no migration written.
- **C3 measured → refactor REJECTED, instrumentation KEPT.** DEBUG-gated per-phase timing
  added to `saveMatches` (no logic change). Live run: `prefetch 17ms, loop 2713ms (upsert
  360ms, select-odds 151ms, diff-write 1864ms)` over 116 games / 22,077 market rows. The
  per-match `existingOdds` N+1 the plan suspected is **151ms = 5.6% of the loop**; the real
  cost is **diff-write at 1864ms = 69%** (writing the market rows). The bulk-prefetch would
  save ≤6% while moving the read outside the transaction and widening the exact staleness
  window `withRetry` exists to absorb. Not worth it. The timing stays as the durable
  evidence channel for when the table grows.

**Session-10 progress detail:**
- **A1 done** — `src/config.js` `OPENROUTER_MODEL` → `nvidia/nemotron-3-super-120b-a12b:free`,
  `AI_ENRICH_CAP` 200 → 40, dated policy-regime entry in `docs/memory-bank.md`. The
  `.env.example` AI-block rewrite was deliberately LEFT to section D's full trim (one edit,
  not two). **A2 was PRESENTED to the user; not applied (theirs to apply).**
- **B done** — all three landed in one commit. Measured guest entry **636 KB → 389 KB raw,
  187 KB → 123 KB gzip (−34%)**; `PhoneField` is now its own 200 KB on-demand chunk.
  B2 needed one change beyond the plan: `saveSelection` had to accept an updater and
  `toggleSelect` derive from `prev`, because deferring the commit makes a closed-over
  `selection` one commit stale (a fast double-click would drop the first toggle).
  Browser-verified against the built dist (app paints, sign-in overlay resolves through the
  Suspense fallback with PhoneField intact, Help opens, no unexpected console errors).
  **NOT yet verified: B2's actual click behaviour** — needs real rows, so it is now an
  explicit E2E checklist item (see section D).
- **C blocked** — Docker daemon down (WSL integration failure; user restarting the machine).
  C2 must not be committed without the live `EXPLAIN` confirming the optimizer picks the
  candidate indexes, and the migration is forward-only, so guessing the shape is not an option.

---

## A. AI-spend economy

**Key finding: the repo DEFAULTS are already economical. The spend is entirely from
LIVE `.env` overrides the user opened as M4.x research "faucets."** (0 Admin→Settings
overrides exist — `.env` is the sole source of truth for AI knobs today.)

**User decisions (AskUserQuestion, 2026-07-21):**
- Faucets → **"Throttle hard, keep a trickle"** (not full close): enrichment cap ~40/day
  (fits the free tier), tip-review cap ~30.
- Blind model → **"Switch to free Nemotron"** (paired with the throttled enrich cap so
  the free tier's ~50 req/day isn't exceeded).

### A1. In-repo changes (my scope; durable repo policy; commit these)
- `src/config.js:95` — default `OPENROUTER_MODEL` `openai/gpt-5.6-terra` (PAID, $2.50/$15
  per 1M) → a free model `nvidia/nemotron-3-super-120b-a12b:free` (free Nemotron slugs
  verified live on OpenRouter: `-super-120b-a12b:free`, `-ultra-550b-a55b:free`,
  `-nano-30b-a3b:free`). This is the blind-reasoner slot (`AI_BLIND_MODEL` falls back to
  it). **POLICY-REGIME NOTE REQUIRED:** the model identity is baked into
  `enrichModelTag()`'s reuse tag, so old/new rows won't conflate, BUT this forks the
  in-flight blind measurement population — DATE it in `docs/memory-bank.md` (the
  `TIP_MIN_PRICE` lesson). User chose it deliberately, so the fork is sanctioned.
- `src/config.js:97` — default `AI_ENRICH_CAP` 200 → 40 (free-tier-safe; matches
  "throttle"). NOTE `src/enrich.js` fails OPEN per-call on a free-tier 429 (caught +
  logged, never crashes) — so an over-cap would SILENTLY truncate blind coverage; the 40
  cap keeps it under the ~50/day free limit so truncation won't bite.
- `.env.example` — rewrite the AI block (lines ~108-155) with the economical recommended
  values, the free-Nemotron blind default, prominent cost warnings, the free-tier ~50/day
  cap caveat, and the **Gemini 2.5 Flash deprecation 2026-10-16** note (a forced
  `HOTPICK_AI_MODEL` change is coming regardless — fold into the same edit). This is also
  part of the M12 `.env.example` trim (see section D).

### A2. Live-config changes (USER-GATED ops — billing; present, do NOT silently edit live `.env`)
These are the user's explicit `.env` OVERRIDES; changing them affects live billing +
their in-flight research, so they are the user's to apply (Admin→Settings, all `live:true`,
no restart — OR `.env` edit + serve restart). Give the user the exact list:
- `.env` `TIP_AI_DAILY_CAP` 250 → ~30 (throttle; default is 20). Zero prediction risk —
  `magicSortRows`/`scoreTip` never consult `tip_ai_verdict` by design.
- `.env` `TIP_AI_MIN_CONFIDENCE` 0 → 0.75 (stop reviewing marginal-confidence tips).
- `.env` `AI_ENRICH_ENABLED` stays 1 ("keep a trickle"); the cap default change (A1)
  drops it to 40 automatically once the new code is deployed. If they want throttle BEFORE
  deploy, set `.env` `AI_ENRICH_CAP=40` now.
- `.env` `AI_BLIND_MODEL=nvidia/nemotron-3-super-120b-a12b:free` (or rely on the A1
  default once deployed).
- `HOTPICK_AI_WEB=1` (grounding) — LEAVE ON. Turning it off reverts adjudicator quality
  to the pre-v2 pattern the project measured as net-NEGATIVE. Grounding is likely still
  inside Gemini's free 1,500 RPD quota; verify against the Google billing console, don't
  assume.

### A3. Hard Gemini-coupling boundary (leave; would need code + is NOT requested)
`src/db/ai-rules.js:273-308` `resolveTask`: `adjudicate`/`facts`/`anchored` have a
HARDCODED `provider:'gemini'` (only the MODEL name is configurable). `blind` is the only
task with a dynamic provider (hardwired `openrouter` + an active Google-family REFUSAL
guard, line 297-301, for reasoner independence — keep). Moving adjudicate/facts off Gemini
would also need grounding reimplemented in `src/ai/openrouter.js` (it has no grounding
param). Not in scope. `AI_CONSENSUS_*` / `AI_INJECTION_PREAMBLE` stay OFF (consensus panels
ADD cost). Possible future lever (user's call, not now): `HOTPICK_AI_MODEL` →
`gemini-2.5-flash-lite` (~3-6x cheaper) — unclear if flash-lite supports `google_search`.

---

## B. Web app speed (top 3, all low-risk, same proven React.lazy pattern already shipped for AdminPanel)

Measured build (2026-07-21): guest entry `index-*.js` **636 KB raw / 187 KB gzip**; lazy
admin chunk 574 KB. Only ONE split boundary exists (`AuthGate.jsx:12` lazy AdminPanel).

- **B1 (biggest guest win): lazy-load the 5 auth views.** `web/src/auth/AuthGate.jsx:3-7`
  statically imports `SignInView/SignUpView/VerifyPhoneView/ProfileView/ForgotPinView`;
  all but ProfileView pull `PhoneField.jsx` → `react-phone-number-input` + `libphonenumber-js`
  (~339 KB pre-min, **~17-20% of the guest chunk**), which 100% of guests parse but never
  use until they click Sign in. Fix: wrap the 5 views in `React.lazy` + `Suspense` (the
  exact pattern already 2 lines above for AdminPanel). Risk very low, presentation-only.
- **B2: wrap row-selection in `startTransition`.** `web/src/App.jsx:974-984`
  (`saveSelection`/`toggleSelect`) is a plain sync `setSelection` → `stampSelection`
  (spread-clones every row) → full table re-sort + un-memoized `sorted.map` render
  (`DataTable.jsx:554-557,781`). Contrast `App.jsx:798-806` (sort) and `:809-813` (filter)
  which ARE wrapped in `startTransition`. Fix: wrap `saveSelection` call sites the same
  way. Removes a blocking full-table re-render on every checkbox click.
- **B3: lazy-load `HelpModal`** (+ its `LegalModal`/`legalContent.js`, ~25-30 KB).
  `web/src/App.jsx:1339-1376` renders 5 modals conditionally but imports them statically.
  HelpModal is the safest first (click-opened, no UX cost). FilterBuilder/SettingsModal/
  BetslipPlayground are more frequently used — weigh the click-and-wait beat before lazying
  those.

Lower priority (not now): #4 signed-in AI-review JSON 777 KB still shipped to a details-off
build (but guests unaffected + ~1 signed-in account today — revisit as base grows); #5
per-section admin lazy-split (admin-only, low ROI); #6 FilterBuilder undebounced live
match-count (cheap at 150-250 rows today, watch item); #7 no row virtualization (justified
at current row counts). Positive: no load waterfall, tracking beacon defers 2s, FOUC guard
minimal, SessionProvider async-nonblocking, phone metadata already the "min" build.

---

## C. Pipeline speed (`npm run start`) — top 3, note the "probe/measure FIRST" gates

- **C1 (biggest busy-day win, NEEDS a 1-request live probe first): Betika list page size.**
  `src/betika.js:106` `limit=10` drives ~170 sequential list pages on a 1694-game day
  (each gated by a 50ms sleep, `betika.js:115-124`) vs BetPawa's `take=50`
  (`betpawa.js:134`) → ~34 pages. Fix: try `limit=50` or `100`. **PROBE FIRST** — one
  manual `GET /matches?...&limit=50` to confirm the API honors it and the response shape is
  unchanged before altering the constant. Pure request-count REDUCTION (can't increase API
  load). Betika volume is spiky (1694 on 07-17, 881 on 07-18) — win only on busy days.
- **C2 (cheap insurance, NEEDS live EXPLAIN to pick index shape): `fixtures` full scan.**
  `src/apisports.js:401-405` (deep-stats target query) full-scans `fixtures` (EXPLAIN
  type=ALL, ~33.6k rows, timed **508ms**) because `status` is 97.8%-non-selective (final is
  the majority). Same bug class that once cost 180s on `odds_markets`. Fix: separate
  single-column indexes on `stats_fetched_at`, `lineups_fetched_at`, `events_fetched_at` so
  MySQL can index_merge three IS-NULL range scans. **EXPLAIN after creating candidate
  indexes to confirm the optimizer uses them** before committing the migration shape
  (forward-only migration). Additive, no logic change. Modest today (~0.5s) but grows with
  the table (~35k rows/month).
- **C3 (do NOT refactor blindly — instrument + measure first): `saveMatches` N+1 SELECT.**
  `src/db/store.js:113-168`: per-match transaction includes a per-match `SELECT existingOdds`
  (indexed, but ~1700 sequential round trips on a busy Betika day). Fix would bulk-prefetch
  the diff snapshot — BUT this has a REAL correctness nuance: `withRetry` exists because a
  concurrent writer can race the same match; prefetching outside the txn widens the
  staleness window. **FIRST** add `DEBUG=1`-gated per-phase timing (copy `hotpicks.js`'s
  `debugLog` model, `hotpicks.js:335-337`) to `saveMatches`, run a real busy day, and let
  the numbers decide if the risky prefetch is worth it. Medium risk — not a quick win.

Lower priority: #4 `link.js:144-145` per-match candidate N+1 (read-only, small blast radius
today, 179 rows/run — safe prefetch if wanted); #5 fetch-concurrently-write-serially for
stats/history (touches rate-limit globals, scoped prototype only); #6 InnoDB buffer pool
128MB vs ~1.68GB footprint (hit rate healthy 97.4% today — config-only forward-looking bump
to 512MB-1GB, don't claim it fixes today's wall-clock). Already-fixed/non-issues confirmed:
metadata insert-only exclusion shipped, odds_markets catalog index in place, fetch-once
design correct, boot cost negligible, DB_POOL not a contention point.

Also noted (DRY, low priority): `src/prematch.js:39-42` hand-duplicates the team-history
query instead of importing `hotpicks.js`'s exported `loadTeamHistory` — cleanup only.

---

## D. Remaining M12 work (from the admin program, still open)

- `.env.example` minimal rewrite: trim to creds/endpoints/boot-infra/VITE_* + "runtime
  knobs live in Admin→Settings" note (spec goal 5); FOLD IN section A1's AI-economy block.
  Local `.env` trim checklist → a section in `docs/DEPLOYMENT.md`. (Do NOT touch live
  `.env`/`.env.production` — gitignored user secrets.)
- Full chrome-devtools E2E pass (per the program plan's list — guest bundle, signup+consent,
  admin deep-links, settings, users, campaigns dry-run, maintenance window, DB overview/
  export/import roundtrip, performance parity, dashboard beacons).
- Docs sweep: QUICK-REFERENCE, `docs/engine/*` (+ its 00-README triggers table), CLAUDE.md
  (add `src/db/transfer-rules.js`, `src/db-transfer.js`, `src/db-info.js`,
  `src/db/scorecard-rules.js`, `src/scorecard.js`, DatabaseSection/PerformanceSection),
  `docs/memory-bank.md` dated notes, `docs/DEPLOYMENT.md` (export/import runbook — INCLUDE
  the operational caveat: the import safety-export dumps the FULL ~1.6GB warehouse before
  every apply). VERIFY every CLAUDE.md claim against code (M4.1 review found 4 false claims).
- **Version bump decision — RAISE WITH USER:** user said "1.2.1"; by semver this branch is
  a MINOR (1.3.0) — whole new subsystems + migration batches 15-19. `npm run package:deploy`
  tags `v<package.json version>` and pushes, so get the number right before tagging.
- Final whole-branch review (opus, `git merge-base main HEAD`..HEAD) → then
  superpowers:finishing-a-development-branch → merge to `main`. Deploy stays user-gated.

## E. Deferred MINOR review findings (final-review triage; none merge-blocking)
- Task 1: `fkSafeOrder` cycle error over-names non-cyclic tables (debug clarity); MANIFEST
  `created_at` is `z.string().min(1)` not `.datetime()`.
- Task 5: import-apply busy-slot 409 doesn't re-arm the poll like the export path's 409.
- Task 6: equivalence test hardcodes the BLIND_MARKETS literal instead of importing it.
- Task 7: error-path double-message (banner + widget empty-states).
- `settle()` still duplicated in `scripts/{edge-sentinel,backtest-sure-tips,mine-precursors,
  probe-value-edge,validate-precursor-boosters}.js` (Task 6 canonicalized only ai-scorecard).

## Suggested execution order (fresh session)
1. ~~AI-economy A1~~ **DONE `a50e978`.**
2. ~~Web B1/B2/B3~~ **DONE `428704a`.**
3. ~~Pipeline C1/C2/C3~~ **DONE `38e4278`** — C1 shipped, C2 refuted, C3 refactor rejected.
4. ~~`.env.example` full trim~~ **DONE `fab61a9`** (+ DEPLOYMENT §9).
5. ~~Docs sweep~~ **DONE `acfd8a8`, `8a7ac54`, `838cd00`.** E2E still OPEN — **← RESUME HERE.**
6. ~~Version decision~~ **DONE: 1.3.0, confirmed with the user, bumped in `61a769d`.**
   Final whole-branch review + merge still open.

### Session-11 detail for steps 4-6
- **`.env.example` trimmed data-driven, not by eye** (`fab61a9`): the config zod schema has
  121 keys, `SETTINGS_CATALOG` has 82 → exactly **39 non-admin-editable keys** belong in
  `.env`. Verified post-trim that all 39 are still documented and that the only
  admin-editable keys left are the two deliberate local-dev conveniences
  (`AUTO_REFRESH_ENABLED`, `DEBUG`). `docs/DEPLOYMENT.md` §9 records precedence
  (settings table → `.env` → code defaults) + the trim runbook; §8.3 was also fixed (it
  still told operators to expect the proof-of-work gate §8.1 records as removed).
- **Docs sweep** (`acfd8a8`, `8a7ac54`, `838cd00`): CLAUDE.md gained the M10/M11 module
  bullets + the full admin-section roster; QUICK-REFERENCE §2.3 split into `.env` vs
  Admin → Settings (it listed `AUTO_FULL_AT`/`SMS_ENABLED`/`DEBUG` as host `.env` config
  that a DB override silently outranks); `06-AI.md` gained the free-tier cap trap;
  `DEPLOYMENT.md` §10 is the new DB export/import runbook incl. the ~1.7 GB
  safety-export-per-apply caveat. A claim-verification pass fixed 4 real drifts
  (`SAFE_STRATEGY` `market`→`sure` was the HIGH one) — **and rejected 4 false positives**
  about migration batch numbers (knex batches are per-`migrate:latest`, not per file;
  batch 11 holds three migrations, offsetting every later ordinal by 2 — verified against
  `knex_migrations`). memory-bank gained resolved issues #25/#26.

### E2E checklist (the one remaining item before final review)
Needs `npm run build:web` + `npm run serve` (`AUTO_REFRESH_ENABLED=0`) + chrome-devtools:
guest bundle, signup+consent, admin deep-links, settings, users, campaigns dry-run,
maintenance window, DB overview/export/import roundtrip, performance parity, dashboard
beacons, **and B2's row-selection click behaviour** (only build-verified so far — it needs
real rows, and the DB now has today's 116 Betika games loaded).
Each substantive change → suite green + a task-scoped review before moving on (SDD flow).
