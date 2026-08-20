# Data Notices: outage ribbon + machine-readable coverage tag

Spec, 2026-08-20 21:14. Status: awaiting user review.

## 1. Problem

When collection breaks, the affected days silently show thin or empty odds. Nothing
tells a human why, and nothing tells an automated consumer that the rows are
incomplete. The 2026-08-16 to 2026-08-18 outage (documented in
`docs/research/2026-08-19-odds-durability-and-outage-damage.md`) is still invisible in
the UI and in every API payload.

## 2. What was measured before designing

The first proposal was to detect a bad day statistically: flag a day whose captured
row count falls below 40% of a trailing median. **That was tested against the live
warehouse and refuted.** Probe output, matches captured per match-date:

| Date | Rows | Trailing-14 median | Ratio | Truth |
|---|---|---|---|---|
| 2026-07-20 | 203 | 780 | 0.26 | healthy |
| 2026-07-21 | 181 | 780 | 0.23 | healthy |
| 2026-07-27 | 154 | 780 | 0.20 | healthy |
| 2026-07-28 | 164 | 615 | 0.27 | healthy |
| 2026-08-17 | 203 | 1456 | 0.14 | **outage** |
| 2026-08-18 | 57 | 1456 | 0.04 | **outage** |

At a 0.40 threshold the rule fires on five healthy days in a 45-day window. Two
reasons it cannot work:

1. **The baseline is not stationary.** Daily captures ran 154 to 1,983 through July,
   then 926 to 3,152 from 2026-08-05. Any rolling median straddling that shift is
   wrong on both sides of it.
2. **The football calendar is the noise.** Mondays and Tuesdays are genuinely thin.
   A healthy Monday and an outage Monday have the same row count.

Two other candidate signals were measured and also rejected:

- **matches / fixtures coverage ratio**: ranges 87% to 1770%. Bookmakers list far more
  competitions than API-Football carries, so canonical fixtures are not a denominator.
- **new rows created per wall-clock day**: reads 0 on 2026-07-27 and 2026-08-01, both
  healthy. It only counts first sightings, so a day where nothing new appeared looks
  identical to a day where nothing ran.

**Conclusion: do not infer the outage from the shape of the data. Read it from the
collector, which already knows.**

## 3. Design

### 3.1 Ground truth already in the codebase

`src/pipeline.js` `runStartPipeline` and `src/auto-refresh.js` `lightRefresh` already
return `{ dates, step_failures, steps_verdict, data_bearing_ok }`, where
`steps_verdict` is `ok` / `partial` / `error` from `summarizeSteps`
(`src/db/auto-rules.js`). Every refresh pass already classifies itself. Nothing of that
is persisted beyond a log line.

Persisting it turns outage detection into a lookup, with no heuristic and no false
positives:

- a stretch of wall-clock time with **no successful pass** => `outage` for the dates
  those passes would have covered
- a pass that returns **`partial`** => `degraded` for the dates it covered, naming the
  steps that failed

### 3.2 New table: `collection_runs`

Append-only, one row per refresh job. Written by the single writer instance only.

| column | type | note |
|---|---|---|
| `id` | bigint PK | |
| `started_at` / `finished_at` | datetime | EAT, pinned session |
| `mode` | varchar(16) | `full` / `light` / `manual` |
| `dates` | json | the match dates the pass covered |
| `verdict` | enum | `ok` / `partial` / `error` |
| `step_failures` | json | `[{step, error}]`, empty on ok |
| `created_at` / `updated_at` | datetime | house convention |

Retention knob `COLLECTION_RUNS_RETENTION_DAYS` (default 90). At the 10-minute light
cadence this is about 144 rows/day, so 90 days is roughly 13k rows.

### 3.3 New table: `data_notices`

One row per warning about a span of match dates.

| column | type | note |
|---|---|---|
| `id` | bigint PK | |
| `kind` | varchar(32) | `odds_outage`, `odds_degraded`, and anything future |
| `severity` | enum | `outage` / `degraded` |
| `status` | enum | `unconfirmed` / `approved` / `dismissed` |
| `source` | enum | `auto` / `manual` |
| `date_from` / `date_to` | date | inclusive span of affected match dates |
| `title` | varchar(80) | short human label |
| `note` | varchar(240) | one plain sentence |
| `evidence` | json | whatever the detector saw |
| `created_by` | bigint FK users, `ON DELETE SET NULL` | audit pointer, nullable |
| `created_at` / `updated_at` | datetime | |

Unique index on `(source, kind, date_from, date_to)` so the detector is idempotent.

`kind` is deliberately open text. A future discovery (missing provider, linker gap,
late settlement) is a new `kind` value and needs no schema change and no new code path.

### 3.4 Lifecycle and the approval gate

```
detector (writer, once per full sweep)
   |
   +-- proposes auto notice, status = unconfirmed
   |      served immediately, label prefixed "UNCONFIRMED"
   |
   +-- admin Approve  -> status = approved, prefix drops
   +-- admin Dismiss  -> status = dismissed, hidden, and the unique index
                          stops the detector re-raising the same span
```

Manual notices an admin writes are born `approved`. Every status change writes an
`admin_audit` row in the same transaction (the M6/M8 discipline already used by
settings and admin-users).

The unconfirmed-but-served behaviour is the point: the warning works while the owner is
unavailable, and approval only removes the hedge.

### 3.5 Pure rules module

`src/db/notice-rules.js`, zero imports, offline-tested, imported **verbatim** by both
server and web (the `magic-rules.js` idiom, so client and server cannot drift).

The gap threshold is a knob, `COLLECTION_GAP_MINUTES`, default 90. The light pass runs
every `AUTO_LIGHT_MINUTES` (10 by default), so 90 minutes is nine missed cadences.
Important: the threshold counts **missing run rows**, not missing odds. A quiet-slate
idle skip (`AUTO_IDLE_LOOKAHEAD_MINUTES`, `lightPassIdle`) still runs the pass and still
writes an `ok` row, so a legitimately idle night can never be read as an outage.

```
runGapSpans(runs, {maxGapMinutes})     -> [{from_at, to_at, date_from, date_to}]
detectNotices(runs, {maxGapMinutes})   -> notice proposals
noticesForDate(notices, day)           -> notices covering that date
coverageStatus(notices)                -> 'ok' | 'degraded' | 'outage'
noticeLabel(notice)                    -> display string, adds UNCONFIRMED prefix
severityRank(severity)                 -> for picking the loudest of several
```

### 3.6 Serving with no query on the hot path

The writer persists the active notice list to `meta.data_notices` (JSON) on every
change, exactly as it already persists `column_catalog`. The existing 5-second
`meta` memo poll (`src/meta.js`) makes it a synchronous in-memory read on every
instance. No new query on any request. Multi-instance safe by construction.

### 3.7 API contract

New key, nothing removed, so no existing consumer breaks.

```json
"coverage": {
  "status": "outage",
  "confirmed": true,
  "notices": [{
    "kind": "odds_outage",
    "severity": "outage",
    "status": "approved",
    "from": "2026-08-16",
    "to": "2026-08-18",
    "title": "No odds collected",
    "note": "Collection was down. Odds for these games were never captured.",
    "evidence": { "last_success": "2026-08-16T01:20:00+03:00", "gap_hours": 71 }
  }]
}
```

Surfaces:

| Endpoint | What it carries |
|---|---|
| `GET /api/records` | `coverage` for the queried date (union of spans for `date=all`) |
| `GET /api/refresh` | full active list, so the web ribbon needs no extra fetch |
| `GET /api/daily-slip/timeline` | per-day `coverage` next to the existing `backfilled` tag |
| `GET /api/coverage` | public list of every known span, cached like `/api/columns` |

`/api/records` and `/api/coverage` ride the existing `apiCache` keyed on
`warehouse_version`, so a notice change invalidates them the same way a data refresh
does.

### 3.8 The ribbon

New component `web/src/components/CoverageRibbon.jsx`, rendered between the table and
the existing `<footer>` in `App.jsx`. Tiny text, one line, always visible on an
affected day, not dismissible. Data comes from the `/api/refresh` poll the app already
runs every 60 seconds.

Colour: `--orange` for outage, a new `--yellow` token for degraded, both defined in
`web/src/index.css` for light and dark.

**Copy rules (user directive: short, direct, precise, no unnecessary detail).**

| State | Ribbon text | Tooltip |
|---|---|---|
| outage, approved | `No odds collected this day.` | `Collection was down 16-18 Aug. These odds were never captured and cannot be recovered.` |
| degraded, approved | `Some odds missing this day.` | `Collection ran but did not finish. Some games have no odds.` |
| unconfirmed | `UNCONFIRMED - No odds collected this day.` | same, plus `Not yet reviewed.` |

No row counts, no percentages, no timestamps in the ribbon itself. Numbers live in
`evidence` for machines and in the admin panel for the owner.

### 3.9 Admin

A `NoticesCard` in the existing admin DashboardSection: list of notices, newest first,
with Approve / Dismiss / Edit note, plus a form to add a manual notice. Reuses the
existing admin session guard, `csrfOk`, and the typed-confirm pattern from
`UsersSection.jsx`. Routes under `/api/admin/notices`, admin session only.

### 3.10 Seed

One manual, approved notice recorded at migration time for the known event:

- `odds_outage`, `outage`, 2026-08-16 to 2026-08-18
- title `No odds collected`
- note `Collection was down. Odds for these games were never captured.`
- evidence: the row counts from the research doc (1,049 / 203 / 57 against a healthy
  band of roughly 1,000 to 3,000)

2026-08-19 is deliberately **not** seeded: 469 rows against a recovering day is thin
but the pass succeeded, and marking it would teach the reader that the ribbon fires on
ordinary variation.

## 4. Build order

All three phases in one effort, as agreed.

1. Migrations, `notice-rules.js` + its tests, `collection_runs` writes from
   auto-refresh, the seed notice.
2. Detector, `meta` projection, all four API surfaces.
3. Ribbon, admin card, docs.

## 5. Testing

Offline `node:test`, no DB and no live API, matching the existing suite:

- `runGapVerdict`: clean run history yields no spans; a 71-hour gap yields one outage
  span; a `partial` run yields `degraded` for its dates only.
- `noticesForDate`: boundary dates inclusive on both ends.
- `coverageStatus`: outage beats degraded beats ok when several notices overlap.
- `noticeLabel`: prefix appears only for `unconfirmed`, never for `approved`.
- Regression: the probe's five healthy days (2026-07-20, 21, 27, 28, 30) must produce
  **no** notice. This is the guard against reintroducing a row-count heuristic.

## 6. Out of scope

- A full user-centric convenience overhaul of the app. Agreed as a later effort, and
  recorded here only so it is not lost.
- Backfilling `collection_runs` for dates before this ships. Not possible, and not
  needed: the one known historical outage is seeded by hand.
