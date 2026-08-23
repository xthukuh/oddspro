# 08 - Web client (React SPA)

`web/` is the React 19 + Vite 6 + Tailwind 4 datatable that visualizes the warehouse - a
compact (`text-xs`), iPadOS-native-look single page app (light/dark, Phase 23) served as a
static build from `npm run build:web`. Per-file server architecture lives in `CLAUDE.md`;
this chapter is the client's own behavior, presentation history and the localStorage/state
contracts that keep it in sync with the server.

## App shell and theme

The whole page is a fixed `100dvh` app shell - only the table scrolls. Theme is a Tailwind 4
`@theme inline` + CSS-variable token layer in `web/src/index.css`
(`--surface`/`--label`/`--accent`/`--separator`/`--fill`/`--nav-bg`/`--logo`/`--green(hit)`/
`--orange(hot)`/`--red(miss)`, and more) that flips light/dark on `prefers-color-scheme` and a
`:root[data-theme]` override (the override wins in both directions). Font stack is
`-apple-system,...,Inter Variable` (SF on iPad, self-hosted Inter as the fallback).

Shared iOS-style primitives: `Sheet.jsx` (centered sheet, blur scrim, Escape/backdrop
dismiss), `Logo.jsx` (theme-adaptive `[OP]` mark, links home to today), `CalendarPopover.jsx`,
`OverflowMenu.jsx`, `icons.jsx` (SVG line icons + a spinner).

**Phase 23** was presentation-only: Score/Tip pins, sort, scroll-preservation, the magic
column, filters and all behavior were left unchanged, and the suite stayed at 185/185.

**Phase 24** (theme + filters + touch, also presentation-only, suite 192/192) shifted the
token palette to a **teal accent** (`--accent` #0FB5A6 light / #17C9BA dark; links render
teal, no default underline) over a **warm-slate dark** theme (bg #1A191D, warm-white labels)
lifted off pure black. `color-scheme` is pinned per theme so native controls follow a forced
theme, and a global `select`/`option` rule fixes dark-mode legibility. A real **theme
switcher** (System / Light / Dark) lives in Settings via `web/src/theme.js` (writes or
removes `data-theme`; System defers to the OS) with a FOUC guard in `index.html`; `IconGear`
became a true cog.

**v1.0.2** (merged to `main` 2026-07-13, presentation + analytics UI) shifted the accent to
**`[OP]` purple** (`#5856dc` light / `#8B89F0` dark; the betika badge moved to the freed teal;
the main Tip link renders purple). It also consolidated Score/Tip/Magic into ONE left-pinned
**summary cell** (stacked, color-coded, content-fit) replacing the separate pinned
duplicates, with a sticky-hover-bleed fix: `--fill` is layered as a gradient over the opaque
tint rather than swapping the pinned cell's background color, because the pinned cell's
background must stay opaque or a sticky-scroll hover would bleed the row tint through it. The
**Goals** column was removed in the same pass (its total now lives in Score's `3:2-1` prefix;
still filterable via `EXTRA_BASE_LABELS`). Header tooltips show each column's filter
key/type/example expression (pure `filterHint()` in `columns.js`).

Favicon `web/public/icon.svg` zoom-fits "OP" (the raster `.ico`/`.png` fallbacks are
unchanged - there is no local SVG rasterizer).

## The table: columns, sorting, pinning

Row tints cycle per canonical fixture (`api_id`) so the same match shown under multiple
providers shares a color. Row tooltips surface the odds refresh time; the Status cell
tooltip appends the live match minute for in-play statuses (e.g. `Second half (live) - 67'`,
sourced from `fixtures.elapsed`). Stale market prices render greyed, and a frozen match
(unavailable - concluded, or carrying no live markets) greys ALL its prices the same way;
unavailable matches lose their link unless re-enabled per provider in Settings. The table is
unpaginated - the whole selected date loads at once, with the record count shown below it.

Missed tips render red. An AI veto no longer strikes a tip through (`src/hotpicks.js`'s
honesty note: the veto doesn't shape ranking or display) - it only surfaces in
`TipPopover.jsx`'s details-gated "AI double-check" section and the selection "Export CSV".
Clicking a tip cell opens `TipPopover.jsx`, phrased for laymen: a "Why this tip" blend with
signals named in plain words (bookmaker odds / recent form / expert data) and weights shown
as %-of-verdict, evidence samples, runner-up candidates ("Close alternatives"), the over-2.5
gate audit labeled via the exported `SIGNAL_LABEL` glossary (reused by the table's fire badge
tooltip so the two surfaces never drift), spelled-out AI verdicts, and a shield Safe-pick
badge on rows passing `safeQualifies` - v2 AI reviews additionally render the model's own
probability, per-check findings and grounding source links. Ineligible fixtures show a muted
"no data" marker backed by `tip_skip_reason`.

Text columns whose sort value is DERIVED and otherwise hidden render that value inline as a
greyed `value:text` prefix - `home/away_form` points, `h2h` points, `score` total goals,
`fs:*` H+A sum (e.g. `8:LWWWD`, `3:2-1`) - using the exact `sortValue` the ordering itself
uses. Rolling-goals columns (whose average is already shown in parentheses) and `tip` keep
the `sorts as:` tooltip instead.

**Unified multi-sort** (`web/src/ordering.js`, `orderRows(rows, chain, columns, cal)`):
column sorts and magic strategies live in ONE prioritized chain (entries
`{type:'column',key,dir}` or `{type:'magic',id}`, index 0 = highest priority), scored by the
shared `sortValue` (for columns) plus `scoreTip` (for magic) - there is no more
magic-XOR-column exclusion. Header click is **additive**: it cycles that column
desc -> asc -> removed while keeping the rest of the chain; shift-click isolates the chain to
just that column. The `Magic` sheet (`MagicMenu.jsx`, Phase 23) toggles one or more
backtest-ranked strategies from `GET /api/magic-sort`'s top-5 (slip-survival / top-picks /
streak / ROI, with a plain-language legend tooltip and small-sample warnings); "Clear magic
sorts" drops every magic entry. A pills strip (`SortPills.jsx`: priority number, `x` remove,
"Clear all") plus the Settings "Sort priority" `ReorderList` dropdown (shown only when the
chain is non-empty) manage the chain; it persists under `oddspro.sort` (one-time migrating
the legacy `oddspro.magic.strategy` string) and revalidates magic entries against the fetched
strategy list. The synthetic magic column tracks the highest-priority magic entry.

Header tooltips, column order and market/stats selection: see "Settings, prefs sync and
config snapshots" below.

## Filters and selection

The advanced filter builder (`FilterBuilder.jsx`, opens as an iOS sheet since Phase 23;
controls were unchanged in that phase, filter enhancements were deferred) offers
`= != > >= <=`, `contains`/`not contains`, and CSV-list `in`/`not in` (value-only, no
column-to-column comparisons); `filterValues.js` runs derived-STATS/score conditions
client-side with the same operator semantics.

**Phase 24** made selectors date-dynamic: `web/src/columns.js`'s `availableColumnKeys(rows)`
limits the Settings market/stats `MultiSelect` options and the filter fields to what the
loaded day actually carries (persisted picks are preserved), and `labelFor(key,catalog)` -
reusing `BASE_COLUMNS`, moved to `web/src/baseColumns.js` - gives filter fields the exact
table column titles. `FilterBuilder.jsx` groups fields (Match / Betting / Markets /
Team&H2H / Post-match), offers **list-value pickers** for low-cardinality fields (league,
status, provider, season, round, via `distinctValues`; `in`/`not-in` reuse `MultiSelect`,
`eq`/`ne` use a themed select) and a **live match-count preview**. `league` filters
client-side (`CLIENT_ONLY_KEYS` in `filterValues.js`) because its "Country - Name" display
does not match the underlying `l.name` SQL column. `MultiSelect` renders its panel
`position:fixed`, anchored to its trigger, so no ancestor `overflow` can clip it.

**v1.0.2** added a **selection-count badge** on the Select header that doubles as a
**bulk-actions dropdown** (`web/src/components/BulkActionsMenu.jsx`): Invert / Select Similar
(same-`api_id` siblings) / Prioritize Selected / Keep One Provider / Hide selection - all
backed by pure helpers in `filterValues.js`. FilterBuilder nodes carry a **per-node enable
checkbox** to park a condition or group without deleting it (skipped in eval/split/count,
rides the wire as `enabled:false`). Heavy client re-orders (a magic sort or a bulk filter) run
inside a React `useTransition` plus a delayed spinner so a big day never freezes the UI.

**Filters persist and sync (2026-07-17):** the advanced-filter tree persists under
`oddspro.filters` (written by `applyFilters`, so it rides both the prefs sync and `.oddspro`
config exports) and is restored on boot via a one-time, catalog-gated hydrate through the
pure `sanitizeFilters` (`filterValues.js`, offline-tested) - a stale key saved by an older
deploy or another device is pruned instead of 400-ing the records query (expr nodes are
always kept since they are client-only).

## View toggles and the subset warning

Settings sheet: `MultiSelect.jsx` multi-select dropdowns for markets/stats/link-providers,
plus the shared **`ReorderList.jsx`** collapsed reorder dropdown (up/down arrows, an optional
per-row enable checkbox, an x remove, an inline tag; a fixed-anchored panel like
`MultiSelect`) used for THREE lists:

- **Providers** - enable checkbox + priority; the enabled set persists as
  `oddspro.providers.visible`, the order as `oddspro.providers.order` (the order decides
  which provider represents a game under One-of-each).
- **Column order** - up/down + a Reset footer; order persists as `oddspro.cols.order`.
- **Sort priority** - up/down + x remove + a direction tag.

One collapsed control per list replaced the always-visible drag pills, freeing settings
space; selections persist in localStorage, sanitized against the catalog.

**Phase 28** merged "Columns" and "Sorting" into one Settings group once the reorderers
became compact dropdowns (Appearance / **Columns & sorting** / Providers / View & tips), so
**Column order, Sort priority AND Providers now share one collapsed `ReorderList.jsx`
dropdown**, replacing the earlier `DraggablePills` drag lists.

View toggles: the completed-games toggle, a **One of each** toggle
(`oddspro.show.oneEach`; pure `applyOneOfEach(rows, orderedProviders)` in `filterValues.js`
collapses to one row per canonical fixture, kept from the highest-priority ENABLED provider
present - games only a lower-priority provider carries still show, so enabled providers
complement each other; loaded rows are already limited to the enabled providers), and four
settled-tips toggles - Hide hits / Hide miss / No miss / Safe only (client-side, default
off). `applyOutcomeToggles` in `filterValues.js` runs after `applyClientFilters`: each Hide
drops that settled class (unsettled rows always show; both Hides together leave only
upcoming/ongoing rows); No miss keeps only rows whose tip market never missed that day - a
single miss blacklists the whole market for the day, and tipless rows drop. **Safe only**
(`oddspro.show.safeOnly`) keeps only fixtures in the day-level `safeSelection` set - computed
over the WHOLE loaded selection so other toggles/filters can never change who wins the
per-day cap, filtered by `api_id` membership so all provider rows of a qualifying fixture
survive; the Slips playground inherits the same pool.

A warning strip (`ViewPills.jsx`, "Showing a subset:") renders a removable pill for every
ACTIVE row-hiding option - Upcoming only (completed off), Hide hits / Hide miss / No miss,
Safe only, One of each, and an "N filters" chip - each `x` turns that option off (the filters
chip opens the builder, or clears all). It renders nothing when the view is unmodified; it
exists because the "all tips are hits" surprise was traced to Hide-miss being silently on.

## Betslip playground

Header `Slips` button opens `BetslipPlayground.jsx`: every tipped fixture
(`tip_market != null` - the pool does NOT filter on `tip_ai_verdict`, the same
honesty-over-discrimination stance `magicSortRows` takes) ranked in the table's current order
(falling back to blend confidence when no order is set), draggable (or `+`-able) into virtual
slip cards. Limits: stake / max-legs / **target-odds** / **max-slips** (target-odds
autogeneration via the pure `buildSlips` closes each slip at or above the target, bounded by
max-legs and max-slips; `+ New slip` prefills the next unused tips; an **Auto/Manual** toggle,
default manual, rebuilds the book on any limit/pool change, debounced 200ms with a 500ms
cap). Each slip shows combined odds / payout / calibrated survival (the product of
`estimateLegProb` across legs) / EV. The modal closes via `x` or Escape (not the backdrop)
and sits above the sticky headers (`z-40`).

Slips persist in `oddspro.betslips` and **survive date changes**, so one multi-bet slip can
accumulate tips from several days - legs are self-contained (each carries its own
fixture/market/price/prob/outcome), so a slip renders and settles regardless of the loaded
date; only the user empties the book (the Clear-slips button, or removing legs one by one).
Legs whose origin `date` differs from the loaded date show a small date tag; the greyed
"gone" marker is reserved for tips that dropped off *today's* view specifically.

**Touch (Phase 28):** the betslip uses tap-to-assign (a prominent left `+`, an active-slip
"ADDING HERE" badge; native drag is kept for desktop) and its running totals are a **sticky
footer**; its Tips and Slips panes are **individually collapsible on small screens** (a
header toggle plus a `bodyCls` that hides the body below `md` only, so one pane can give the
other room when stacked - desktop side-by-side is unaffected).

The betting protocol behind the Safe-only toggle (stakes, slip sizes, variance expectations)
is documented in `docs/guides/safety-net-protocol.md`.

## Daily MultiBet, Safe pool and Sure bets surfaces

**Daily MultiBet (2026-08-06, engine-v2):** a Magic-sheet row opens `DailyMultibet.jsx`
(the `Sheet` idiom): today's server-built survival card (per-leg collapsible reasoning,
calibrated percentages, a provider-price toggle) sits over the reverse-chronological settled
timeline with streak chips and `backfilled` tags. Guests get teaser rows plus a sign-in nudge
(the `/api/daily-slip/timeline` premium seam).

**Sure bets (2026-07-17, signed-in only):** a Magic-sheet row (guests get a sign-in nudge)
toggles `oddspro.show.sureBets` - membership is cut by `api_id` over the whole loaded
selection exactly like Safe-only - with a ViewPills chip "Sure bets (N of 10)" including an
explicit zero-day warning pill, and a "Top-3 slip" action that seeds the top legs into the
betslip book (`seedSlip`, exported from `BetslipPlayground.jsx`, the one owner of the
`oddspro.betslips` format) and opens the playground.

The status bar (see "Freshness" below) shows the day-level `Safe: N` count, accent-tinted
while Safe only is active.

## Freshness, silent reload and the records cache

**Freshness + silent reload:** a 60s slow poll of `GET /api/refresh` (plus a 2s fast poll
while a job is running) compares `data_version`; when it has moved and the run's scope
covers the loaded date (the pure gate `shouldReloadForJob` in `web/src/freshness.js`,
offline-tested - a full sweep covers all dates, a light pass or manual refresh only their own
`dates`), the table reloads silently: no loading dim (`silentRef`), scroll preserved
(`DataTable`'s `scrollKey` prop - the same key restores scroll across data swaps, a changed
key resets to the top), sort and filters untouched. A manual refresh may resolve
`{fresh:true}` (the server's cache window) - shown as a transient sky notice plus a plain
reload; manual failures show the error banner, auto failures only log server-side.

**Refresh state lives entirely on the sync button** (Phase 23 moved it off the footer): idle
shows the last-refresh time in its tooltip; while running it disables, swaps its icon to a
spinner, and shows the live step in the tooltip.

**Instant date navigation (2026-08-21):** `web/src/recordsCache.js` (pure, offline-tested) is
a module-scope LRU (cap 8) of parsed `/api/records` bodies, keyed by `recordsCacheKey` on the
query identity MINUS `refreshTick` - that counter bumps on every background auto-refresh, so
including it in the key would mint a fresh cache slot every few minutes and nothing would
ever hit. A hit paints immediately and SKIPS the loading dim
(`if (!silentRef.current && !cached) setLoading(true)`), then revalidates in the background,
where the server's ETag usually answers 304; a failed revalidation of rows already on screen
is swallowed rather than replacing the table with an error banner (a guest 403
`auth_required` still evicts the slot and shows the sign-in panel). **Every hit revalidates,
past dates included, deliberately:** `revalidateOrientation` (`src/link.js`) can flip a
fixture's sides inside a rolling 30-day window and the settle pass re-polls 7 days back, so a
past date is NOT frozen and must never be served from cache untested. A second effect
prefetches both neighbouring days 400ms after paint, best-effort (failures are swallowed,
table state is untouched) and bounded by the same `MIN_DATE`/`MAX_DATE` the nav chevrons
enforce, so a guest can never trigger a future-date 403 by prefetching;
`MIN_DATE`/`MAX_DATE`/`PREV_DATE`/`NEXT_DATE` were moved up beside the records effect because
that effect's dependency array is evaluated during render and a later declaration would be a
temporal-dead-zone error.

**Persistent cache seed (2026-08-22):** the LRU additionally persists its newest few entries
to localStorage (`oddspro.recordsCache`, pure pack/unpack in `recordsCache.js`, budgeted at
roughly 2.5M characters across 3 entries - an oversized `'all'` body is skipped rather than
crowding out today's; DOM glue lives in `recordsPersist.js`, 1s-debounced best-effort writes,
every storage failure swallowed) and hydrates it at module scope, so a BRAND-NEW visit (fresh
tab, next day) paints instantly instead of showing the loading spinner - correctness is
unchanged because every cache hit still revalidates and the server's warm keeper
(`src/warm.js`) answers current data in milliseconds. Seeds older than 12h are dropped on
hydrate (loading fresh beats flashing a long-stale table), `PERSIST_FORMAT` gates
cross-deploy shape drift, and the key is DEVICE-LOCAL: excluded from prefs sync
(`prefs-rules.js`'s `DEVICE_EXACT`) and from `.oddspro` config snapshots
(`configSnapshot.js`'s `isTransient`), because multi-MB response bodies must never ride
either channel.

## Auth, session and the admin panel

**v1.1.0 web:** `web/src/auth/*` - `SessionProvider` + `AuthGate` render sign-in/sign-up/
verify/profile as OVERLAYS, so the app stays mounted and table state survives every auth
flow. SignUp/SignIn/VerifyPhone use `react-phone-number-input` (adding roughly 100 kB of
libphonenumber metadata to the bundle); `ProfileView` doubles as the forced first-login
PIN-change screen; `AvatarMenu.jsx` plus OverflowMenu session rows round out the UI. `api.js`
prefers the session bearer over `VITE_API_TOKEN`, and its `ApiError` carries status plus body
(`retry_after_seconds`/`attempts_left`).

The admin panel is a LAZY chunk (recharts is roughly 406 kB - the guest bundle is unaffected),
routed by `useAdminRoute.js`:

- **DashboardSection** (M5) - today tiles + traffic charts over the pre-binned
  `/api/admin/track/summary`, an engine KPI strip from the public `/api/performance` and
  `/api/magic-sort`, and M14's MaintenanceCard; it only lays out numbers, every rate shows its
  `n`, ROI is flat-stake, and it makes no EV claims.
- **SettingsEditor** - batch save, all-or-nothing, with live/restart badges.
- **UsersSection** (M8).
- **MessagingSection** (M9 templates + campaigns).
- **DatabaseSection** - overview/health over `/api/admin/db/*`; the export/import transfer
  wizard was removed 2026-08-07 along with the rest of the transfer machinery.
- **TokensSection** (engine-v2 PATs).

PerformanceSection and DataLab were removed in the 2026-08-07 core-focus trim.

Guest UX: a MAX_DATE clamp applied only once session status is `'ready'` (so a stored
sign-in never flashes a clamped calendar), a next-chevron "Sign in to see upcoming games"
tooltip, and a sign-in panel on a records 403. Before the 2026-08-19 feature registry,
`useShowDetails()` resolved to `SHOW_DETAILS && signed-in` (guests behaved like a
details-off build); it is now `useFeature('tip_reasoning')`, so a guest with `GUEST_PREMIUM`
on sees the same reasoning a signed-in user does. `web/src/details.js` gates the TipPopover
internals and the magic-sort methodology prose/backtest numbers; since the 2026-08-19
registry these are two SEPARATE registry features - `tip_reasoning` via `useShowDetails()`
and `methodology` via `useShowMethodology()` - resolved from `session.features`
(`featureMap`, `src/db/feature-rules.js`) rather than from a build flag, so either can be
re-gated live. `VITE_SHOW_DETAILS` survives only as a build-time hard override, commented out
in `.env.production`, since the premium gate now lives in the feature registry.

## Settings, prefs sync and config snapshots

Column selections (markets + STATS) and the link toggles persist in localStorage (keys
sanitized against the catalog); the settings modal renders whatever `/api/columns` returns,
so new stat types appear with no frontend change.

All numeric inputs use `NumberInput.jsx` (`type=text` + `inputMode=decimal`; blank, `.`,
`20.` and `.05` are all valid mid-edit, bad keystrokes are silently ignored, and a blank
commits as 0 or the field's min - avoiding the `type=number` clamp-on-keystroke race).
ArrowUp/ArrowDown step the value via the pure `stepNumber` (offline-tested; default step 1
for `int` fields, 0.1 otherwise, with per-field overrides such as stake `1` or Safe
min-agreement `0.05`; it snaps to the step's own precision so repeated presses don't drift,
then clamps like `clampNumber`).

**Safe-only limits are user-configurable** (`oddspro.safe.overrides`, merged over the
server policy into `safeSelection`'s options - no server change needed).

`prefsSync.js` pulls on login/verify/hydrate, pushes on logout plus a 2-minute interval plus
a manual "Sync settings" row plus a throttled (30s) tab-focus `syncNow` (the 2026-07-17
filters+slips sync spec: push-if-dirty runs FIRST, so a focus event can never clobber fresh
local edits); the sync cursor is user-tagged and excluded from config snapshots both ways.

**Config export/import** (`web/src/configSnapshot.js`): Settings-footer buttons write/read a
gzip `.oddspro` snapshot (a versioned envelope covering all `oddspro.*` keys except transient
per-date selections) for moving configuration between dev and prod.

Status bar: a translucent status bar (a flex child of the `100dvh` app shell, `text-xs`,
items wrap on narrow widths) shows record count, day hit-rates, and the day-level Safe count;
it gained a **daily-unique-visitor badge** in v1.0.2 (polled every 2 minutes). Last-refresh
and running-refresh progress moved to the nav's sync-button tooltip in Phase 23, out of the
footer.

## Touch, layout and accessibility

The iPadOS nav bar is 3-zone: theme-adaptive `[OP]` logo (links home to today) in the center
of a date nav, flanked by action icons. Prev/next chevrons flank a `D/M/YYYY` button that
opens `CalendarPopover.jsx` (a custom month grid with Clear/Today, bounded min `2026-07-05`
and max +7 days, noon-anchored date math) - this **replaced** the native
`<input type="date">`. The right-zone SVG action icons (refresh, magic, slips, filters, help,
settings) collapse into a single right-justified **overflow menu** (`OverflowMenu.jsx`) below
the `sm` breakpoint (mobile portrait); the date nav always stays inline. The nav bar is its
own distinct translucent surface (own background, hairline, shadow, blur) so it reads as a
separate bar from the page. The table scrolls horizontally on narrow screens.

**Phase 28** touch pass: >=44px tap targets across nav/calendar/overflow/selectors, and the
nav date reads **"Thu, Jul 9"**. **Modals anchor to the top-right toolbar** (not centered;
`Sheet.jsx` and the betslip drop-in sit below the nav with pinned footers) with a lighter
scrim (`bg-black/15` + `blur(0.5px)`) so the background stays legible.

## Device-local keys (never synced)

Some localStorage keys are deliberately excluded from BOTH prefs sync (`prefs-rules.js`'s
`DEVICE_EXACT`) and `.oddspro` config snapshots (`configSnapshot.js`'s `isTransient`),
because syncing or exporting them would either conflate per-device identity across a shared
account or ship a multi-MB payload through a channel meant for small config blobs:

| Key | Why it stays device-local |
|---|---|
| `oddspro.session` | Session token - device-specific by nature. |
| `oddspro.human` | Device-local ephemeral state. |
| Per-date selections | Transient view state, not durable configuration. |
| The prefs sync cursor itself | Syncing the cursor would corrupt the LWW clock it tracks. |
| `oddspro.visitor` (anon id) | Two devices of one account sharing a `visitors.anon_id` would conflate the unique/repeat visitor metrics. |
| `oddspro.maintenance` cache | Device-local maintenance-banner dismissal state. |
| `oddspro.recordsCache` | Multi-MB response bodies must never ride prefs sync or a config snapshot. |

Betslips (`oddspro.betslips`) are the deliberate exception: they are already cross-device by
construction, since each leg is self-contained (fixture/market/price/prob/outcome), so they
need no special sync handling and round-trip through the same `.oddspro` export/import path
as everything else - verified end to end.

---
*Update this chapter when: the app shell, theme tokens, table/sort/filter behavior, the
betslip playground, the Daily MultiBet / Safe pool / Sure bets surfaces, the freshness/reload
gate, the records cache, the admin panel's sections, or any `oddspro.*` localStorage/prefs-sync
contract changes (`web/src/index.css`, `web/src/ordering.js`, `web/src/freshness.js`,
`web/src/recordsCache.js`, `web/src/recordsPersist.js`, `web/src/configSnapshot.js`,
`web/src/theme.js`, `web/src/columns.js`, `web/src/baseColumns.js`, `web/src/details.js`,
`web/src/filterValues.js`, `web/src/components/BetslipPlayground.jsx`,
`web/src/components/DailyMultibet.jsx`, `web/src/components/MagicMenu.jsx`,
`web/src/components/FilterBuilder.jsx`, `web/src/components/ReorderList.jsx`,
`web/src/components/MultiSelect.jsx`, `web/src/auth/*`, `src/db/feature-rules.js`).*
