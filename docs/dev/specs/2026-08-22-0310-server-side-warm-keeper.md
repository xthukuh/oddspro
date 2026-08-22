# Server-side warm keeper + persistent client cache seed

Owner ask (2026-08-22): stop relying on visitors to wake critical services (response
caching, pre-processing). Execute and monitor them in the always-running server.js so the
client side is ready at all times, without introducing stale data - served payloads must
track the newest bookmaker odds the collectors have written.

## Problem

Two visitor-wakes-the-service behaviors remained:

1. Server: the response memo (`src/http-cache.js`) invalidates on every
   `warehouse_version` bump - each 10-minute light pass - and `/api/records` (the payload
   behind the table spinner) was deliberately demand-computed. The first human after every
   refresh paid the ~1s+ cold compute per date; only `/api/columns` and the magic-sort day
   memo had a warm tick.
2. Client: the in-memory records LRU dies with the tab. Every brand-new visit started
   empty, so the table showed the loading spinner even for data the browser had held
   minutes earlier.

## Design

### Warm keeper (`src/warm.js` + pure `src/db/warm-rules.js`)

- 5s unref'd tick in EVERY instance (the memo is per-process). Pass reasons, pure
  `warmPassDue`: `boot` / `version` (warehouseVersion moved - followers see the writer's
  bump via the existing 5s meta poll) / `age` (last pass older than
  `WARM_MAX_AGE_MINUTES`; `makeJsonCache.warm` gained `{maxAgeMs}` so the entry is
  force-rebuilt before the memo's 10-min TTL could expire it cold - this also bounds
  staleness against out-of-process writers that never bump the version).
- Targets per pass, SEQUENTIAL (DB_POOL_MAX is 3 live): `/api/columns` (writer scans,
  followers read the persisted meta catalog), `/api/records` for
  `warmDates(today, back, ahead)` x reachable access tiers (`reachableTiers` mirrors the
  route's tier expression so warmed keys are byte-identical to real request keys;
  duplicate tiers collapse, no-future tiers skip future dates), `/api/hotpicks`,
  `/api/performance`. The magic-sort day memo is kicked un-awaited (~25s cold replay must
  not block the records warm).
- Failure posture: `lastRunAt` stamps even on a failed pass, so retries wait for the next
  due reason rather than tight-looping at 5s against a struggling DB. Not quiesced during
  maintenance windows (local reads, never billed; caches should be hot at window end).
- Monitoring: `warmStatus()` rides `GET /api/refresh` as `warm` (reason / started_at / ms
  / targets / computed / failed / errors<=5) plus `[warm]` console lines.
- Knobs (settings group `refresh`, all live): `WARM_ENABLED` on, `WARM_DATES_BACK` 1,
  `WARM_DATES_AHEAD` 2, `WARM_MAX_AGE_MINUTES` 5.
- `apiCache` LRU max raised 12 -> 24 so demand-traffic variants cannot evict the warmed
  set. Replaced `server.js`'s old 30s catalog-only warm tick.

### Freshness argument (why this cannot serve stale data)

The keeper never decides freshness - the memo key does. A successful refresh bumps the
shared `warehouse_version`, atomically invalidating every entry; the keeper only moves the
recompute off the first visitor and onto itself, within ~10s of the bump on every
instance. Odds recency is therefore exactly the collector cadence (light pass tiers), as
before, minus the human-triggered recompute stall.

### Persistent client cache seed (`web/src/recordsCache.js` + `recordsPersist.js`)

- Pure `packRecordsCache`/`unpackRecordsCache` (offline-tested): newest <=3 entries within
  ~2.5M chars to localStorage `oddspro.recordsCache`; an oversized body ('all' view) is
  skipped, not allowed to crowd out today's. Hydrated at App module scope, so a fresh tab
  paints instantly; the existing every-hit revalidation self-corrects a stale seed within
  the first (now warm, ~10ms/304) round trip. Seeds older than 12h are dropped;
  `PERSIST_FORMAT` gates cross-deploy shape drift.
- Device-local by contract: excluded from prefs sync (`DEVICE_EXACT`) and `.oddspro`
  snapshots (`isTransient`) - multi-MB bodies must never ride either channel.

## Verification (2026-08-22, local)

- Suite 1170/1170 (new: tests/warm-rules.test.js; extended: records-cache,
  config-snapshot, prefs-rules).
- Boot pass 9/9 computed; `/api/records?date=today&per_page=all` = 12ms full 4.45MB body
  (503KB gzip), 7ms 304 revalidation, vs ~900ms+ cold before.
- Out-of-process `bumpWarehouseVersion()` triggered an automatic `version` pass (9/9
  recomputed) with no request involved - the keeper, not a visitor, wakes the cache.
