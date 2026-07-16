# SPA performance audit — 2026-07-16

*End-to-end performance test of the built web app (`web/dist`) served by
`npm run serve` on :3001. HEAD `183d214`, fresh production build, single server
with the auto-refresh scheduler OFF, MariaDB 11.7.2, Chrome driven via
chrome-devtools. Zero console errors across every run. Read-only — no code was
changed.*

## Headline

The app is **fast once loaded and cached** (desktop LCP 842 ms, CLS 0, warm API
2 ms) but the **cold first visit on mobile is slow — FCP ≈ 5.2 s on Slow 4G** —
and the cause is a **server config gap, not the React code**: static assets are
served **uncompressed** and with **no long-lived cache**. Two small `server.js`
changes recover roughly **3 seconds** of that cold-load time. Everything else
(gzip, ETag/304, the data_version memo) already works well on the API layer; the
static layer was simply never wired into it.

## What was measured

### Bundle (production build, gzip in parens)
| Asset | Raw | Gzip |
|---|---|---|
| `index-*.js` (guest bundle) | 585.8 KB | **170.1 KB** |
| `AdminPanel-*.js` (lazy, admin-only) | 406.1 KB | 118.7 KB |
| `index-*.css` | 46.4 KB | 9.4 KB |
| Inter fonts (woff2, on-demand by unicode-range) | ~230 KB | — |

Build time 4.1 s. The guest bundle trips vite's 500 KB warning but is not the
binding constraint — its *transfer* is (see below).

### API endpoints (cold → warm, gzip request)
| Endpoint | Cold | Warm | Payload |
|---|---|---|---|
| `/api/refresh` | 24 ms | 2 ms | 225 B |
| `/api/columns` | **2024 ms** | 2 ms | 3.2 KB gzip (52.8 KB raw) |
| `/api/records?date=today&per_page=all` | 492 ms | 2 ms | **85 KB gzip / 698 KB raw**, 156 rows |
| `/api/magic-sort` | 81 ms | 2 ms | 1.1 KB |
| `/api/visits/daily-unique` | 31 ms | 11 ms | 35 B |

API caching is healthy: `Content-Encoding: gzip` (8.2× on records), weak ETag →
**304 revalidation in 1.4 ms**, `data_version`-keyed memo (cold→warm ≈ 250×).

### Load — Core Web Vitals
| Scenario | LCP | FCP | CLS | Notes |
|---|---|---|---|---|
| Desktop, warm cache | **842 ms** | — | 0.00 | render delay 838 ms (TTFB 4 ms) |
| Mobile 4× CPU / Slow 4G, warm assets | **1688 ms** | — | 0.00 | render delay 1684 ms; render-blocking CSS ≈ 550 ms |
| Mobile Slow 4G, **cold cache (first visit)** | — | **5180 ms** | — | JS download **4174 ms**, DCL/load 4976 ms |

LCP is **render-bound**, not network-bound — TTFB is 4 ms in every run. On the
cold mobile visit, FCP waits on the uncompressed JS bundle download.

### Frontend cost drivers (why the render delay is ~840 ms even warm)
- **DOM = 10,561 elements** — 156 rows × the full market-column set. `TBODY` has
  113 direct children; largest style recalc **519 ms over 10,461 elements**.
- **Forced reflow = 613 ms** — layout thrashing inside the main bundle
  (JS reading geometry after DOM mutation; consistent with sticky/pinned-column
  measurement). Present on load AND on re-render.
- **INP (date change, 4× CPU) = 287 ms** — "needs improvement" band, usable.

### Lighthouse (desktop navigation)
Accessibility **96**, Best Practices **100**, SEO **91**, Agentic 67. Four fails,
all minor: `color-contrast`, `label-content-name-mismatch`, `meta-description`
(none in `index.html`), `llms.txt`.

## Fixes, highest value first

### 1. Compress static assets (biggest win — ≈ 3 s off cold mobile)
`server.js:613` serves `express.static(dist, …)` with **no compression** — the
`compression` package isn't even a dependency; only the API layer
(`http-cache.js`) gzips. Confirmed at the wire: the JS responds
`Content-Length: 585769` with **no `Content-Encoding`**. Gzip takes the bundle
586 KB → 170 KB (brotli ≈ 140 KB); on Slow 4G that turns the 4.17 s JS download
into ~1.2 s. Add `compression` middleware, or precompress at build (a vite
plugin emitting `.br`/`.gz` + `express-static-gzip`) for zero per-request CPU.

### 2. Immutable caching on hashed assets (repeat-visit round-trips)
`express.static` defaults to `Cache-Control: public, max-age=0`, so **every
asset revalidates on every visit** (observed: all bundles return 304 on reload).
Vite content-hashes the filenames, so they are safe to cache forever. Set
`maxAge: '1y', immutable: true` on the static mount (`.html` already forced to
`no-cache`, keep it). **Note:** the comment at `server.js:610` already *claims*
"hash-named assets keep their default (immutable) caching" — but Express's
default is `max-age=0`, so the comment is wrong and the intent was never
implemented.

### 3. `/api/columns` cold latency (2.0 s, secondary)
The catalog aggregation (`count(distinct match_id)` per `(type_name,name,
handicap)` over the 2.4M-row `odds_markets`) costs 2 s on the **first** hit after
each `data_version` bump, then 2 ms from the memo. A first visitor after a
refresh eats it. Options: precompute/materialize the catalog on refresh, or
narrow the scan. Lower priority than #1/#2 (amortized by the memo).

### 4. Trim the `/api/records` payload (secondary, also helps the DOM)
698 KB raw for 156 rows, of which (per the architecture note) **~84 % is
non-canonical market keys** the default view never shows. A `column`-only pivot
or a `markets` allow-list param would shrink the payload, the 10.5 K-element DOM,
and thus the 519 ms style-recalc + 613 ms reflow. Already flagged as an
optimization backlog item; this audit quantifies its render cost.

### 5. Cosmetic Lighthouse nits
Add a `<meta name="description">` to `index.html` (SEO 91→~100); check the
flagged low-contrast text and the icon-button label/name mismatch (A11y 96).

## Verdict

No blocker, no console errors, no layout shift, correct caching on the dynamic
layer. The one materially slow path — cold mobile first paint — is a **static
serving misconfiguration** (fixes #1 and #2, ~10 lines in `server.js`), not a
frontend-code problem. Fix those before the next `oddspro.ke` upload; treat #3–#5
as backlog.

## Reproduce
```
npm run build:web
AUTO_REFRESH_ENABLED=0 npm run serve      # :3001, scheduler off
# then drive http://127.0.0.1:3001 in Chrome; traces saved this run:
#   scratchpad/trace-desktop.json / trace-mobile.json / trace-interaction.json
```
