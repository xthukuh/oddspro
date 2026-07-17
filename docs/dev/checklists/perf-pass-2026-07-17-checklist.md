# Perf pass — 2026-07-17 (post-v1.2.0)

Source: `docs/research/spa-performance-audit-2026-07-16.md` (fixes #1/#2 — static gzip +
immutable caching — already shipped inside v1.2.0) plus the DB-side
`matches.metadata` churn item from the deferred inventory. Post-v1.2.0 work on
`main`; ships with the next release.

## Measured baseline (2026-07-17)

- `matches` table **696.5 MB data** for 14,904 rows — **`metadata` alone is
  556.4 MB** (14,565 rows × 39.1 KB avg raw provider JSON, 100% populated,
  ZERO readers anywhere in `src/`) and is rewritten wholesale on every odds
  upsert of every non-completed match, every sweep/light pass.
- `fixtures.metadata` 22.7 MB (0.7 KB avg) and `standings.metadata` 1.0 MB —
  immaterial, leave alone.
- `/api/columns` cold = 2.0 s (catalog aggregation over 1.79M `odds_markets`
  rows) on the FIRST hit after every `data_version` bump; 2 ms warm.
- `/api/records?date=…&per_page=all` = 698 KB raw / 85 KB gzip for 156 rows;
  ~84% of the pivot is non-canonical market keys the default view never shows;
  drives the 10,561-element DOM → 519 ms style recalc + 613 ms forced reflow.
- Guest bundle 585.8 KB raw / 170.1 KB gzip (wire cost now fine post-#1).

## Items

- [x] **P1. `matches.metadata` insert-only** (`src/db/store.js`): exclude
  `metadata` from the UPDATE branch of the upsert (settle-columns idiom — same
  reason `completed_at`/`fixture_id` are excluded); first-sight raw JSON is
  kept forever, refreshes stop rewriting ~39 KB/match/sweep. No deletion, no
  schema change, no reader to break (verified: writers only).
- [x] **P2. Warm the `/api/columns` catalog after refreshes** (audit #3):
  ALREADY SHIPPED in v1.2.0 — server.js "A5 pre-warm" (`startCatalogWarm`,
  boot warm + 30 s tick against the same `data_version`-keyed memo slot,
  started after listen, stopped on shutdown). Nothing to do.
- [x] **P3 (safe part). Catalog-gate the `/api/records` odds pivot**: the
  pivot now honors the same `discoverMarketColumns` allow-list the UI offers
  (armed by `columnCatalog()` — boot + 30 s warm; null before that = full
  pivot, the old behavior); `?markets=all` bypasses per request (the route's
  `req.query` cache-key spread already covers it). Verified on 2026-07-17
  (251 rows): zero catalog-offered keys lost. Every web consumer resolves
  keys through `catalog.markets` (`legPicks` reads `tip_breakdown`, not the
  pivot), so UX is byte-identical.
- **P3 measured reality (2026-07-17, 251 rows) — the audit's deeper cut is a
  PRODUCT decision, quantified for the user:**
  - The catalog itself admits **275 market keys** (minMatches=200 over 1.79M
    odds rows), so the gate only dropped 94 below-coverage keys
    (1876→1872 KB). The bloat lives INSIDE the catalog.
  - Field weights, FULL tier (1872 KB raw / 325 KB gzip): `markets` 641 KB
    (34%), `tip_ai_review` **524 KB (28%)**, `hot_signals` 153 KB,
    `hot_review` 100 KB, `h2h_meetings` 97 KB, `tip_breakdown` 84 KB.
  - GUEST tier (real traffic; redaction already strips the AI fields):
    1008 KB raw / 121 KB gzip — `markets` is **64%**.
  - **Option A** (helps guests, the real traffic): shrink the markets pivot
    below the catalog — selection allow-list param or default-keys-only.
    BREAKS M2's no-refetch sort/filter/column-add contract (client-side
    market filters evaluate `row.markets[key]` for ANY catalog key) and
    fragments the response memo per selection. Needs a UX call.
  - **Option B** (helps signed-in users; ~1 account today): strip
    `tip_ai_review`/`hot_review`/`hot_signals` (777 KB) unless the client
    asks (`?detail=1` when `useShowDetails`) — a prod build never renders
    them even signed-in. Small web+server change; check the 🔥 badge tooltip
    dependency on `hot_signals` first.
  - **Option C**: raise the catalog coverage threshold (shrinks the 275-key
    settings/filter offering AND the payload together; saved picks below the
    new bar vanish via the existing catalog sanitization).
- [x] **P4. Lighthouse quick nit** (audit #5, partial): `<meta name="description">`
  in `web/index.html`. Contrast + icon-label nits deferred (need DevTools).
- [x] **P5. Suite green 707/707, docs + memory updated, committed.**

## Deliberately NOT done (decision-gated — user)

- **Reclaiming the existing 556 MB** (e.g. `UPDATE matches SET metadata = NULL
  WHERE completed_at IS NOT NULL` + `OPTIMIZE TABLE`, or table compression):
  deletes API-fetched data — standing rule says user-gated. P1 only stops the
  rewrite churn and caps growth at first-sight size.
- Audit #5 contrast/label fixes, `llms.txt`: cosmetic, need browser inspection.
- Bundle code-split beyond the existing lazy AdminPanel (libphonenumber ~100 KB
  rides the guest bundle): wire cost is fine post-gzip; revisit only if a
  measurement says otherwise.
