# oddspro HTTP API reference

**Captured:** 2026-08-06 against a dev serve (`build 1.3.0+`, branch `feat/engine-v2`).
Example responses are REAL captures, trimmed with `…` where noted. Base URL below is
the dev default; the server binds `API_HOST` (default `127.0.0.1`) on port 3001.

```
http://127.0.0.1:3001
```

## Authentication modes

| Mode | How | Access |
|---|---|---|
| Guest | no header | public data, redacted tips (see `/api/records` notes), teaser Daily MultiBet, no future dates |
| User session | `Authorization: Bearer <session token>` from `/api/auth/login` | full data tier |
| Machine bearer | `Authorization: Bearer <API_TOKEN or ADMIN_TOKEN>` | legacy full access (`ADMIN_TOKEN` additionally opens `/api/admin/*`) |
| Personal access token | `Authorization: Bearer opat_…` (admin-minted, see below) | read-only full tier for integrations (n8n, automation) |

With `AUTH_ENABLED=0` every request is legacy full-access. Mutating endpoints
require the CSRF header `X-Requested-With: XMLHttpRequest` (custom headers force a
CORS preflight this server never approves cross-origin).

### Personal access tokens

Minted from Admin → API tokens, or programmatically (dual-auth: admin session or
`ADMIN_TOKEN` bearer, the machine-bootstrap path):

```
POST /api/admin/pats            {"user_id": 1, "name": "n8n-workflows", "expires_days": 90}
GET  /api/admin/pats            list (prefix, user, last used - never the token)
DELETE /api/admin/pats/:id      revoke (immediate)
```

The mint response carries the plaintext `token` EXACTLY ONCE; only its sha256 is
stored. A PAT resolves to the owning user's full read tier but: GET only (a write
answers `403` on token-aware routes, `401` on session-guarded ones), and never
valid on `/api/admin/*` or `/api/auth/*` regardless of the owner's role. Revoked,
expired, or disabled-user tokens degrade to guest. Mint/revoke are `admin_audit`
dated (`pat.create`/`pat.revoke`, prefix only).

## Conventions

- Heavy reads (`/api/records`, `/api/columns`, `/api/hotpicks`, `/api/performance`)
  are memoized keyed on the auto-refresh `data_version` and answer weak-ETag `304`s;
  browsers get `Cache-Control: no-cache` (always revalidate). Send `If-None-Match`.
- `sort` and `filters` are JSON-encoded query params validated against the column
  registry; an unknown key or op is a `400`.
- During a scheduled maintenance window every `/api/*` call (except auth/admin)
  answers `503` with `{ "error": "maintenance", "maintenance": {…} }` and a
  `Retry-After` header.
- Dates are EAT (`Africa/Nairobi`) day strings `YYYY-MM-DD`; `today`/`now` accepted.

---

## GET /api/records

The main dataset: one row per bookmaker match, correlated to canonical fixtures,
with the odds pivot, pre-match stats, tips, hot picks and AI reviews.

Query params: `date` (default today; `all` for every date), `page`/`per_page`
(`per_page=all` disables pagination), `sort` (JSON array), `filters` (JSON tree),
`completed=0` (hide concluded), `providers=betpawa,betika`, `markets=all` (bypass
the catalog gate on the odds pivot).

```
GET /api/records?date=2026-08-05&per_page=1
Authorization: Bearer <token>
```

```json
{
  "data": [{
    "match_id": 27654, "api_id": 1610921, "provider": "betpawa",
    "start_time": "2026-08-04T21:00:00.000Z",
    "fixture": "Carabobo FC - Trujillanos FC",
    "home_team": "Carabobo FC", "away_team": "Trujillanos FC",
    "score": "2-0", "goals": 2,
    "league": "Venezuela - Primera División", "season": 2026,
    "round": "Clausura - 2", "status": "FT", "elapsed": 90,
    "home_rank": 13, "home_form": "L", "away_rank": 1, "away_form": "W",
    "h2h": "6W-7D-5L", "h2h_count": 18,
    "h2h_meetings": [{ "date": "2026-02-08", "home": "Trujillanos FC", "away": "Carabobo FC", "score": "1-1" }, "…"],
    "home_goals_h2h": "8/9 (3.4)", "away_goals_oth": "4/12 (2.3)",
    "updated_at": "2026-08-04T23:04:07.000Z", "available": false,
    "hot": false, "hot_score": 0.469, "hot_outcome": "miss",
    "hot_signals": [{ "key": "home_sample", "value": 6, "threshold": 6, "pass": true }, "…"],
    "tip_market": "…", "tip_price": "…", "tip_confidence": "…",
    "tip_breakdown": { "…": "component probs, weights, samples, runners-up" },
    "markets": { "1": 4.6, "X": 3.4, "2": 1.75, "O 2.5": 1.62, "…": "…" },
    "markets_stale": { "…": "last-seen prices of vanished markets" }
  }],
  "meta": { "total": "…", "page": 1, "per_page": 1 }
}
```

Guest tier differences: future dates answer
`403 { "error": "Sign in to see upcoming games.", "auth_required": true }`;
`tip_breakdown`, AI review JSON and `hot_signals` are stripped; `tip_confidence`
is quantized to 0.05.

## GET /api/columns

Column catalog for building UIs/queries: market columns discovered from live odds
coverage, STATS columns discovered from `fixture_statistics`, providers from
`matches`. Shape: `{ markets: […], stats: […], providers: […] }`.

---

## GET /api/daily-slip

The Daily MultiBet card (engine-v2). One card per EAT day, frozen at first leg
kickoff, settled from canonical scores. Query: `date` (default today).

Guest (teaser: counts and mood only, no legs):

```json
{ "date": "2026-08-06", "slip": { "date": "2026-08-06", "status": "published",
  "mood": "amber", "legs_total": 6, "legs_hit": null, "combined_odds": 1.09,
  "outcome": null, "backfilled": false, "teaser": true, "auth_required": true } }
```

Signed-in / machine bearer (full card; one leg shown):

```json
{ "date": "2026-08-06", "slip": {
  "date": "2026-08-06", "status": "published", "mood": "amber",
  "combined_odds": 1.09, "legs_total": 6, "outcome": null, "backfilled": false,
  "algo_version": "v1-sim-2026-08-06",
  "legs": [{
    "fixture_id": 1607572, "home": "Ajax", "away": "Shelbourne",
    "league": "UEFA Europa Conference League",
    "kickoff": "2026-08-06T18:00:00.000Z",
    "market": "1X", "label": "Home or draw",
    "price": 1.01, "prices": { "betpawa": 1.01, "betika": 1.01 },
    "prob": 0.9742, "cal_prob": 0.9700,
    "cell": { "n": 160, "hit": 155 }, "cell_key": "dc|1.02",
    "reasoning": "Safest qualifying pick of this fixture: Home or draw at 1.01, calibrated 97.0% from 160 settled legs in its price/market cell (155 hit); bookmaker devig says 97.4%.",
    "outcome": null
  }, "…5 more legs"] } }
```

Field notes: `status` is `published` or `no_slip` (an honest no-bet day);
`mood` `green|amber|red` reads the day's qualifying pool; `outcome`
`won|lost|void|null` (null = pending) is written exactly once by the settle pass;
`backfilled: true` marks rows written by the hindsight-free replay generator, not
live builds; `prices` carries each bookmaker's own price for the display toggle.

## GET /api/daily-slip/timeline

Query: `days` (default 30, max 365). Streaks span the WHOLE history regardless of
`days`. Guest rows are teasers (as above); `greenRate` excludes voids.

```json
{ "streaks": { "current": 3, "best": 8, "greenRate": 0.8667, "played": 30 },
  "days": [
    { "date": "2026-08-06", "status": "published", "mood": "amber", "legs_total": 6,
      "combined_odds": 1.09, "outcome": null, "backfilled": false, "…": "…" },
    { "date": "2026-08-05", "status": "published", "mood": "amber", "legs_total": 6,
      "legs_hit": 6, "combined_odds": 1.08, "outcome": "won", "backfilled": true, "…": "…" }
  ] }
```

---

## GET /api/view

The RENDERED view (engine-v2 Phase 2): the exact dataset the signed-in browser
shows, computed server-side through the same shared pure pipeline the web runs
(`magic-rules` is imported verbatim by both). Built for n8n and automated
analysis: rows arrive already ordered by the chosen strategy, with day-level
membership flags attached. Full tier only (session, PAT or machine bearer);
guests get `401 { auth_required: true }`.

Query params: `date` (default today), `strategy` (default `sure`; the v2 menu is
`banker`/`target`/`value` and the web default is `banker`, but every registered
strategy id stays callable; unknown ids `400`), `safe_only=1` (filter to the Safe-pool fixtures), `one_of_each=1`
(collapse to the highest-priority provider per fixture), `providers=betpawa,betika`
(bookmaker filter AND the one-of-each priority order).

```
GET /api/view?date=2026-08-05
Authorization: Bearer opat_…
```

```json
{
  "date": "2026-08-05", "strategy": "banker",
  "strategies": ["banker", "target", "value"],
  "safe_policy": { "…": "the resolved SAFE_* gate values" },
  "daily_slip": { "status": "published", "mood": "amber", "legs_total": 6, "outcome": "won" },
  "counts": { "rows": 208, "safe": 0, "sure": 9, "daily_slip_legs": 6 },
  "rows": [{
    "rank": 1, "magic_score": 0.513,
    "flags": { "safe": false, "sure": false, "sure_prob": null, "daily_slip": false },
    "fixture": "FH Hafnarfjordur - KR Reykjavik", "tip_market": "U 5.5",
    "…": "every /api/records field: odds pivot, tip_breakdown, AI reviews, prematch stats"
  }, "…207 more, already in rendered order"]
}
```

`counts.safe` can legitimately be 0 on a day where no fixture clears the Safe
gates (the pool is policy-starved, not broken). Flags are computed over the WHOLE
day before `safe_only`/`one_of_each` trim rows, mirroring the web's discipline.

## GET /api/hotpicks

Over-2.5 hot-pick accuracy windows + the upcoming hot list.

```json
{ "windows": {
    "7d": { "picks": 111, "hits": 75, "misses": 36, "rate": 0.6757 },
    "30d": { "picks": 359, "hits": 248, "misses": 111, "rate": 0.6908 },
    "all": { "picks": 412, "hits": 282, "misses": 130, "rate": 0.6845 } },
  "pending": 36, "pending_reviews": { "hot": 21, "tips": 0 },
  "upcoming": [{ "fixture_id": 1546426, "kickoff": "2026-08-06T12:00:00.000Z",
    "score": 0.797, "ai_verdict": null, "fixture": "Sandefjord U19 - Åsane U19" }, "…"] }
```

## GET /api/performance

Flat-stake ROI / hit-rate / bucket report for tips and hot picks.

```json
{ "generated_at": "2026-08-05T22:34:05.097Z",
  "tips": { "windows": {
    "7d":  { "picks": 1782, "hits": 753, "misses": 378, "voids": 10, "pending": 641,
             "rate": 0.6658, "avg_price": 1.4223, "break_even": 0.7031,
             "staked": 1131, "profit": -62.7, "roi": -0.0554 },
    "30d": { "…": "…" }, "all": { "…": "…" } },
    "buckets": { "confidence": "…", "market": "…", "line": "…", "edge": "…" } },
  "hotpicks": { "…": "same shape" } }
```

## GET /api/magic-sort

Backtest-ranked tip strategies + the live calibration the web table scores with,
plus the effective Safe-only policy (`safe`) and sure-bets policy. Not memoized
(the `safe` object is per-response fresh). `?refresh=1` recomputes the day cache.
Since Phase 3 the `strategies` list is the v2 trio (`banker`/`target`/`value`)
and `calibration.leg_cells` carries the walk-forward menu-leg calibration cells
(`{shrinkK, cells: {"group|band": {n, hit}}}`) that power them.

---

## GET /api/refresh

Job state + the client freshness signal. Poll slowly (60s) and fast (2s) while a
job runs; reload when `data_version` moves and the run's scope covers your date.

```json
{ "running": false, "mode": null, "date": null, "dates": [], "step": null,
  "last_step": null, "started_at": null, "finished_at": null, "error": null,
  "cancelled": false, "cancelRequested": false, "summary": null,
  "data_version": 0, "last_success": null,
  "maintenance": { "state": "off", "start": null, "end": null, "message": null,
    "signature": null, "start_ms": null, "end_ms": null },
  "build": "1.3.0+mscb87k7" }
```

## POST /api/refresh?date=YYYY-MM-DD

Starts the single-slot background refresh for one date. Requires header
`X-Requested-With: XMLHttpRequest`. Responses: `202` job started;
`200 { "fresh": true }` (already refreshed inside `REFRESH_CACHE_MINUTES`);
`409` another job holds the slot (auto refresh, manual refresh, or a DB
export/import); `429` per-date manual cooldown with `retry_after_seconds`.

## GET /api/visits/daily-unique

Public status-bar badge counter: `{ "date": null, "unique": 0, "total": 0 }`
(unique sessions today; nulls/zeros on a fresh dev DB).

## GET /api/settings

Public subset of the runtime settings catalog (safe-only policy knobs the web
needs). Admin editing happens on `/api/admin/settings`.

---

## Other surfaces (summary)

- **Auth** `POST /api/auth/signup|login|verify-otp|resend-otp|change-phone|logout`,
  `GET /api/auth/me`, `PUT /api/auth/profile`, `POST /api/auth/forgot-pin|reset-pin|
  pin-change-otp`: phone + 4-digit PIN accounts, OTP by SMS with email fallback.
  Per-route body limits, sliding-window rate limits, generic 401s by design.
- **Prefs** `GET|PUT /api/prefs`: cross-device settings blob, last-write-wins,
  `409 { conflict, server }` on a stale version.
- **Tracking beacons** `POST /api/visit/checkin|events|checkout`: best-effort by
  contract, always answer `{ ok: true }`.
- **Admin** (`ADMIN_TOKEN` bearer or admin session; audit-logged): `/api/admin/
  settings|users|sms/*|db/*|lab/*|perf/scorecard|track/summary`, `/api/visits/summary`.
  Deliberately undocumented here; see `docs/engine/` chapters and the admin UI.

## Error envelope

Errors are JSON `{ "error": "<message>" }` plus contextual fields:
`auth_required: true` (guest hitting a gated resource), `pin_change_required: true`
(forced PIN change), `retry_after_seconds` (rate limits), `attempts_left` (PIN/OTP),
`maintenance: {…}` (503 window). Unknown filter/sort keys and malformed JSON params
are `400`.
