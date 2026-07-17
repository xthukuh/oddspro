# Help Dialog Glossary + Collapsible Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the web Help dialog into collapsible sections and add a four-category sports-betting glossary (markets & codes, odds & pricing, performance & stats, app terms).

**Architecture:** A zero-import pure-data module (`web/src/glossary.js`) holds the definitions; a small reusable `CollapseSection.jsx` lifts the â–¸ disclosure idiom BetslipPlayground already uses inline; `HelpModal.jsx` becomes a stack of six sections (About open, rest collapsed). A node:test file guards the market entries against `tipMarketLabel()` from `src/db/magic-rules.js` so glossary wording can never drift from the labels the table shows.

**Tech Stack:** React 19 + Vite 6 + Tailwind 4 (CSS-var token theme), node:test offline suite.

**Spec:** `docs/superpowers/specs/2026-07-17-help-glossary-design.md` (approved 2026-07-17).

## Global Constraints

- ES modules, `async/await`, **4-space indentation** (workspace rule), single quotes, semicolons. Strings containing an apostrophe may use double quotes.
- **No em/en dashes (U+2014/U+2013) in any user-facing copy** - plain `-` only (Phase J rule, test-asserted here).
- Definitions are public industry knowledge + what a UI element shows. **No methodology internals** (blend weights, gate thresholds, strategy formulas). Glossary is identical for guests and signed-in users - no details-gating.
- Web + tests only: no server, API, or migration changes. Do **not** run `npm run build:web` (web/dist rebuild is a deploy-time step).
- `npm test` must stay green: 719 passing before this plan, 723 after (4 new tests).
- Tailwind token classes in use: `text-label` (primary text), `text-label-2` (secondary), `text-label-3` (tertiary), `border-separator` (hairline), `bg-fill`.
- Tap targets â‰¥44px (codebase convention for interactive rows).

## File Structure

- Create `web/src/glossary.js` - pure data, zero imports (offline-importable by node:test like `web/src/columns.js`).
- Create `tests/glossary.test.js` - shape + no-drift + copy-rule guards.
- Create `web/src/components/CollapseSection.jsx` - reusable disclosure section.
- Modify `web/src/components/HelpModal.jsx` - section stack; all existing copy/embed logic preserved.

---

### Task 1: Glossary data module + no-drift tests

**Files:**
- Test: `tests/glossary.test.js`
- Create: `web/src/glossary.js`

**Interfaces:**
- Consumes: `tipMarketLabel(market)` from `src/db/magic-rules.js` (test only; the data module itself imports nothing).
- Produces: `export const GLOSSARY` - array of 4 categories `{ id, title, terms }`; each term is `{ term, def }` plus optional `{ key, name }` where `name` is the exact `tipMarketLabel(key)` wording. Task 2 renders this verbatim.

- [x] **Step 1: Write the failing test**

Create `tests/glossary.test.js`:

```js
// Help-dialog glossary data (web/src/glossary.js): shape guards, the no-drift
// rule - market entries must reuse tipMarketLabel()'s exact wording - and the
// web-copy ban on em/en dashes. Pure data, no .env/DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLOSSARY } from '../web/src/glossary.js';
import { tipMarketLabel } from '../src/db/magic-rules.js';

test('glossary: four categories, each well-formed', () => {
    assert.deepEqual(GLOSSARY.map(g => g.id), ['markets', 'pricing', 'performance', 'app']);
    for (const g of GLOSSARY) {
        assert.ok(typeof g.title === 'string' && g.title.length > 0, `${g.id} title`);
        assert.ok(Array.isArray(g.terms) && g.terms.length > 0, `${g.id} terms`);
        for (const t of g.terms) {
            assert.ok(typeof t.term === 'string' && t.term.length > 0, `${g.id} term`);
            assert.ok(typeof t.def === 'string' && t.def.length > 0, `${g.id} ${t.term} def`);
        }
    }
});

test('glossary: terms unique within each category', () => {
    for (const g of GLOSSARY) {
        const names = g.terms.map(t => t.term);
        assert.equal(new Set(names).size, names.length, g.id);
    }
});

test('glossary: market entries reuse tipMarketLabel wording verbatim', () => {
    const keyed = GLOSSARY.flatMap(g => g.terms).filter(t => t.key);
    assert.ok(keyed.length >= 10, 'market codes should carry keys');
    for (const t of keyed) {
        assert.equal(t.name, tipMarketLabel(t.key), t.term);
    }
});

test('glossary: no em/en dashes anywhere (web copy rule)', () => {
    for (const g of GLOSSARY) {
        for (const t of g.terms) {
            for (const s of [t.term, t.name ?? '', t.def]) {
                assert.ok(!/[â€“â€”]/.test(s), `${g.id} ${t.term}: "${s}"`);
            }
        }
    }
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test tests/glossary.test.js`
Expected: FAIL - `Cannot find module ... web/src/glossary.js` (ERR_MODULE_NOT_FOUND).

- [x] **Step 3: Write the data module**

Create `web/src/glossary.js` (content is the approved spec wording, verbatim):

```js
// Betting-lingo glossary shown in the Help dialog (HelpModal.jsx). Pure data,
// zero imports - offline-tested by tests/glossary.test.js, which asserts every
// entry carrying a market `key` uses the exact tipMarketLabel() wording so the
// glossary can never drift from the labels the table and popovers show.
// Copy rule: plain "-" only, never em/en dashes.
export const GLOSSARY = [
    {
        id: 'markets',
        title: 'Betting markets & codes',
        terms: [
            { term: '1X2', def: 'Match result market. 1 = home win, X = draw, 2 = away win. Settled on the full-time score; extra time and penalties do not count.' },
            { term: '1X', key: '1X', name: 'Home or draw', def: 'Double chance: wins if the home team wins or the match is drawn. Covers two of the three outcomes, so the odds are lower than a straight 1 or X.' },
            { term: 'X2', key: 'X2', name: 'Draw or away', def: 'Double chance: wins if the match is drawn or the away team wins.' },
            { term: '12', key: '12', name: 'Home or away', def: 'Double chance: wins if either team wins; loses only on a draw.' },
            { term: 'O / U', def: "Over/Under: a bet on the match's total goals landing above (O) or below (U) a set line. O 2.5 wins with 3 or more goals; U 2.5 wins with 2 or fewer. Half lines like 2.5 can never be tied, so the bet always settles win or lose." },
            { term: 'GG', key: 'GG', name: 'Both teams to score: Yes', def: 'Also called BTTS. Wins if both teams score at least one goal each.' },
            { term: 'NG', key: 'NG', name: 'Both teams to score: No', def: 'Wins if at least one team fails to score.' },
            { term: 'DNB1', key: 'DNB1', name: 'Home (draw no bet)', def: 'Draw no bet on the home side: wins if the home team wins; your stake is returned (void) if the match is drawn.' },
            { term: 'DNB2', key: 'DNB2', name: 'Away (draw no bet)', def: 'Draw no bet on the away side: wins if the away team wins; stake returned on a draw.' },
            { term: 'TT', key: 'TT:H:O 1.5', name: 'Home team over 1.5 goals', def: "Team total: an over/under on one team's goals only. TT:H is the home side, TT:A the away side; the example named here, TT:H:O 1.5, wins if the home team scores 2 or more." },
            { term: 'ODD', key: 'ODD', name: 'Odd total goals', def: 'Wins if the match total is an odd number (1, 3, 5, ...).' },
            { term: 'EVEN', key: 'EVEN', name: 'Even total goals', def: 'Wins if the match total is an even number (2, 4, ...). A 0-0 draw counts as even.' },
        ],
    },
    {
        id: 'pricing',
        title: 'Odds & pricing',
        terms: [
            { term: 'Odds (decimal)', def: 'The payout multiplier. A 1.60 price returns 1.60 per 1 staked (0.60 profit). Higher odds mean the bookmaker rates the outcome less likely.' },
            { term: 'Implied probability', def: 'The chance the odds suggest: 1 divided by the odds. A 1.60 price implies about 62.5%.' },
            { term: 'Overround (vig / margin)', def: "The bookmaker's built-in edge: the implied probabilities of a full market add up to more than 100% (say 105%), and that extra is the margin you pay to bet." },
            { term: 'Fair (devigged) odds', def: 'What the price would be with the bookmaker margin stripped out. Odds Pro removes the overround before comparing probabilities.' },
            { term: 'Price drift', def: 'A price moving over time as the bookmaker reacts to news and money. Odds refresh through the day, so a price can differ from when a tip was made.' },
            { term: 'Stale odds', def: 'A price the bookmaker has withdrawn. Shown greyed with the last-seen value, so you can still read it but may no longer be able to bet it.' },
        ],
    },
    {
        id: 'performance',
        title: 'Performance & stats',
        terms: [
            { term: 'Hit rate', def: 'The share of settled picks that won. A 70% hit rate means 7 of 10 picks won.' },
            { term: 'Break-even rate', def: 'The hit rate needed to avoid losing money at a given price: 1 divided by the odds. At 1.60 you must win about 62.5% of the time just to break even.' },
            { term: 'Flat stake', def: 'Betting the same amount (1 unit) on every pick. The standard honest way to measure performance.' },
            { term: 'ROI', def: 'Return on investment: profit divided by total staked. A -3% ROI means 100 units staked came back as 97.' },
            { term: 'EV', def: 'Expected value: the average profit or loss a bet would produce if repeated many times. Positive-EV bets earn long-term; most bets are negative-EV because of the bookmaker margin.' },
            { term: 'H2H', def: 'Head to head: the past meetings between the same two teams.' },
            { term: 'Form', def: 'Recent results as letters: W win, D draw, L loss (e.g. LWWWD). The number shown before it in the table is form points from those games.' },
            { term: 'Rolling window (last N)', def: "Stats computed over each team's most recent games rather than the whole season, so they track current form." },
        ],
    },
    {
        id: 'app',
        title: 'Odds Pro terms',
        terms: [
            { term: 'Tip', def: "The app's best-supported pick for a fixture across all markets, blending bookmaker odds, recent form and expert data." },
            { term: 'Confidence', def: 'How strongly the evidence backs the tip, shown as a percentage. It measures the chance of winning, not profitability.' },
            { term: 'Hot pick ðŸ”¥', def: "An Over 2.5 goals candidate that passed every one of the app's strict checks. Rare by design." },
            { term: 'Safe pick ðŸ›¡', def: 'A tip that also clears the stricter Safety Net gates (strong agreement, modest price, enough evidence). Built for multi-bet slips that survive.' },
            { term: 'Sure bets â­', def: "The day's top picks ranked by estimated chance of winning. A survival claim, never a profit promise. Signed-in feature." },
            { term: 'Magic sort', def: 'Reorders the table by a strategy ranked on how it would have performed over past settled days, best first.' },
            { term: 'Slip / legs', def: 'A multi-bet: several picks (legs) combined into one bet. The odds multiply and every leg must win, so each added leg raises the payout but lowers the chance the slip survives.' },
            { term: 'Void', def: 'A bet returned with no win or loss (stake back). Example: draw no bet when the match ends in a draw.' },
            { term: 'One of each', def: 'A view option showing a single row per match from your highest-priority bookmaker, instead of one row per bookmaker.' },
        ],
    },
];
```

- [x] **Step 4: Run the test to verify it passes**

Run: `node --test tests/glossary.test.js`
Expected: 4 passing, 0 failing.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: 723 passing (719 + 4), 0 failing.

- [x] **Step 6: Commit**

```bash
git add tests/glossary.test.js web/src/glossary.js
git commit -m "feat(web): betting-lingo glossary data, tipMarketLabel no-drift guarded"
```

---

### Task 2: CollapseSection component + HelpModal restructure

**Files:**
- Create: `web/src/components/CollapseSection.jsx`
- Modify: `web/src/components/HelpModal.jsx` (full replacement below)

**Interfaces:**
- Consumes: `GLOSSARY` from Task 1 (`{ id, title, terms: [{ term, def, key?, name? }] }`); `Sheet`, `SheetClose`, `PinToggle` from `./Sheet.jsx` (unchanged).
- Produces: `CollapseSection` default export, props `{ title, defaultOpen = false, children }`. Body is conditionally rendered - closed sections mount nothing (this is what keeps the YouTube iframe from loading until opened).

- [x] **Step 1: Create CollapseSection.jsx**

Create `web/src/components/CollapseSection.jsx`:

```jsx
import { useState } from 'react';

// Collapsible section with the app's â–¸ disclosure idiom (BetslipPlayground
// uses the same inline pattern). The body is only MOUNTED while open -
// HelpModal relies on this so the demo-video iframe never loads until its
// section is expanded.
export default function CollapseSection({ title, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="border-t border-separator first:border-t-0">
            <button
                type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="w-full min-h-[44px] flex items-center gap-2 py-2.5 text-left"
            >
                <span className={`text-label-3 text-xs transition-transform ${open ? 'rotate-90' : ''}`}>â–¸</span>
                <span className="text-sm font-semibold">{title}</span>
            </button>
            {open && <div className="pb-4">{children}</div>}
        </div>
    );
}
```

- [x] **Step 2: Restructure HelpModal.jsx**

Replace the full contents of `web/src/components/HelpModal.jsx` with:

```jsx
import { useState } from 'react';
import Sheet, { SheetClose, PinToggle } from './Sheet.jsx';
import CollapseSection from './CollapseSection.jsx';
import { GLOSSARY } from '../glossary.js';

// Help / About modal: what Odds Pro does, a betting-lingo glossary and an
// embedded demo video, in collapsible sections (About starts open, the rest
// collapsed). The video URL is configurable at build time via
// VITE_DEMO_VIDEO_URL (.env) - unset shows a "coming soon" placeholder so the
// modal is complete before the real tutorial is recorded/uploaded.

const APP_NAME = import.meta.env.VITE_APP_NAME || 'Odds Pro';
const DEMO_URL = import.meta.env.VITE_DEMO_VIDEO_URL || '';

// Accept any common YouTube URL form (watch / youtu.be / embed / shorts) and
// return a privacy-friendly embed URL, or null if it isn't a YouTube link.
function youtubeEmbed(url) {
    const m = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/.exec(url || '');
    return m ? `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0` : null;
}

// Compact term rows: bold code, optional plain-language name, definition.
function TermList({ terms }) {
    return (
        <dl className="text-sm space-y-2">
            {terms.map(t => (
                <div key={t.term}>
                    <dt className="inline font-semibold text-label">
                        {t.term}{t.name ? <span className="font-normal text-label-2"> - {t.name}</span> : null}.
                    </dt>{' '}
                    <dd className="inline text-label-2">{t.def}</dd>
                </div>
            ))}
        </dl>
    );
}

export default function HelpModal({ onClose }) {
    const embed = youtubeEmbed(DEMO_URL);
    const [pinned, setPinned] = useState(false);

    return (
        <Sheet onClose={onClose} className="max-w-2xl" dismissable={!pinned}>
            <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                    <h2 className="text-[22px] font-extrabold tracking-tight flex items-center">
                        <span className="rounded-md border border-separator bg-fill px-1.5 py-0.5 text-sm font-bold tracking-wide mr-2">[OP]</span>
                        {APP_NAME} - Help
                    </h2>
                    <div className="flex-1" />
                    <PinToggle pinned={pinned} onToggle={() => setPinned(v => !v)} />
                    <SheetClose onClose={onClose} />
                </div>

                <div className="overflow-y-auto px-6 pb-6">
                    <CollapseSection title="About & how to use" defaultOpen>
                        <p className="text-sm text-label-2 mb-3">
                            <strong className="text-label">{APP_NAME}</strong> is a football odds &amp; tips dashboard. It brings
                            bookmaker odds (BetPawa, Betika) together with official fixture and results data,
                            matches them up, and highlights the standout <strong className="text-label">Over 2.5 hot picks</strong> ðŸ”¥
                            and best-bet <strong className="text-label">tips</strong> for each day - ranked most-likely-to-win first.
                        </p>
                        <ul className="text-sm text-label-2 space-y-1 list-disc pl-5">
                            <li>Use the <strong className="text-label">date navigation</strong> (â€¹ â€º) and the calendar to browse fixtures by day; the logo returns you to today.</li>
                            <li><strong className="text-label">Refresh</strong> re-fetches odds, fixtures &amp; results for the selected date.</li>
                            <li><strong className="text-label">Magic</strong> re-orders tips so the strongest come first.</li>
                            <li><strong className="text-label">Slips</strong> builds virtual multi-bet slips from the day's tips.</li>
                            <li><strong className="text-label">Filters</strong> narrows the table; <strong className="text-label">Settings</strong> controls columns &amp; display.</li>
                        </ul>
                    </CollapseSection>

                    {GLOSSARY.map(g => (
                        <CollapseSection key={g.id} title={g.title}>
                            <TermList terms={g.terms} />
                        </CollapseSection>
                    ))}

                    <CollapseSection title="Demo video">
                        <div className="relative w-full overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: '16 / 9' }}>
                            {embed ? (
                                <iframe
                                    className="absolute inset-0 w-full h-full"
                                    src={embed}
                                    title={`${APP_NAME} demo`}
                                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                                    allowFullScreen
                                />
                            ) : (
                                <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-white/70 p-4">
                                    <span className="text-4xl mb-2">â–¶</span>
                                    <span className="text-sm">Demo video coming soon</span>
                                    <span className="text-xs text-white/50 mt-1">A walkthrough will be published here shortly.</span>
                                </div>
                            )}
                        </div>
                    </CollapseSection>

                    <p className="text-xs text-label-3 mt-4 pt-3 border-t border-separator">
                        Maintained by <a className="underline hover:text-label" href="https://github.com/xthukuh" target="_blank" rel="noreferrer">Martin Thuku</a>.
                    </p>
                </div>
            </div>
        </Sheet>
    );
}
```

Notes for the implementer: the intro `<p>`/`<ul>` copy is byte-identical to the old file except the `<ul>` dropped `mb-4` (section padding covers it) and the old standalone `<h3>Demo video</h3>` heading is replaced by its section title. The credit line gained `pt-3 border-t border-separator` so it reads as a footer under the last section.

- [x] **Step 3: Run the full suite (regression only - no new tests this task)**

Run: `npm test`
Expected: 723 passing, 0 failing (React components aren't unit-tested in this repo; the suite guards the data + shared modules).

- [x] **Step 4: Browser-verify on the Vite dev server**

Start: `cd web && npm run dev` (proxies `/api/*` to :3001; if :5173 is held by an orphan, Vite picks :5174 - use whatever port it prints; on Windows kill orphans with `taskkill //PID <pid> //T //F`).

Checklist (reuse the existing MCP browser tab if one is open - do not spawn a second):
1. Open the printed URL. Click the **?** help icon (nav right zone; inside the â‹¯ overflow menu on narrow widths).
2. "About & how to use" is expanded; the four glossary sections and "Demo video" are collapsed.
3. Each section toggles independently; the â–¸ chevron rotates 90Â° when open; opening one does NOT close another.
4. Network tab: **no** `youtube-nocookie.com` request until "Demo video" is expanded (with `VITE_DEMO_VIDEO_URL` unset the placeholder shows instead - then just confirm the placeholder only mounts on expand).
5. Spot-check glossary copy: "DNB1 - Home (draw no bet)." style rows, no em dashes visible.
6. Sections render identically signed-out (glossary is not details-gated).
7. Zero console errors.
8. Cleanup: stop the dev server (kill the process tree), close any page/context you opened.

- [x] **Step 5: Commit**

```bash
git add web/src/components/CollapseSection.jsx web/src/components/HelpModal.jsx
git commit -m "feat(web): collapsible Help sections with betting glossary"
```

---

## Completion

After both tasks: suite 723/723, two commits on `main`. Note in the session's wrap-up that `web/dist` is now TWO features behind (filters sync + glossary) - the next deploy package must run `npm run build:web`. Use superpowers:finishing-a-development-branch if a branch was used; direct-to-main commits are this repo's current norm (main=dev).
