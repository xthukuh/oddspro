# iOS Tablet UI Redesign — Design Spec

**Date:** 2026-07-09
**Scope:** `web/` React frontend only (presentation layer). No backend, API, DB, or shared-logic changes.
**Status:** Design — awaiting approval before implementation planning.

---

## 1. Goal

Redesign the oddspro dashboard so it **looks and feels like a native iPadOS app** — a full reskin *and* touch-first ergonomics — while preserving every existing feature and preference. The visual language is taken verbatim from the user's own validated Claude Design prototype **"Odds Pro Tablet v3"** (project `719b928e-470e-4aab-af7d-0c2759f36d5e`).

## 2. Hard constraints

1. **No functional regression.** The redesign is presentation-only. Every current feature, toggle, and persisted preference must keep working identically (see the inventory in §9). "Keep recent functionality and preferences intact — do not regress our progress."
2. **iPad-first, responsive, desktop must still work.** This is live at oddspro.ke and used on desktop. The layout is optimized for iPad (portrait 820×1180 + landscape) but degrades gracefully to a roomy desktop and to phones.
3. **Light + dark**, following the device's `prefers-color-scheme`, with a `data-theme` override hook. One token system, not two skins.
4. **Shared pure modules untouched** (`src/db/magic-rules.js`, `web/src/ordering.js`, `filterValues.js`, `sortValues.js`, `freshness.js`, `numberInput.js`). The offline `node:test` suite must stay green — the redesign never edits logic those tests cover.
5. **Follow repo conventions:** ES modules, 4-space indent, single quotes, semicolons; Tailwind 4; "uncomplicated (simple but functional)" design philosophy; targeted/minimal changes.
6. **Aesthetics-only — current behavior always wins.** Change look, not behavior. Wherever the prototype's structure differs from the current app's interactions, the **current app wins**. Confirmed example: the prototype left-fixes ID/Start/Fixture, but the app keeps its **Score/Tip** left-pinned columns + hysteresis untouched (user-confirmed 2026-07-09). When any restyle risks altering behavior, **ask rather than assume**.

## 3. Decisions log (from brainstorming)

| Question | Decision |
|---|---|
| Where does the work happen? | In-repo (`web/`) — **not** a Claude Design sync. |
| What is "iOS tablet"? | **Look AND feel** like an iPad app (reskin + touch ergonomics). |
| Device target / desktop? | **iPad-first, desktop must still work** (responsive). |
| Data presentation? | **iOS-restyled comparison table + tap-row detail** (realized as the Tip popover). |
| Color scheme? | **Light + dark**, follows iPad system setting. |
| Palette identity? | **Odds Pro sky-blue, iOS-refined** → `#007AFF` systemBlue accent; semantic green=hit/win, red=miss preserved. |
| Build approach? | **① Semantic token layer + in-place restyle + additive surfaces** (not a component-library rewrite). |
| Footer content? | records · 🔥O2.5 · Tips · 🛡Safe, iOS status-bar styled; **whole items wrap to multiple rows** on narrow widths. Refresh state + last-refresh time **move to the toolbar sync button** (on-demand tooltip) — removed from the footer to keep it clean (revised 2026-07-09). |
| Row density? | **Fixed compact, touch-tuned** (no density toggle). |

## 4. Approach

**① Semantic design-token layer, in-place restyle, additive drill-down surfaces.**

- Define iOS tokens **once** in `web/src/index.css` via Tailwind 4 `@theme` + CSS custom properties. A `@media (prefers-color-scheme: dark)` block plus `:root[data-theme=dark]` / `:root[data-theme=light]` overrides flip every value, so the dense table needs **no scattered `dark:` variants**.
- Restyle each existing component to consume tokens + iOS patterns. Keep all React state, effects, data flow, and props exactly as they are.
- Add two new presentational pieces: the **custom calendar popover** (replaces the native `<input type=date>` overlay) and the **iOS sheet shell** (wraps Settings/Filters/Slips/Help). The Tip drill-down reuses the existing `TipPopover`, restyled.

Rejected: ② full component-library refactor (over-engineering, high regression risk on a live app), ③ raw `dark:`-utility restyle (churn-heavy across the 585-line table).

## 5. Design tokens

Authoritative **light** values are from the v3 prototype; **dark** values are the standard iOS dark system colors.

| Token (CSS var) | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#F2F2F7` | `#000000` | app background |
| `--bg-elevated` | `#FFFFFF` | `#1C1C1E` | grouped bg under cards |
| `--surface` | `#FFFFFF` | `#1C1C1E` | card / table / sheet |
| `--surface-2` | `#F2F2F7` | `#2C2C2E` | nested / row-hover |
| `--chrome` | `rgba(249,249,250,.92)` | `rgba(30,30,32,.86)` | translucent footer |
| `--nav-bg` | `#FFFFFF` | `#1C1C1E` | distinct toolbar surface |
| `--logo` | `#5856dc` | `#FFFFFF` | theme-adaptive brand mark |
| `--label` | `#000000` | `#FFFFFF` | primary text |
| `--label-2` | `rgba(60,60,67,.6)` | `rgba(235,235,245,.6)` | secondary text |
| `--label-3` | `rgba(60,60,67,.3)` | `rgba(235,235,245,.3)` | tertiary / placeholder |
| `--separator` | `rgba(60,60,67,.29)` | `rgba(84,84,88,.6)` | divider |
| `--separator-2` | `rgba(60,60,67,.14)` | `rgba(84,84,88,.34)` | hairline |
| `--fill` | `rgba(120,120,128,.12)` | `rgba(120,120,128,.24)` | input / chip fill |
| `--fill-hover` | `rgba(120,120,128,.2)` | `rgba(120,120,128,.36)` | pressed |
| `--accent` | `#007AFF` | `#0A84FF` | systemBlue — links, primary |
| `--accent-soft` | `rgba(0,122,255,.1)` | `rgba(10,132,255,.24)` | accent tint bg |
| `--green` (hit/tips) | `#34C759` | `#30D158` | win / hit |
| `--orange` (hot O2.5) | `#FF9500` | `#FF9F0A` | over-2.5 flame |
| `--red` (miss) | `#FF3B30` | `#FF453A` | systemRed — miss / loss |
| `--pink` / `--purple` | `#FF2D55` / `#5856D6` | `#FF375F` / `#5E5CE6` | accent alt |

Other constants: font `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Helvetica Neue", Inter Variable, sans-serif` (SF on iPad, Inter fallback elsewhere — Inter stays self-hosted); base 15px / line-height 1.3 / letter-spacing −0.01em; radii 10 (controls), 12–14 (cards/panels/sheets), 20 (pills), 50% (close buttons); chrome blur `blur(25px) saturate(180%)`; hairline borders `0.5px`.

## 6. App shell (`App.jsx`)

Convert the current document-scroll page into a **fixed full-height flex column** (`height:100vh; overflow:hidden`) so only the table scrolls — the iOS app-shell pattern:

```
┌ NAV BAR (translucent, blur, 0.5px bottom border) ────────────────┐
│  Odds Pro        ‹  [ Fri, 9 Jul ▾ ]  ›        ↻ ✨ ▤ ☰ | ? ⚙  │  grid 1fr auto 1fr
├───────────────────────────────────────────────────────────────────┤
│  Sorted by  [1 Tip ▼] [×]   Clear all            (only if sorts)   │
│  ┌ TABLE CARD (surface, radius 14, the only scroll region) ─────┐ │
│  │  sticky header · rows · sticky-left ID/Start/Fixture         │ │
│  └──────────────────────────────────────────────────────────────┘ │
├ STATUS FOOTER (translucent, blur, 0.5px top border) ──────────────┤
│  N records · 🔥 O2.5 x/y · Tips x/y · 🛡 Safe n · ⟳ HH:MM         │
└───────────────────────────────────────────────────────────────────┘
```

Error/notice banners keep their current placement (between nav and main) restyled to iOS (rounded, tinted, `role=alert`/`status`, auto-dismiss preserved).

## 7. Surface-by-surface redesign

**Nav bar** — 3-zone `grid-template-columns:1fr auto 1fr`. **Distinct background** so the toolbar reads as its own bar, clearly separated from the content/table view below — a dedicated nav surface (`--nav-bg`: light `#FFFFFF`, dark `#1C1C1E`) with the `0.5px` bottom separator **and a subtle drop shadow**, plus the blur for depth (not the near-transparent chrome tint that blends into the background).
- *Left:* the **theme-adaptive `[OP]` logo** (no "Odds Pro" text) — the brand mark rendered in **purple `#5856dc` on light / white on dark** (inline SVG filled via a `--logo` CSS var, so it flips with both `prefers-color-scheme` and the `data-theme` override). It is a **home link that resets to today** (`changeDate(TODAY)`, SPA nav — mirrors the current logo's home behavior). Source variants live in `web/icon-svgs/` (transparent-bg color/white fronts).
- *Center:* `‹  [date ▾]  ›`. Prev/next are SVG chevrons; the date button (17px/600 + chevron) toggles the calendar popover. Preserve existing bounds (min `2026-07-02`, max +7d), URL round-trip (`?date=`), `popstate`, and the cleared "All dates" state.
- *Right:* SVG icon buttons (40px targets, `--accent-soft` hover) in order **refresh · magic · slips · filters**, a `0.5px` divider, then **help · settings**. Magic + filters show an active tint + count when engaged (parity with today's sky-highlight + count badge). The **refresh/sync button owns all refresh state**: idle → sync icon (enabled), its tooltip shows the last-refresh time; running → **disabled + a swapped activity-indicator icon** (not the same icon spinning), its tooltip shows the live step/progress. This is the only place refresh progress appears (the footer no longer carries it).
- *Responsive overflow:* below a breakpoint (cramped / mobile-portrait, `< sm`), the right-zone actions (**all of them except the centre date nav**) collapse into a single right-justified **⋯ overflow menu** rather than wrapping — the date nav always stays inline. The menu is a simple icon+label list; each row fires the same handler (opens the matching sheet / toggles filters / refreshes). Above the breakpoint the full icon row shows.

**Calendar popover** — custom month grid anchored under the date button (weekday row, day buttons with today/selected/out-of-range styling, `Clear` + `Today` footer). Replaces the transparent native-input overlay. All date logic stays in `App.jsx`; this is a presentational control writing back the same `changeDate`.

**Magic sheet** — opens as a **modal dialog (iOS sheet)**, not an anchored popover (keeps the toolbar + overflow menu clean): explanatory line, strategy list (name + slip-survival/top-picks/streak/ROI stats + small-sample warnings), multi-select toggle, "Clear magic sorts", footer sample-size line. Feature parity with `MagicMenu.jsx` — only the container changes to a sheet.

**Sort pills** (`SortPills.jsx`) — "Sorted by" + pills (priority # · label · ▲/▼ · ×) + "Clear all", restyled to iOS chips. Unified column+magic chain behavior unchanged.

**Table** (`DataTable.jsx`) — rendered inside the surface card:
- Sticky header row; sticky-left pinned columns preserved (prototype pins ID/Start/Fixture; current app pins Score/Tip via hysteresis — **keep the current pin set + hysteresis logic**, only restyle).
- iOS row tints per `api_id` (alternating `--surface` / `--surface-2`), hairline `--separator-2` row borders, `--accent` fixture links.
- 🔥 flame, provider badges, tip cell (confidence %, ✓/✗ outcome, veto strikethrough, missed=red), market cells (fresh / greyed stale / frozen), stat cells, magic column, derived-value inline prefixes, and sort hints — all preserved, recolored to semantic tokens.
- Tap a fixture (or the tip cell) opens the **Tip popover**. Scroll preservation (`scrollKey`) unchanged.

**Tip popover** (`TipPopover.jsx`) — restyled to the prototype card and used as the touch drill-down: fixture title + × close, blue headline (market @ price), **Confidence blend** rows (signal label + sub + colored value), evidence line, **Runners-up**, and the **Over-2.5 gate audit** (✓ checks) when hot. Keep the existing content: plain-language signal glossary (`SIGNAL_LABEL`), AI verdict rendering (probability, per-check findings, grounding links), skip-reason "no data" markers, and the 🛡 Safe-pick badge.

**Sheets** — a shared iOS sheet shell: centered card over `rgba(0,0,0,.28)` + backdrop blur, `op-sheet-in`/`op-fade` animation, × close, **Escape + backdrop-click to dismiss** (matches current modal dismiss rules), `z-40` above sticky chrome. Wraps:
- *Settings* — Table columns (collapsible Odds-markets / Stats chip panels via `MultiSelect` semantics), draggable Column-order chips (⠿), Providers (visible / unavailable-links panels), Behavior (Show completed), Settled tips (Hide hits / Hide miss / No miss / 🛡 Safe only), Sort priority reorder. Full parity with `SettingsModal.jsx`. Blue **Done** button.
- *Filters* — restyle the **existing `FilterBuilder` into the iOS sheet chrome only**. Keep its current controls, options, layout logic, and behavior verbatim (WHERE/AND rows, the full op set `= ≠ > ≥ ≤` / contains / not-contains / in / not-in, field grouping, CSV-list handling, server/client split, "+ Add condition", Clear / **Apply**). **No filter behavior/enhancement changes this session** — filter enhancements are explicitly deferred to a future session (user-confirmed 2026-07-09).
- *Slips* — Betslip playground: config row (Stake / Max legs / Target odds / Max slips + Auto/Manual + Clear / + New slip / ✨ Fill-from-top), two-pane Tips-pool | Slips grid, per-slip odds/payout/survival/EV, totals, empty state. Full parity with `BetslipPlayground.jsx`; persists per date.
- *Help* — restyled `HelpModal.jsx` (intro, icon legend, demo-video placeholder, credit).

**Touch tooltips** (`Tooltip.jsx`) — extend the existing touch-friendly tooltip so header definitions and cell-info that currently rely on native `title=` become **tap-triggered popovers** on touch (hover still works with a pointer). This closes the "no hover on iPad" gap for column meanings and cell context.

**Footer** — translucent status bar, iOS-styled: `N records · 🔥 O2.5 x/y · Tips x/y · 🛡 Safe n` (Safe count sky-tinted while Safe-only is on). **Whole items wrap to additional rows** on narrow widths (each item `whitespace-nowrap`, container `flex-wrap` — no mid-item breaks). The **refresh/last-refresh item is removed** — that state now lives on the toolbar sync button (above). Tooltips retained via `Tooltip`.

## 8. SVG icon set (captured from v3 so it survives the temp prototype)

Line icons, `stroke="currentColor"`, `fill="none"` unless noted; sized ~21px in 40px buttons.

- **prev** `viewBox 0 0 10 17` · `M8.5 1.5L2 8.5L8.5 15.5` (sw 2.2, round)
- **next** `M1.5 1.5L8 8.5L1.5 15.5`
- **date chevron** `viewBox 0 0 12 8` · `M1 1.5L6 6.5L11 1.5` (sw 2)
- **refresh** `viewBox 0 0 20 20` · `M16.5 5.5A7 7 0 1 0 17.4 12` + `M16.8 2.5V6H13.3` (sw 1.7)
- **magic (sparkle)** `M10 1.5l1.7 4.6 4.8 1.7-4.8 1.7L10 14l-1.7-4.5L3.5 7.8l4.8-1.7L10 1.5z` + small `M16 12.5l.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7.7-1.9z` (`fill=currentColor`)
- **slips** `rect x4 y2 w12 h16 rx2.5` + `M7 6.5h6M7 10h6M7 13.5h3.5` (sw 1.6)
- **filters** `M3 5.5h14M5.5 10h9M8 14.5h4` (sw 1.8)
- **help** `circle 10,10 r8` + `M7.7 7.5a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.7-.9 1.4v.4` + `circle 10,14.3 r0.9 fill` (sw 1.6)
- **settings (gear)** `circle 10,10 r2.6` + `M10 1.8v2.1M10 16.1v2.1M18.2 10h-2.1M3.9 10H1.8M15.8 4.2l-1.5 1.5M5.7 14.3l-1.5 1.5M15.8 15.8l-1.5-1.5M5.7 5.7L4.2 4.2` (sw 1.6)

## 9. No-regression feature inventory (must all survive)

Date nav (today/prev/next, bounds, `?date=` URL sync, popstate, All-dates) · Manual refresh (spinner, disabled states, `{fresh:true}` notice, error banner) · Freshness polling (60s slow, 2s fast while running, silent scroll-preserving reload, `data_version` gate) · Unified sort chain (additive header click, shift-click isolate, pills, priority indicators, magic + column interleave) · Magic menu (multi-strategy, clear, legend, small-sample warnings) · Slips playground (all limits, Auto/Manual, fill-from-top, EV/survival, per-date persistence) · Filter builder (all ops, server/client split, WHERE/AND) · Settings (markets/stats multiselect, column-order drag, visible/link providers, show-completed, hide-hits/miss, no-miss, safe-only, sort-priority reorder) · Table (sticky header, left-pinned columns + hysteresis, per-`api_id` tints, provider badges, tip cell states, fresh/stale/frozen market cells, stat cells, magic column, derived prefixes, sort hints, `scrollKey` scroll preservation) · Tip popover (blend, glossary, runners-up, gate audit, AI verdict, skip reasons, Safe badge) · Footer (records, O2.5/Tips hit rates, Safe count; wraps by whole item on narrow; **last-refresh + running state relocated to the toolbar sync button** — on-demand via its tooltip, not lost) · Outcome toggles (hide hits/miss, no-miss, safe-only) · Providers filter · Completed toggle · **All localStorage keys and their semantics unchanged.**

## 10. Responsive behavior

- **Portrait iPad:** app shell fills the viewport; table card scrolls horizontally (sticky-left columns keep identity + tip in view); sheets are near-full-width with margins.
- **Landscape iPad / desktop:** more columns visible without scroll; sheets cap at a max width and center; nav spacing relaxes. Slips sheet keeps its two-pane grid.
- **Phone (graceful):** nav zones wrap; footer scrolls horizontally; sheets go near-fullscreen. Not a primary target but must not break.
- Touch targets ≥ ~40px; `-webkit-tap-highlight-color:transparent`; `viewport-fit=cover` for safe areas.

## 11. Testing & verification

- No automated frontend tests exist (the `node:test` suite is backend/pure-logic, offline). The redesign must not change any module those tests cover — verify with `npm test` staying green.
- Build with `npm run build:web`; drive the app in a browser (Chrome DevTools device emulation) at **iPad portrait 820×1180**, **iPad landscape 1180×820**, and a **desktop width**, in **both light and dark**, exercising: date nav + calendar, refresh, magic, filters, slips, settings (every panel), table sort/scroll/pins, tip popover, and every no-regression item in §9.
- Incremental rollout order: (1) token layer, (2) app shell + nav + footer, (3) sheet shell + Settings/Filters/Help/Slips, (4) calendar + magic popovers, (5) table + tip popover + touch tooltips. Each stage builds and renders before the next.

## 12. Out of scope / non-goals

- No backend, API, DB, migration, or shared-logic changes.
- No new data or features (no accent-picker, no density toggle, no new columns).
- Not a Claude Design sync; the prototype is a visual reference only.
- SF Pro is **not** bundled (Apple licensing) — the system font stack renders it natively on iPad; Inter Variable remains the cross-platform fallback.

## 13. Risks & mitigations

- **App-shell height math** (fixed `100vh` column) vs. the current `max-h-[calc(...)]` table — mitigate by moving the scroll boundary to the table card and testing on-device viewport units (`dvh` where needed for iOS Safari toolbars).
- **Sticky-left columns** interacting with the new card border-radius/overflow — verify pins still track during horizontal scroll.
- **Backdrop-blur performance** on large tables — blur only the fixed nav/footer chrome, never the scrolling region.
- **Dark-mode contrast** on odds/stat cells and stale/frozen greys — check greyed prices stay distinguishable from live ones in dark.
