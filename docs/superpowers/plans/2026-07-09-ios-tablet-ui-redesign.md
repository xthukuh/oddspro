# iOS Tablet UI Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `web/` React dashboard into a native iPadOS look-and-feel (light + dark) with touch-first ergonomics, changing appearance only — zero functional regression.

**Architecture:** A Tailwind 4 `@theme inline` + CSS-variable token layer (flips on `prefers-color-scheme` and a `data-theme` override) is defined once; every component is restyled in place to consume those tokens and iOS patterns. Modals become centered iOS **sheets**; the date picker becomes a custom **calendar popover**; the Tip popover becomes the touch drill-down. All React state, data flow, and shared pure modules are untouched.

**Tech Stack:** React 19, Vite 6, Tailwind CSS 4, self-hosted Inter Variable (+ Apple system font stack on-device). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-07-09-ios-tablet-ui-redesign-design.md` (read it first — full token table, no-regression inventory, icon set).

## Global Constraints

- **Aesthetics only — current behavior ALWAYS wins.** Change look, not behavior. Where the prototype differs from the app, the app wins. **Ask rather than assume** when a restyle risks behavior.
- **No logic changes.** Do not edit `src/db/magic-rules.js`, `web/src/ordering.js`, `filterValues.js`, `sortValues.js`, `freshness.js`, `numberInput.js` logic, or any backend. `npm test` must stay green after every task.
- **Keep the current left-pinned columns** (Score / Tip + hysteresis) — NOT the prototype's ID/Start/Fixture.
- **Filters: restyle chrome only** — keep every `FilterBuilder` control, option, and behavior. Filter enhancements are deferred to a future session.
- **Footer:** records · 🔥 O2.5 · Tips · 🛡 Safe — whole items wrap to more rows on narrow widths (no mid-item break). Refresh progress + last-refresh time live on the **toolbar sync button tooltip**, not the footer.
- **Fixed compact density** (no density toggle).
- **Themes:** light + dark, `prefers-color-scheme` with a `:root[data-theme]` override winning both ways.
- **Responsive:** iPad-first (portrait 820×1180 + landscape), desktop still works, phones don't break.
- **Conventions:** ES modules, 4-space indent, single quotes, semicolons. Persisted localStorage keys and their semantics unchanged.
- **Accent** `#007AFF` (dark `#0A84FF`); brand mark `[OP]` purple `#5856dc`; semantic green `#34C759` (hit/tips), orange `#FF9500` (hot O2.5), red `#FF3B30` (miss).

## Verification model (every task)

Because the frontend has no unit tests, each task's gate is:
1. `npm test` → all backend/pure-logic tests still pass (proves shared modules untouched).
2. `npm run build:web` → compiles with no errors.
3. **Browser drive** (`cd web && npm run dev`, or the built app via `npm run serve`): check the task's named items at **iPad portrait (~820px)**, **iPad landscape (~1180px)**, and **desktop (~1440px)**, in **both light and dark** (toggle OS appearance or set `document.documentElement.dataset.theme`). Use the `/run` or `/verify` skills to drive it.

The server needs the DB + `.env`; for pure visual checks the dev server renders the shell even if `/api` errors (the error banner is itself a thing to style). Prefer `npm run serve` against the real DB when validating data-bound surfaces (table, tips, sheets).

## File structure

**Create:**
- `web/src/theme.js` — tiny helper: resolve/persist the `data-theme` override (optional manual toggle) + a `Logo`-shared color hook. (Only if a manual toggle is wanted; default is OS-driven — see Task 3 note.)
- `web/src/components/icons.jsx` — the nav SVG icon set as small components.
- `web/src/components/Logo.jsx` — theme-adaptive `[OP]` inline-SVG mark, home→today link.
- `web/src/components/Sheet.jsx` — shared iOS sheet shell (backdrop blur, animation, Escape/backdrop dismiss, × close).
- `web/src/components/CalendarPopover.jsx` — custom month calendar popover.
- `web/src/components/OverflowMenu.jsx` — mobile-portrait ⋯ menu holding the toolbar actions.

**Modify (restyle in place):**
- `web/src/index.css` — token layer + font stack.
- `web/src/App.jsx` — app-shell layout, nav bar, footer, banners; wire Logo/Calendar/Sheet.
- `web/src/components/DataTable.jsx`, `TipPopover.jsx`, `SettingsModal.jsx`, `FilterBuilder.jsx`, `BetslipPlayground.jsx`, `HelpModal.jsx`, `MagicMenu.jsx`, `SortPills.jsx`, `MultiSelect.jsx`, `NumberInput.jsx`, `Tooltip.jsx`.

---

## Token cheat-sheet (all restyle tasks reference this)

Replace the current slate/sky Tailwind utilities with token utilities generated in Task 1. Mapping:

| Old (examples) | New token utility | CSS var |
|---|---|---|
| `bg-slate-100` / page bg | `bg-app` | `--bg` |
| `bg-white` surface/card/row | `bg-surface` | `--surface` |
| `bg-slate-50` / `bg-slate-100` alt row/header | `bg-surface-2` | `--surface-2` |
| `bg-slate-900` topbar | `bg-nav` | `--nav-bg` |
| `text-slate-800/700` | `text-label` | `--label` |
| `text-slate-500/600` | `text-label-2` | `--label-2` |
| `text-slate-300/400` (dashes/muted) | `text-label-3` | `--label-3` |
| `border-slate-200/300` | `border-separator` (or `border-hairline`) | `--separator` / `--separator-2` |
| `bg-sky-600` / `text-sky-700` accents | `bg-accent` / `text-accent` | `--accent` |
| `bg-sky-100 text-sky-800` (chips) | `bg-accent-soft text-accent` | `--accent-soft` |
| `text-emerald-600` (hit) | `text-hit` | `--green` |
| `text-rose-600` (miss) | `text-miss` | `--red` |
| 🔥 hot / amber | `text-hot` | `--orange` |
| input fill `bg-slate-100` | `bg-fill` | `--fill` |

Radii: controls `rounded-[10px]`, cards/sheets `rounded-2xl` (14px), pills `rounded-full`. Hairlines: `border` + `border-hairline` at `0.5px` (define a `.border-hairline{border-color:var(--separator-2)}` utility or use `border-separator`). Chrome blur: `backdrop-blur-xl` + a `saturate` filter via arbitrary `[backdrop-filter:blur(25px)_saturate(180%)]`.

---

## Task 1: Theme token layer (`index.css`)

**Files:**
- Modify: `web/src/index.css`

**Interfaces:**
- Produces: Tailwind token utilities `bg-app bg-surface bg-surface-2 bg-nav bg-fill bg-accent bg-accent-soft text-label text-label-2 text-label-3 text-accent text-hit text-miss text-hot border-separator` and CSS vars `--bg --surface --surface-2 --nav-bg --chrome --label --label-2 --label-3 --separator --separator-2 --fill --fill-hover --accent --accent-soft --green --orange --red --logo`, flipping by theme.

- [x] **Step 1: Replace `web/src/index.css` with the token layer**

```css
/* Inter Variable stays the cross-platform fallback; the Apple system stack
   renders SF natively on iPad/macOS. */
@import '@fontsource-variable/inter';
@import "tailwindcss";

/* Expose the runtime CSS vars as Tailwind tokens. `inline` makes utilities
   reference the var directly, so the :root overrides below flip live. */
@theme inline {
    --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
        'Inter Variable', ui-sans-serif, system-ui, sans-serif;
    --color-app: var(--bg);
    --color-surface: var(--surface);
    --color-surface-2: var(--surface-2);
    --color-nav: var(--nav-bg);
    --color-fill: var(--fill);
    --color-fill-hover: var(--fill-hover);
    --color-accent: var(--accent);
    --color-accent-soft: var(--accent-soft);
    --color-label: var(--label);
    --color-label-2: var(--label-2);
    --color-label-3: var(--label-3);
    --color-separator: var(--separator);
    --color-separator-2: var(--separator-2);
    --color-hit: var(--green);
    --color-miss: var(--red);
    --color-hot: var(--orange);
    --color-logo: var(--logo);
}

:root {
    color-scheme: light dark;
    --bg: #F2F2F7;
    --surface: #FFFFFF;
    --surface-2: #F2F2F7;
    --nav-bg: #FFFFFF;
    --chrome: rgba(249, 249, 250, 0.92);
    --label: #000000;
    --label-2: rgba(60, 60, 67, 0.6);
    --label-3: rgba(60, 60, 67, 0.3);
    --separator: rgba(60, 60, 67, 0.29);
    --separator-2: rgba(60, 60, 67, 0.14);
    --fill: rgba(120, 120, 128, 0.12);
    --fill-hover: rgba(120, 120, 128, 0.2);
    --accent: #007AFF;
    --accent-soft: rgba(0, 122, 255, 0.1);
    --green: #34C759;
    --orange: #FF9500;
    --red: #FF3B30;
    --logo: #5856dc;
}

@media (prefers-color-scheme: dark) {
    :root {
        --bg: #000000;
        --surface: #1C1C1E;
        --surface-2: #2C2C2E;
        --nav-bg: #1C1C1E;
        --chrome: rgba(30, 30, 32, 0.86);
        --label: #FFFFFF;
        --label-2: rgba(235, 235, 245, 0.6);
        --label-3: rgba(235, 235, 245, 0.3);
        --separator: rgba(84, 84, 88, 0.6);
        --separator-2: rgba(84, 84, 88, 0.34);
        --fill: rgba(120, 120, 128, 0.24);
        --fill-hover: rgba(120, 120, 128, 0.36);
        --accent: #0A84FF;
        --accent-soft: rgba(10, 132, 255, 0.24);
        --green: #30D158;
        --orange: #FF9F0A;
        --red: #FF453A;
        --logo: #FFFFFF;
    }
}

/* Explicit override wins over the OS setting in BOTH directions. */
:root[data-theme="light"] {
    --bg: #F2F2F7; --surface: #FFFFFF; --surface-2: #F2F2F7; --nav-bg: #FFFFFF;
    --chrome: rgba(249,249,250,0.92); --label: #000; --label-2: rgba(60,60,67,0.6);
    --label-3: rgba(60,60,67,0.3); --separator: rgba(60,60,67,0.29);
    --separator-2: rgba(60,60,67,0.14); --fill: rgba(120,120,128,0.12);
    --fill-hover: rgba(120,120,128,0.2); --accent: #007AFF;
    --accent-soft: rgba(0,122,255,0.1); --green: #34C759; --orange: #FF9500;
    --red: #FF3B30; --logo: #5856dc;
}
:root[data-theme="dark"] {
    --bg: #000; --surface: #1C1C1E; --surface-2: #2C2C2E; --nav-bg: #1C1C1E;
    --chrome: rgba(30,30,32,0.86); --label: #FFF; --label-2: rgba(235,235,245,0.6);
    --label-3: rgba(235,235,245,0.3); --separator: rgba(84,84,88,0.6);
    --separator-2: rgba(84,84,88,0.34); --fill: rgba(120,120,128,0.24);
    --fill-hover: rgba(120,120,128,0.36); --accent: #0A84FF;
    --accent-soft: rgba(10,132,255,0.24); --green: #30D158; --orange: #FF9F0A;
    --red: #FF453A; --logo: #FFFFFF;
}

body {
    background: var(--bg);
    color: var(--label);
    -webkit-font-smoothing: antialiased;
    letter-spacing: -0.01em;
}

.border-hairline { border-color: var(--separator-2); }

/* iOS sheet/popover animations (from the v3 prototype). */
@keyframes op-sheet-in { from { opacity: 0; transform: translateY(24px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes op-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes op-pop { from { opacity: 0; transform: translateY(-6px) scale(0.97); } to { opacity: 1; transform: none; } }
```

- [x] **Step 2: Verify build + tokens resolve**

Run: `npm test` → PASS (unchanged). Then `npm run build:web` → builds clean.
Then `cd web && npm run dev`, open the app, and in devtools confirm `getComputedStyle(document.body).backgroundColor` changes when you toggle OS dark mode, and that setting `document.documentElement.dataset.theme='dark'` flips it too. (The app still looks half-old — later tasks consume the tokens.)

- [x] **Step 3: Commit**

```bash
git add web/src/index.css
git commit -m "feat(web): iOS light/dark design-token layer (Tailwind 4 @theme + CSS vars)"
```

---

## Task 2: Nav SVG icon set (`icons.jsx`)

**Files:**
- Create: `web/src/components/icons.jsx`

**Interfaces:**
- Produces: named components `IconRefresh, IconMagic, IconSlips, IconFilter, IconHelp, IconGear, IconChevronLeft, IconChevronRight, IconChevronDown` — each `(props) => <svg .../>` accepting `className`/`style`, `stroke="currentColor"`, `fill="none"` (except the filled magic sparkle), sized to inherit (`width="21" height="21"` default, overridable).

- [x] **Step 1: Create the icon set** (paths copied verbatim from spec §8)

```jsx
// iOS line icons for the toolbar; currentColor so they inherit label/accent.
const S = { width: 21, height: 21, viewBox: '0 0 20 20', fill: 'none' };

export const IconRefresh = (p) => (
    <svg {...S} {...p}><path d="M16.5 5.5A7 7 0 1 0 17.4 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M16.8 2.5V6H13.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
export const IconMagic = (p) => (
    <svg {...S} {...p}><path d="M10 1.5l1.7 4.6 4.8 1.7-4.8 1.7L10 14l-1.7-4.5L3.5 7.8l4.8-1.7L10 1.5z" fill="currentColor"/><path d="M16 12.5l.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7.7-1.9z" fill="currentColor"/></svg>
);
export const IconSlips = (p) => (
    <svg {...S} {...p}><rect x="4" y="2" width="12" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6"/><path d="M7 6.5h6M7 10h6M7 13.5h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
);
export const IconFilter = (p) => (
    <svg {...S} {...p}><path d="M3 5.5h14M5.5 10h9M8 14.5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
);
export const IconHelp = (p) => (
    <svg {...S} {...p}><circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6"/><path d="M7.7 7.5a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.7-.9 1.4v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="10" cy="14.3" r="0.9" fill="currentColor"/></svg>
);
export const IconGear = (p) => (
    <svg {...S} {...p}><circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6"/><path d="M10 1.8v2.1M10 16.1v2.1M18.2 10h-2.1M3.9 10H1.8M15.8 4.2l-1.5 1.5M5.7 14.3l-1.5 1.5M15.8 15.8l-1.5-1.5M5.7 5.7L4.2 4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
);
// Activity indicator swapped in while refreshing (faint ring + bright arc, spun).
export const IconSpinner = (p) => (
    <svg {...S} {...p}><circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.8"/><path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
);
export const IconChevronLeft = (p) => (
    <svg width="10" height="17" viewBox="0 0 10 17" fill="none" {...p}><path d="M8.5 1.5L2 8.5L8.5 15.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
export const IconChevronRight = (p) => (
    <svg width="10" height="17" viewBox="0 0 10 17" fill="none" {...p}><path d="M1.5 1.5L8 8.5L1.5 15.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
export const IconChevronDown = (p) => (
    <svg width="11" height="7" viewBox="0 0 12 8" fill="none" {...p}><path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
```

- [x] **Step 2: Verify** — `npm run build:web` builds (icons are unused until Task 5, so just confirm no syntax error).

- [x] **Step 3: Commit**

```bash
git add web/src/components/icons.jsx
git commit -m "feat(web): iOS toolbar SVG icon set"
```

---

## Task 3: Theme-adaptive `[OP]` logo (`Logo.jsx`)

**Files:**
- Create: `web/src/components/Logo.jsx`

**Interfaces:**
- Produces: `default export Logo({ onHome })` — an inline-SVG `[OP]` mark filled with `var(--logo)` (purple light / white dark), wrapped in a home button that calls `onHome` (App passes `() => changeDate(TODAY)`).

- [x] **Step 1: Create the component**

```jsx
// Theme-adaptive brand mark: [OP] filled via --logo (purple on light, white
// on dark). Home button — resets the table to today (SPA nav, no reload).
export default function Logo({ onHome }) {
    return (
        <button
            onClick={onHome}
            title="Odds Pro — home (today)"
            aria-label="Odds Pro home"
            className="cursor-pointer inline-flex items-center h-10 px-1.5 rounded-[10px] hover:bg-accent-soft"
        >
            <svg width="52" height="28" viewBox="0 0 63.601238 34.068436" role="img" aria-label="Odds Pro" fill="var(--logo)">
                <text x="31.834799" y="19.334578" textAnchor="middle" dominantBaseline="central"
                      fontFamily="-apple-system, Arial, sans-serif" fontWeight="700" fontSize="28" letterSpacing="-1">OP</text>
                <g transform="translate(-0.11252066,-8.3910561)">
                    <text x="6.725812" y="24.865044" textAnchor="middle" dominantBaseline="central"
                          fontFamily="-apple-system, Arial, sans-serif" fontWeight="700" fontSize="30" letterSpacing="-1">[</text>
                    <text x="57.100468" y="24.865044" textAnchor="middle" dominantBaseline="central"
                          fontFamily="-apple-system, Arial, sans-serif" fontWeight="700" fontSize="30" letterSpacing="-1">]</text>
                </g>
            </svg>
        </button>
    );
}
```

Note: OS-driven theming needs no JS. A **manual** theme toggle is out of scope (not requested); the `data-theme` hook exists for future use.

- [x] **Step 2: Verify** — build clean; visual check deferred to Task 5 (wired into the nav there). Confirm in an isolated render (or after Task 5) the mark is purple in light, white in dark.

- [x] **Step 3: Commit**

```bash
git add web/src/components/Logo.jsx
git commit -m "feat(web): theme-adaptive [OP] logo (home->today link)"
```

---

## Task 4: Shared iOS sheet shell (`Sheet.jsx`)

**Files:**
- Create: `web/src/components/Sheet.jsx`

**Interfaces:**
- Produces: `default export Sheet({ onClose, children, className, labelledBy })` — centered card over a blurred backdrop; dismiss on **Escape** and **backdrop click** (not inner click); `z-40`; `op-sheet-in` animation. Consumers render their own header (title + × via `onClose`).

- [x] **Step 1: Create the shell**

```jsx
import { useEffect } from 'react';

// Centered iOS sheet: blurred scrim, spring-in card, Escape + backdrop-click
// dismiss (inner clicks are swallowed). Matches the current modals' dismiss
// rules (× / Escape / backdrop). Consumers own the header and content.
export default function Sheet({ onClose, children, className = '', labelledBy }) {
    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-8 [animation:op-fade_0.2s_ease] bg-black/28 [backdrop-filter:blur(2px)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
        >
            <div
                onClick={e => e.stopPropagation()}
                className={`bg-surface text-label rounded-2xl shadow-2xl max-h-[92vh] w-full max-w-3xl overflow-hidden [animation:op-sheet-in_0.24s_cubic-bezier(0.32,0.72,0,1)] ${className}`}
            >
                {children}
            </div>
        </div>
    );
}

// Reusable round × close button for sheet headers.
export function SheetClose({ onClose }) {
    return (
        <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full bg-fill text-label-2 text-lg leading-none hover:bg-fill-hover"
        >
            &times;
        </button>
    );
}
```

- [x] **Step 2: Verify** — build clean (used from Task 9 onward).

- [x] **Step 3: Commit**

```bash
git add web/src/components/Sheet.jsx
git commit -m "feat(web): shared iOS sheet shell (backdrop blur, Escape/backdrop dismiss)"
```

---

## Task 5: App shell — layout, nav bar, footer, banners (`App.jsx`)

**Files:**
- Modify: `web/src/App.jsx` (the `return (...)` JSX from line ~508; the header block, `<main>`, footer, banners)

**Interfaces:**
- Consumes: `Logo` (Task 3), `icons.jsx` (Task 2). Keeps all existing handlers (`onRefresh`, `changeDate`, `setShowSlips/Filters/Help/Settings`, `activeMagicIds`, `dayRates`, `safePicks`, etc.).
- Produces: the fixed app-shell layout the table and sheets sit in.

- [x] **Step 1: Convert the root to a fixed app-shell**

Replace the outer wrapper and header. Change the root `<div className="min-h-screen bg-slate-100 text-slate-800">` to:

```jsx
<div className="h-[100dvh] flex flex-col bg-app text-label overflow-hidden">
```

Replace the `<header className="bg-slate-900 ...">` opening with the distinct-background nav bar (3-zone grid, its own surface + hairline + shadow + blur):

```jsx
<header className="shrink-0 grid grid-cols-[1fr_auto_1fr] items-center gap-3 px-2.5 py-1.5 bg-nav/95 [backdrop-filter:blur(25px)_saturate(180%)] border-b border-separator shadow-sm relative z-40">
    {/* LEFT: theme-adaptive logo, home -> today */}
    <div className="flex items-center min-w-0 pl-1">
        <Logo onHome={() => changeDate(TODAY)} />
    </div>
    {/* CENTER: date nav — chevrons + calendar-popover trigger */}
    <div className="flex items-center gap-0.5 justify-self-center">
        {/* prev / [date ▾] / next — see Step 2 (CalendarPopover wired in Task 6) */}
    </div>
    {/* RIGHT: SVG action buttons + divider before help/settings */}
    <nav className="flex items-center gap-0.5 justify-self-end">
        {/* refresh · magic · slips · filters | help · settings — Step 3 */}
    </nav>
</header>
```

- [x] **Step 2: Date-nav center zone** (calendar popover is Task 6; wire the trigger + chevrons now)

```jsx
<button onClick={() => changeDate(PREV_DATE)} disabled={date <= MIN_DATE}
    title={`Previous (${PREV_DATE})`}
    className="cursor-pointer h-10 w-10 inline-flex items-center justify-center rounded-[10px] text-label hover:bg-accent-soft disabled:opacity-40">
    <IconChevronLeft />
</button>
<button onClick={() => setShowCal(v => !v)} title={date ? _fullDate(date) : 'All dates'}
    className="cursor-pointer h-10 min-w-[9.5rem] px-3 inline-flex items-center justify-center gap-1.5 rounded-[10px] text-[17px] font-semibold tabular-nums hover:bg-accent-soft">
    <span>{date ? _dmy(date) : 'All dates'}</span>
    <IconChevronDown className="text-accent" />
</button>
<button onClick={() => changeDate(NEXT_DATE)} disabled={date >= MAX_DATE}
    title={`Next (${NEXT_DATE})`}
    className="cursor-pointer h-10 w-10 inline-flex items-center justify-center rounded-[10px] text-label hover:bg-accent-soft disabled:opacity-40">
    <IconChevronRight />
</button>
```

Add state near the other `useState`s: `const [showCal, setShowCal] = useState(false);`. (The `⌂` today button is removed — the Logo is now home; keep `changeDate(TODAY)` reachable via Logo + the calendar's Today button.)

- [x] **Step 3: Right-zone actions — responsive (full row `≥sm`, ⋯ menu `<sm`)**

Add state near the others: `const [showMagic, setShowMagic] = useState(false);` and `const [showOverflow, setShowOverflow] = useState(false);`. Shared classes:

```jsx
const navBtn = 'cursor-pointer h-10 w-10 inline-flex items-center justify-center rounded-[10px] text-label hover:bg-accent-soft';
const navBtnActive = 'cursor-pointer h-10 w-10 inline-flex items-center justify-center rounded-[10px] text-accent bg-accent-soft';
```

Full icon row — shown only at `sm` and up (Magic is now a sheet trigger, not a popover):

```jsx
<div className="hidden sm:flex items-center gap-0.5">
    <button onClick={onRefresh} disabled={!date || refresh?.running}
        aria-label={refresh?.running ? 'Refreshing' : 'Refresh this date'}
        title={refresh?.running
            ? `Refreshing ${refresh.date}${refresh.step ? ` — ${refresh.step}` : ''}…`
            : date
                ? `Refresh fixtures, results & odds${refresh?.last_success ? ` — last ${_hm(refresh.last_success.at)}` : ''}`
                : 'Pick a date to refresh'}
        className={navBtn + (refresh?.running ? ' text-accent cursor-wait' : '')}>
        {refresh?.running
            ? <IconSpinner className="inline-block [animation:op-spin_0.8s_linear_infinite]" />
            : <IconRefresh />}
    </button>
    <button onClick={() => setShowMagic(true)} aria-label="Magic sort" title="Magic sort"
        className={activeMagicIds.length ? navBtnActive : navBtn}><IconMagic /></button>
    <button onClick={() => setShowSlips(true)} aria-label="Betslip playground" title="Betslip playground" className={navBtn}><IconSlips /></button>
    <button onClick={() => setShowFilters(true)} aria-label="Filters" title="Filter the table rows"
        className={(showFilters || filters.length) ? navBtnActive : navBtn}>
        <IconFilter />{filters.length ? <span className="text-[11px] tabular-nums ml-0.5">{filters.length}</span> : null}
    </button>
    <div className="w-px h-5 bg-separator mx-1.5" />
    <button onClick={() => setShowHelp(true)} aria-label="Help" title="Help" className={navBtn}><IconHelp /></button>
    <button onClick={() => setShowSettings(true)} aria-label="Display settings" title="Display settings" className={navBtn}><IconGear /></button>
</div>
```

Overflow ⋯ button — shown only below `sm` (holds every action except the date nav):

```jsx
<div className="relative sm:hidden">
    <button onClick={() => setShowOverflow(v => !v)} aria-label="More actions" title="More"
        className={showOverflow ? navBtnActive : navBtn}><span className="text-xl leading-none">⋯</span></button>
    {showOverflow && (
        <OverflowMenu
            refreshing={refresh?.running} canRefresh={!!date && !refresh?.running}
            filterCount={filters.length} magicActive={activeMagicIds.length > 0}
            onRefresh={() => { onRefresh(); setShowOverflow(false); }}
            onMagic={() => { setShowMagic(true); setShowOverflow(false); }}
            onSlips={() => { setShowSlips(true); setShowOverflow(false); }}
            onFilters={() => { setShowFilters(true); setShowOverflow(false); }}
            onHelp={() => { setShowHelp(true); setShowOverflow(false); }}
            onSettings={() => { setShowSettings(true); setShowOverflow(false); }}
            onClose={() => setShowOverflow(false)} />
    )}
</div>
```

Note: `setShowFilters(true)` — Filters now opens as a sheet (Task 9b), not the old inline toggle. Add imports: `import Logo from './components/Logo.jsx';`, `import OverflowMenu from './components/OverflowMenu.jsx';`, `import { IconRefresh, IconSpinner, IconMagic, IconSlips, IconFilter, IconHelp, IconGear, IconChevronLeft, IconChevronRight, IconChevronDown } from './components/icons.jsx';`. Add the `op-spin` keyframe to `index.css` (`@keyframes op-spin { to { transform: rotate(360deg); } }`). `MagicMenu` becomes the Magic **sheet** content (Task 7), opened by `showMagic` — render it near the other sheets in the JSX.

- [x] **Step 3b: Create the overflow menu** (`web/src/components/OverflowMenu.jsx`)

```jsx
import { IconRefresh, IconMagic, IconSlips, IconFilter, IconHelp, IconGear } from './icons.jsx';

// Right-justified mobile overflow: the toolbar actions as a simple tap list
// (date nav stays inline in the bar). Each row fires the same handler as its
// full-size button. Backdrop click closes.
export default function OverflowMenu({ refreshing, canRefresh, filterCount, magicActive,
    onRefresh, onMagic, onSlips, onFilters, onHelp, onSettings, onClose }) {
    const Row = ({ icon, label, onClick, disabled, active, trailing }) => (
        <button onClick={onClick} disabled={disabled}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-[15px] text-left hover:bg-fill disabled:opacity-40 ${active ? 'text-accent' : 'text-label'}`}>
            <span className="w-5 inline-flex justify-center">{icon}</span>
            <span className="flex-1">{label}</span>
            {trailing}
        </button>
    );
    return (
        <>
            <div onClick={onClose} className="fixed inset-0 z-50" />
            <div className="absolute right-0 top-[46px] w-56 bg-surface text-label rounded-2xl shadow-2xl border border-separator-2 py-1 z-[60] [animation:op-pop_0.16s_ease]">
                <Row icon={<IconRefresh className={refreshing ? '[animation:op-spin_1s_linear_infinite]' : ''} />} label={refreshing ? 'Refreshing…' : 'Refresh'} onClick={onRefresh} disabled={!canRefresh} />
                <Row icon={<IconMagic />} label="Magic sort" onClick={onMagic} active={magicActive} />
                <Row icon={<IconSlips />} label="Betslip playground" onClick={onSlips} />
                <Row icon={<IconFilter />} label="Filters" onClick={onFilters} active={filterCount > 0}
                    trailing={filterCount ? <span className="text-xs tabular-nums text-label-2">{filterCount}</span> : null} />
                <div className="h-px bg-separator-2 my-1" />
                <Row icon={<IconHelp />} label="Help" onClick={onHelp} />
                <Row icon={<IconGear />} label="Display settings" onClick={onSettings} />
            </div>
        </>
    );
}
```

- [x] **Step 4: `<main>` becomes the flex scroll parent; footer restyle**

Change `<main className="p-4 pb-10">` to `<main className="flex-1 min-h-0 flex flex-col px-3.5 pb-0">` (the table card scrolls internally — Task 11 sets its height to `flex-1`). Move `<SortPills>` inside main above the table.

Restyle the footer to the chrome bar, keeping **records · 🔥 O2.5 · Tips · 🛡 Safe** but **removing the `⟳` last-refresh/running item** (that state moves to the sync button, Step 3). Wrap by whole item on narrow widths — `flex-wrap` on the container, `whitespace-nowrap` on each item:

```jsx
<footer className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-4 py-2 bg-nav/95 [backdrop-filter:blur(25px)_saturate(180%)] border-t border-separator text-xs text-label-2 z-20">
  {/* Keep the same 4 Tooltip-wrapped spans (records, O2.5, Tips, Safe). Each
      span gets `whitespace-nowrap` so it wraps as a unit. Swap color classes
      per cheat-sheet: 🔥 O2.5 value -> text-hot, Tips -> text-hit, Safe (when
      Safe-only on) -> text-accent, dot separators -> text-label-3. DELETE the
      last `⟳` block entirely (the `refresh?.last_success`/running span). */}
</footer>
```

Restyle the error banner (`border-red-300 bg-red-50 text-red-700` → `border border-miss/40 bg-miss/10 text-miss rounded-2xl`) and the notice banner (sky → accent tokens). Keep `role`, dismiss buttons, auto-dismiss timers.

- [x] **Step 5: Verify (light + dark, 3 widths)**

`npm test` PASS · `npm run build:web` clean · drive the app:
- Nav bar is a distinct bar (own bg, hairline, shadow) separated from the table; logo is purple (light) / white (dark) and clicking it returns to today.
- Prev/next/date-trigger work; date label shows `D/M/YYYY`; bounds disable correctly; `?date=` URL still updates.
- Refresh spins; magic/filters show active tint + count; slips/help/settings open (still-old-styled until later tasks); magic opens as a sheet (Task 7).
- **Responsive overflow:** narrow to `< sm` (mobile portrait) — the action row collapses into the ⋯ menu (date nav stays inline); widen to `≥ sm` — the full icon row returns. Every ⋯ row fires the right handler.
- **Refresh button state:** idle → sync icon, tooltip shows last-refresh time; while running → **disabled**, icon **swapped to the spinner** (activity indicator), tooltip shows the live step. No refresh status in the footer.
- Footer shows the four items (records · O2.5 · Tips · Safe) with correct colors; at a narrow width whole items wrap to a second row (no mid-item break).
- No page scroll; only the table area scrolls. Check portrait, landscape, desktop.

- [x] **Step 6: Commit**

```bash
git add web/src/App.jsx web/src/index.css
git commit -m "feat(web): iOS app-shell layout, distinct nav bar, restyled footer/banners"
```

---

## Task 6: Custom calendar popover (`CalendarPopover.jsx`)

**Files:**
- Create: `web/src/components/CalendarPopover.jsx`
- Modify: `web/src/App.jsx` (render it under the date button when `showCal`)

**Interfaces:**
- Consumes: `{ date, min, max, onPick(iso|''), onClose }` from App (`date`, `MIN_DATE`, `MAX_DATE`, `changeDate`).
- Produces: a month-grid popover; `onPick('')` clears to All dates, `onPick(TODAY)` for Today.

- [x] **Step 1: Create the calendar** (month grid, weekday header, Clear/Today; disables out-of-range days; noon-anchored date math to dodge tz shift)

```jsx
import { useState } from 'react';
import { IconChevronLeft, IconChevronRight } from './icons.jsx';

const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

export default function CalendarPopover({ date, min, max, today, onPick, onClose }) {
    const anchor = date ? new Date(`${date}T12:00:00`) : new Date(`${today}T12:00:00`);
    const [view, setView] = useState({ y: anchor.getFullYear(), m: anchor.getMonth() });
    const first = new Date(view.y, view.m, 1);
    const start = new Date(view.y, view.m, 1 - first.getDay(), 12);
    const days = Array.from({ length: 42 }, (_, i) => new Date(view.y, view.m, 1 - first.getDay() + i, 12));
    const title = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const cell = d => {
        const s = iso(d);
        const inMonth = d.getMonth() === view.m;
        const disabled = s < min || s > max;
        const selected = s === date;
        return { s, n: d.getDate(), inMonth, disabled, selected };
    };
    return (
        <>
            <div onClick={onClose} className="fixed inset-0 z-50" />
            <div className="absolute top-[54px] left-1/2 -translate-x-1/2 w-[300px] bg-surface text-label rounded-2xl shadow-2xl border border-separator-2 p-4 z-[60] [animation:op-pop_0.16s_ease]">
                <div className="flex items-center justify-between mb-3">
                    <div className="text-base font-bold">{title}</div>
                    <div className="flex gap-0.5">
                        <button onClick={() => setView(v => ({ ...v, ...prevMonth(v) }))} className="w-8 h-8 rounded-lg text-accent inline-flex items-center justify-center hover:bg-accent-soft"><IconChevronLeft width="8" height="14" /></button>
                        <button onClick={() => setView(v => ({ ...v, ...nextMonth(v) }))} className="w-8 h-8 rounded-lg text-accent inline-flex items-center justify-center hover:bg-accent-soft"><IconChevronRight width="8" height="14" /></button>
                    </div>
                </div>
                <div className="grid grid-cols-7 gap-0.5 mb-1">
                    {WD.map((w, i) => <div key={i} className="text-center text-[11px] font-semibold text-label-3 py-1">{w}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-0.5">
                    {days.map((d, i) => { const c = cell(d); return (
                        <button key={i} disabled={c.disabled} onClick={() => { onPick(c.s); onClose(); }}
                            className={`h-9 rounded-lg text-sm tabular-nums ${c.selected ? 'bg-accent text-white font-semibold' : c.inMonth ? 'text-label hover:bg-accent-soft' : 'text-label-3 hover:bg-accent-soft'} disabled:opacity-30 disabled:hover:bg-transparent`}>
                            {c.n}
                        </button>
                    ); })}
                </div>
                <div className="flex justify-between mt-3 pt-2.5 border-t border-separator-2">
                    <button onClick={() => { onPick(''); onClose(); }} className="text-accent text-[15px]">Clear</button>
                    <button onClick={() => { onPick(today); onClose(); }} className="text-accent text-[15px] font-semibold">Today</button>
                </div>
            </div>
        </>
    );
}
const prevMonth = v => (v.m === 0 ? { y: v.y - 1, m: 11 } : { y: v.y, m: v.m - 1 });
const nextMonth = v => (v.m === 11 ? { y: v.y + 1, m: 0 } : { y: v.y, m: v.m + 1 });
```

- [x] **Step 2: Wire into App** (inside the center date-nav zone, after the date button)

```jsx
{showCal && (
    <CalendarPopover date={date} today={TODAY} min={MIN_DATE} max={MAX_DATE}
        onPick={d => changeDate(d)} onClose={() => setShowCal(false)} />
)}
```

Add `import CalendarPopover from './components/CalendarPopover.jsx';`. Ensure the center zone `<div>` is `relative` so the popover anchors to it.

- [x] **Step 3: Verify** — build clean; open the calendar: month nav works, out-of-range days (before `2026-07-02`, after +7d) are disabled, selecting a day navigates + updates `?date=`, Clear → All dates, Today → today. Light + dark.

- [x] **Step 4: Commit**

```bash
git add web/src/components/CalendarPopover.jsx web/src/App.jsx
git commit -m "feat(web): custom iOS calendar popover (replaces native date input)"
```

---

## Task 7: Magic sort → iOS sheet (modal dialog)

**Files:**
- Modify: `web/src/components/MagicMenu.jsx` (becomes the Magic **sheet** content)
- Modify: `web/src/App.jsx` (render `<MagicMenu>` inside a `Sheet` gated by `showMagic`)

Convert Magic from an anchored dropdown to a **modal dialog** (per the toolbar-overflow decision — keeps the ⋯ menu simple). The toolbar/overflow trigger already sets `showMagic` (Task 5). `MagicMenu` drops its own trigger button and renders only its body: explanatory text (`text-label-2`), strategy rows (name `font-semibold text-label`, stats `text-label-2`, active row `bg-accent-soft`), "Clear magic sorts", sample-size footer. **Keep all props, the `activeIds`/`onToggle`/`onClearMagic` logic, small-sample warnings, and legend text verbatim** — only the container changes.

- [x] **Step 1: Refactor `MagicMenu.jsx`** to export the body only (no trigger); accept `onClose`. Header: title "Magic sort" + `SheetClose`. Restyle rows per the cheat-sheet.
- [x] **Step 2: Wire in App** — near the other sheets:

```jsx
{showMagic && (
    <Sheet onClose={() => setShowMagic(false)} className="max-w-md">
        <MagicMenu data={magicData} error={magicError} activeIds={activeMagicIds}
            onToggle={onToggleMagic} onClearMagic={onClearMagic} onClose={() => setShowMagic(false)} />
    </Sheet>
)}
```

- [x] **Step 3: Verify** — the ⋯ menu and the `≥sm` magic button both open the sheet; toggling strategies still updates the sort chain + ✨ column; multiple strategies stack; Clear works; Escape/backdrop close. Light + dark.
- [x] **Step 4: Commit** — `style(web): magic sort as iOS sheet`

---

## Task 8: SortPills → iOS chips

**Files:**
- Modify: `web/src/components/SortPills.jsx`

Restyle only: "Sorted by" label `text-label-2`; each pill `bg-surface border border-separator rounded-[10px]` with priority # `text-label-3 tabular-nums`, label `font-semibold`, arrow `text-accent`, × button `hover:bg-fill`; "Clear all" `text-label-2`. Keep the chain rendering, remove/clear callbacks, priority numbers.

- [x] Restyle; verify pills reflect the chain, removal + Clear-all work, priority numbers correct. Light + dark.
- [x] Commit: `style(web): iOS sort pills`

---

## Task 9: Sheets — Settings / Filters / Help / Slips

Each sub-task wraps the existing modal body in `Sheet` and restyles its chrome per the cheat-sheet. **Keep all controls, props, state, and callbacks.** Header pattern for each: `<div className="flex items-center gap-3 px-6 pt-5 pb-3"><h2 className="text-[22px] font-extrabold tracking-tight">TITLE</h2>…<SheetClose onClose={onClose}/></div>`.

### Task 9a: SettingsModal
- Modify: `web/src/components/SettingsModal.jsx`. Wrap in `Sheet`. Restyle: section headings `text-[17px] font-bold`; collapsible market/stat panels `bg-fill rounded-xl`; toggle chips (selected `bg-accent text-white`, else `bg-fill text-label`); draggable order chips keep HTML5 DnD, add `⠿` handle `text-label-3`; checkboxes as iOS check pills; blue **Done** button `bg-accent text-white rounded-full`. Keep every toggle (markets, stats, order+reset, visible/link providers, show-completed, hide hits/miss, no-miss, **safe-only**, sort-priority reorder).
- Verify: every setting still reads/writes localStorage and updates the table (columns, order, providers, completed, outcome toggles, safe-only, sort priority). Light + dark.
- Commit: `style(web): Settings as iOS sheet`

### Task 9b: FilterBuilder (restyle chrome ONLY — controls unchanged)
- Modify: `web/src/components/FilterBuilder.jsx`. It currently renders inline; render it inside `Sheet` opened by the Filters toolbar button (App: change `showFilters` to drive a `Sheet`, or keep the inline toggle but restyled — **prefer the sheet** per user). Restyle selects/inputs to `bg-fill rounded-[10px] h-9`; condition rows keep the exact field/op/value/remove controls; "+ Add condition" `text-accent`; Clear / **Apply** footer (Apply `bg-accent text-white rounded-full`). **Do not change the op set, field grouping, CSV-list handling, or the server/client split.**
- Verify: every operator (`= ≠ > ≥ ≤`, contains/not-contains, in/not-in) still applies; derived-STATS/score filters still run client-side; Apply/Clear behave exactly as before. Light + dark.
- Commit: `style(web): Filters as iOS sheet (controls unchanged)`

### Task 9c: HelpModal
- Modify: `web/src/components/HelpModal.jsx`. Wrap in `Sheet`; restyle intro/legend/demo-video placeholder per prototype; keep content + credit.
- Verify: opens/closes; legend readable light + dark.
- Commit: `style(web): Help as iOS sheet`

### Task 9d: BetslipPlayground
- Modify: `web/src/components/BetslipPlayground.jsx`. Wrap in `Sheet` (wide: `max-w-5xl`). Restyle: config row inputs (via `NumberInput`), Auto/Manual toggle, Clear/New-slip ghost buttons, `bg-accent` "✨ Fill from top"; two-pane Tips|Slips grid with hairline divider; slip cards `border border-separator-2 rounded-2xl`; per-slip odds/payout/survival/EV row; empty-state dashed box. **Keep all limits, buildSlips logic, EV/survival calc, per-date persistence.**
- Verify: fill-from-top, add/remove legs, all four limits, Auto/Manual rebuild, EV/survival numbers, persistence across date change. Light + dark.
- Commit: `style(web): Betslip playground as iOS sheet`

---

## Task 10: MultiSelect + NumberInput restyle

**Files:**
- Modify: `web/src/components/MultiSelect.jsx`, `web/src/components/NumberInput.jsx`

Restyle only (used inside Settings/Slips): dropdown surfaces `bg-surface border border-separator rounded-xl shadow-lg`, options hover `bg-fill`, selected `text-accent`; inputs `bg-fill rounded-[10px] h-9 text-label`. Keep all input parsing/validation logic (`numberInput.js`) and selection behavior untouched.

- [x] Restyle; verify multi-selects (markets/stats/providers) and numeric inputs (slips) work identically. Light + dark.
- [x] Commit: `style(web): iOS multiselect + number inputs`

---

## Task 11: DataTable restyle

**Files:**
- Modify: `web/src/components/DataTable.jsx`

Restyle only — **do not touch** the column pipeline, sort/`orderRows`, pin hysteresis (`PIN_KEYS = ['score','tip']` stays), `scrollKey` scroll preservation, magic column, or cell logic. Changes:
- Container: `bg-surface rounded-2xl border border-separator-2 shadow-sm` and set height to fill the shell: replace `max-h-[calc(100vh-13rem)] sm:max-h-[calc(100vh-10.5rem)]` with `flex-1 min-h-0` (parent `<main>` is now the flex column) + keep `overflow-auto`.
- Header cells: `bg-surface-2 text-label-2` sticky; sort arrows `text-accent`.
- Rows: `ROW_TINTS = ['bg-surface', 'bg-surface-2']`; row border `border-hairline`; hover `hover:bg-fill`.
- Sticky pinned cells: reuse the row tint tokens; shadow `shadow-[inset_-1px_0_0_var(--separator-2)]`.
- Cell content colors via cheat-sheet: fixture link `text-accent`; provider badge `bg-accent-soft text-accent` (betpawa) / a green tint (betika) — keep both distinguishable; tip cell hit `text-hit`, miss `text-miss`, veto `text-label-3 line-through`, `%` `text-label-2`; 🔥 flame keep emoji (or `text-hot`); market stale/frozen `text-label-3`; dashes `text-label-3`.
- Tap target: bump row `py-1` → `py-1.5` (touch-tuned compact); keep `text-xs`/`text-[13px]`.

- [x] Restyle; **run `npm test`** (must stay green — shared `sortValues`/`ordering` untouched).
- [x] Verify (critical, all widths + themes): sticky header + **Score/Tip left-pins still track on horizontal scroll**; sort (click/shift-click/multi) unchanged; row tints pair per fixture; tip cell states (hot/hit/miss/veto/%); market fresh/stale/frozen greys distinguishable in dark; magic column; scroll preserved across a silent refresh.
- [x] Commit: `style(web): iOS data table (pins/sort/scroll behavior unchanged)`

---

## Task 12: TipPopover restyle

**Files:**
- Modify: `web/src/components/TipPopover.jsx`

Restyle to the prototype card: `bg-surface rounded-2xl shadow-2xl` anchored popover with a full-screen click-catcher behind; fixture title + `SheetClose`; blue headline (`text-accent text-lg font-bold`); section labels `text-[11px] font-bold tracking-wider text-label-2 uppercase` (CONFIDENCE BLEND / RUNNERS-UP / OVER-2.5 GATE AUDIT); blend rows (label + sub `text-label-2` + colored value); audit ✓ `text-hit`; hot marker `text-hot`. **Keep all content**: `SIGNAL_LABEL` glossary, `signalValue`, `skipLabel` skip reasons, AI verdict (probability, per-check findings, grounding links), Safe-pick 🛡 badge, runners-up.

- [x] Restyle; verify a normal tip, a hot tip (gate audit), a vetoed tip, an AI-reviewed tip (v2 fields), and a "no data" skip all render correctly. Light + dark.
- [x] Commit: `style(web): iOS tip popover`

---

## Task 13: Tooltip → touch tap-popover

**Files:**
- Modify: `web/src/components/Tooltip.jsx`

Extend the existing touch-friendly tooltip so it opens on **tap** (touch) as well as hover (pointer), for header definitions and cell context that currently rely on native `title=`. Restyle the bubble to `bg-label text-surface` (inverted) or `bg-surface border border-separator shadow-lg` rounded, `text-xs`. Keep the current API (`content`, children) so all call sites are unaffected. Do **not** convert interactive cells (tip/fixture) that own their own tap actions.

- [x] Restyle + add tap-open; verify on a touch emulation that header/cell definitions appear on tap and dismiss on outside tap; pointer hover still works.
- [x] Commit: `style(web): touch-friendly tap tooltips`

---

## Task 14: Full verification + no-regression pass

**Files:** none (verification only).

- [x] `npm test` → all green.
- [x] `npm run build:web` → clean; `npm run serve` → drive the built app against the real DB.
- [x] Walk the **no-regression inventory** (spec §9) end-to-end in **light and dark** at **iPad portrait, iPad landscape, desktop, AND a narrow phone width (`< sm`)**: date nav + calendar + URL sync, refresh + freshness silent reload, unified sort (column + magic, additive + shift-isolate + pills), magic **sheet** (opens from both the `≥sm` button and the ⋯ menu), slips (all limits/auto/fill/EV/persistence), filters (all ops + server/client split), settings (every toggle + order + safe-only + sort priority), table (pins/tints/tip states/market greys/magic col/scroll preservation), tip popover (all variants), footer (four items, whole-item wrap), refresh button (idle icon + last-refresh tooltip; running → disabled + spinner icon + step tooltip), outcome toggles, providers filter, completed toggle, localStorage persistence.
- [x] **Responsive overflow:** at `< sm`, all actions live in the ⋯ menu (date nav still inline, no wrap); at `≥ sm` the full icon row shows. Every overflow row works.
- [x] Confirm the favicon/app-icon/toolbar logo render (light + dark).
- [x] Fix any regression found; re-verify.
- [x] Final commit if fixes were needed: `fix(web): iOS redesign verification fixes`

---

## Notes for the executor

- Restart `npm run serve` after backend-affecting pulls (none here, but habitual).
- Do not edit `web/dist/` (gitignored build output) — `npm run build:web` regenerates it.
- If any restyle seems to require a behavior change, **stop and ask** (Global Constraints).
- The v3 prototype (`docs/superpowers/specs/…-design.md` references project `719b928e-470e-4aab-af7d-0c2759f36d5e`) is the visual reference for spacing/colors when a detail is ambiguous.
