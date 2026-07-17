# Sure Bets — daily top-10 safe list — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved Sure-bets feature (spec `docs/superpowers/specs/2026-07-17-sure-bets-filter-design.md`): a signed-in-only "Sure bets" toggle that filters the table to the day's top-10 safest tips ranked by calibrated win probability, with an N-of-10 pill, an explicit zero-day warning, and a one-tap "Top-3 slip" into the betslip playground.

**Architecture:** One new pure function in `src/db/magic-rules.js` (shared verbatim server/web, like everything else in that module) does ALL selection; the web adds a localStorage toggle wired exactly like Safe-only (membership cut by `api_id` over the whole loaded selection), a ViewPills chip, a Magic-sheet row with a guest nudge, and a slip-seeding helper exported from `BetslipPlayground.jsx` (the module that owns the `oddspro.betslips` format). **Zero server changes** (spec §3.2).

**Tech Stack:** Plain ES-module JS (4-space indent, single quotes, semicolons), node:test offline suite, React 19 web importing the pure module out-of-root.

## Global Constraints

- Gates = the spec-PINNED `DEFAULT_SAFE` literals (`safeQualifies`' fallback — the web passes only `DEFAULT_SURE_BETS`). **Execution correction (live-verified 2026-07-17):** the plan originally wired `effectiveSafe` (server env + user overrides) to preserve "Sure bets ⊆ safe pool", but this host's `SAFE_MIN_PARTS=3`/`SAFE_MIN_AGREEMENT=0.7` env starved the list to permanent zero-days (0/194 on 07-18; with DEFAULT_SAFE literals the same day yields exactly 10). The spec's own text resolves the conflict: §2 names the literal gate values and warns "tighter starves"; §5 excludes env/admin knobs from v1. The ⊆ claim holds against the DEFAULT_SAFE-defined pool; an env-tightened Safe-only simply ANDs independently.
- RANK = `estimateLegProb(tipView(row), cal)` DESC; null prob = excluded; stable ties (spec §2 — sidesteps the `sure` top-rank anomaly, finding 3).
- CAP = 10/day, show what exists: N<10 unpadded; N=0 shows the warning "No sure bets today - no fixture passed the safety gates" (spec §2).
- SIGNED-IN ONLY: guests lack `tip_breakdown` (server-redacted) so the gates cannot evaluate; guests get a sign-in nudge on the Magic-sheet row (spec §2).
- NO generation-side changes, no new env knobs, no ledger rewrites, no +EV claims (spec §2). Honesty copy only where `useShowDetails()` allows (spec §4).
- NO em dashes in web UI copy (project rule — use `-`).
- Do NOT rebuild `web/dist` (it must keep matching the v1.2.0 release zip); verify via the :5173 dev server.
- Conventional Commits; commit at the end of every task.
- Spec deviation (recorded): the spec's §3.4 mentions "web membership helper covered in filterValues tests"; the membership cut is implemented INLINE in `App.jsx` exactly like the existing Safe-only cut (one idiom, no drift) — the membership logic itself IS the fully-tested pure `sureBetsSelection`.

---

### Task 1: Pure selection engine — `sureBetsSelection` + `DEFAULT_SURE_BETS`

**Files:**
- Modify: `src/db/magic-rules.js` (insert directly AFTER `safeSelection`, before `slipSummary`, ~line 504)
- Test: `tests/magic-rules.test.js` (append after the `safeSelection` tests, ~line 466; extend the import list on line ~9)

**Interfaces:**
- Consumes (already in the module): `safeQualifies(row, opts, cal)`, `tipView(row)`, `estimateLegProb(tip, cal)`, module-private `_dayKey(r)`.
- Produces: `export const DEFAULT_SURE_BETS = { maxPerDay: 10, slipSize: 3 }` and `export function sureBetsSelection(rows, cal, opts = DEFAULT_SURE_BETS)` → ordered `Array<{ row, prob }>` (prob = the exact `estimateLegProb` number, so consumers never recompute). Tasks 2–3 import both.

- [x] **Step 1: Write the failing tests**

Extend the import on line ~9 of `tests/magic-rules.test.js` with `sureBetsSelection, DEFAULT_SURE_BETS`. The file's existing `safe()` factory (line ~361) makes a gate-passing row: `api_id 1`, `day '2026-07-01'`, `tip_market '1X'`, `tip_price 1.25`, `tip_confidence 0.75`, 3-part breakdown (agreement 0.75). With `cal = null`, `estimateLegProb` falls back to blend confidence — so ordering tests just vary `tip_confidence`.

Append after the last `safeSelection` test (~line 466):

```js
// --- sureBetsSelection (daily top-10 safe list, 2026-07-17 spec) ---

test('sureBetsSelection ranks by calibrated leg prob desc and carries the prob', () => {
    const rows = [
        safe({ api_id: 1, tip_confidence: 0.70 }),
        safe({ api_id: 2, tip_confidence: 0.78 }),
        safe({ api_id: 3, tip_confidence: 0.74 }),
    ];
    const picks = sureBetsSelection(rows, null);
    assert.deepEqual(picks.map(e => e.row.api_id), [2, 3, 1]);
    // prob IS estimateLegProb's number (cal-less fallback = blend confidence)
    assert.deepEqual(picks.map(e => e.prob), [0.78, 0.74, 0.7]);
});

test('sureBetsSelection caps at maxPerDay (10) and shows what exists unpadded', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => safe({ api_id: i + 1, tip_confidence: 0.6 + i * 0.01 }));
    assert.equal(sureBetsSelection(twelve, null).length, DEFAULT_SURE_BETS.maxPerDay);
    // thin day: 4 qualifiers -> 4 entries, no padding
    assert.equal(sureBetsSelection(twelve.slice(0, 4), null).length, 4);
    // empty pool -> [] (also for non-array input)
    assert.deepEqual(sureBetsSelection([], null), []);
    assert.deepEqual(sureBetsSelection(null, null), []);
});

test('sureBetsSelection dedups one entry per canonical fixture, first row represents', () => {
    const rows = [
        safe({ api_id: 7, provider: 'betpawa' }),
        safe({ api_id: 7, provider: 'betika' }),
        safe({ api_id: 8 }),
    ];
    const picks = sureBetsSelection(rows, null);
    assert.deepEqual(picks.map(e => e.row.api_id), [7, 8]);
    assert.equal(picks[0].row.provider, 'betpawa');
});

test('sureBetsSelection reuses the safe gates - a safeQualifies reject never enters', () => {
    const rows = [
        safe({ api_id: 1, tip_price: 1.7, tip_confidence: 0.95 }), // price > maxPrice 1.6
        safe({ api_id: 2, tip_market: null }),                     // tipless
        safe({ api_id: 3 }),
    ];
    assert.deepEqual(sureBetsSelection(rows, null).map(e => e.row.api_id), [3]);
    // caller gate overrides are honored (maxPrice 1.2 rejects the 1.25 default)
    assert.deepEqual(sureBetsSelection(rows, null, { ...DEFAULT_SURE_BETS, maxPrice: 1.2 }), []);
});

test('sureBetsSelection excludes rows whose leg prob is null', () => {
    // Passes every gate (2 parts, agreement 0.75, price ok) but with no cal and
    // no confidence there is no number to rank by - excluded, never NaN-sorted.
    const noProb = safe({ api_id: 1, tip_confidence: null, tip_breakdown: { market_prob: 0.8, stats_prob: 0.75 } });
    assert.deepEqual(sureBetsSelection([noProb, safe({ api_id: 2 })], null).map(e => e.row.api_id), [2]);
});

test('sureBetsSelection caps per EAT day independently', () => {
    const rows = [
        safe({ api_id: 1, day: '2026-07-01', tip_confidence: 0.8 }),
        safe({ api_id: 2, day: '2026-07-01', tip_confidence: 0.7 }),
        safe({ api_id: 3, day: '2026-07-02', tip_confidence: 0.6 }),
    ];
    const picks = sureBetsSelection(rows, null, { ...DEFAULT_SURE_BETS, maxPerDay: 1 });
    assert.deepEqual(picks.map(e => e.row.api_id), [1, 3]); // one per day, day order
});

test('sureBetsSelection enforces the market maturity floor when a calibration is supplied', () => {
    const rows = [safe({ api_id: 1 })]; // tip_market '1X'
    const thinCal = { markets: { '1X': { n: 5, hits: 4 } } };
    assert.deepEqual(sureBetsSelection(rows, thinCal), []);
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `node --test tests/magic-rules.test.js`
Expected: FAIL — `SyntaxError`-level import failure (`sureBetsSelection` is not exported) or equivalent.

- [x] **Step 3: Implement**

Insert in `src/db/magic-rules.js` directly after `safeSelection`'s closing brace (~line 503):

```js
// Sure bets (2026-07-17 spec): the day's top-N safest legs, ranked by the
// SAME calibrated win probability the betslip survival meter shows. Pool =
// the shipped safe gates unchanged (safeQualifies - callers pass their
// effective safe policy in `opts`; unknown gate fields fall back to
// DEFAULT_SAFE inside safeQualifies). Deliberately NOT ranked by the 'sure'
// strategy: the design replay found its top ranks underperform (rank #1
// realized 63-64% vs ~85% at ranks 8-10), while estimateLegProb is
// self-consistent - the number we sort by IS the number the UI displays.
// Returns ordered [{ row, prob }] so consumers never recompute or drift;
// null prob = excluded (nothing to rank by). Survival claim, never EV.
export const DEFAULT_SURE_BETS = { maxPerDay: 10, slipSize: 3 };

export function sureBetsSelection(rows, cal, opts = DEFAULT_SURE_BETS) {
    const o = { ...DEFAULT_SURE_BETS, ...opts };
    const seen = new Set();
    const byDay = new Map();
    for (const r of Array.isArray(rows) ? rows : []) {
        const key = r?.api_id ?? r;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!safeQualifies(r, o, cal)) continue;
        const prob = estimateLegProb(tipView(r), cal);
        if (prob == null) continue;
        const day = _dayKey(r);
        let list = byDay.get(day);
        if (!list) byDay.set(day, list = []);
        list.push({ row: r, prob });
    }
    const out = [];
    for (const day of [...byDay.keys()].sort()) {
        // Stable sort: equal probs keep row (insertion) order.
        const ranked = byDay.get(day).sort((a, b) => b.prob - a.prob);
        out.push(...ranked.slice(0, Math.max(1, o.maxPerDay)));
    }
    return out;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `node --test tests/magic-rules.test.js`
Expected: PASS (all pre-existing magic-rules tests + the 7 new ones).

- [x] **Step 5: Run the FULL suite** (the web imports this module verbatim — a regression here breaks two consumers)

Run: `npm test`
Expected: PASS, 707 + 7 = 714 (or whatever the true new total is — record it).

- [x] **Step 6: Commit**

```powershell
git add src/db/magic-rules.js tests/magic-rules.test.js
git commit -m "feat(magic): sureBetsSelection - daily top-10 safe list (pure, spec 2026-07-17)"
```

---

### Task 2: App wiring + ViewPills chip / zero-day warning

**Files:**
- Modify: `web/src/App.jsx` (import ~line 8; LS consts ~line 50; state ~line 246; memos ~line 436; rows memo ~line 460; saver ~line 794; ViewPills props ~line 1025)
- Modify: `web/src/components/ViewPills.jsx`

**Interfaces:**
- Consumes: `sureBetsSelection`, `DEFAULT_SURE_BETS` (Task 1); existing `session` (`useSession()`), `visibleData`, `cal`, `effectiveSafe`, `saveSafeOnly` idiom.
- Produces (Task 3 relies on these exact names): App state `sureBets`/`setSureBets`, `const signedIn = !!session?.user`, memo `surePicks` (`Array<{ row, prob }>`), saver `saveSureBets(value)`.

- [x] **Step 1: App.jsx — import + LS key + state**

Line ~8, extend the magic-rules import:

```js
import { safeSelection, sureBetsSelection, DEFAULT_SURE_BETS } from '../../src/db/magic-rules.js';
```

After the `LS_SAFE_OVERRIDES` block (~line 54):

```js
// Sure-bets toggle (magic sheet; default off): keep only the day's top-10
// safest tips ranked by calibrated win probability (magic-rules
// sureBetsSelection). Signed-in only - guest rows are redacted server-side
// (no tip_breakdown), so the gates cannot evaluate.
const LS_SURE_BETS = 'oddspro.show.sureBets';
```

After the `safeOverrides` state (~line 247):

```js
const [sureBets, setSureBets] = useState(() => localStorage.getItem(LS_SURE_BETS) === '1');
```

- [x] **Step 2: App.jsx — surePicks memo**

Directly after the `safePicks` memo (~line 439):

```js
    // Sure-bets picks: the day's top-10 by calibrated leg prob over the WHOLE
    // loaded selection - same day-level scope as safePicks, so other toggles/
    // filters never change who makes the list. Gates = effectiveSafe (identical
    // to Safe-only, so Sure bets ⊆ safe pool); cap/slip size pinned by
    // DEFAULT_SURE_BETS. Empty for guests (their rows lack tip_breakdown; the
    // magic sheet shows a sign-in nudge instead).
    const signedIn = !!session?.user;
    const surePicks = useMemo(
        () => (signedIn ? sureBetsSelection(visibleData, cal, { ...effectiveSafe, ...DEFAULT_SURE_BETS }) : []),
        [signedIn, visibleData, cal, effectiveSafe],
    );
```

- [x] **Step 3: App.jsx — membership cut in the rows memo**

Inside the `rows` memo (~line 460), directly AFTER the existing `if (safeOnly) { ... }` block and BEFORE the `oneEach` line, add:

```js
        // Sure bets: same membership idiom as Safe-only - all provider rows of
        // a listed fixture survive; independent of the Safe-only toggle (both
        // on = AND; Sure bets ⊆ safe pool, so Sure bets effectively wins).
        if (sureBets && signedIn) {
            const ids = new Set(surePicks.map(e => e.row.api_id));
            out = out.filter(r => ids.has(r.api_id));
        }
```

Extend the memo's dependency array with `sureBets, signedIn, surePicks`.

- [x] **Step 4: App.jsx — saver + ViewPills props**

Next to `saveSafeOnly` (~line 794):

```js
    const saveSureBets = value => {
        setSureBets(value);
        localStorage.setItem(LS_SURE_BETS, value ? '1' : '0');
    };
```

In the `<ViewPills ...>` call (~line 1025), add:

```jsx
                    sureBets={sureBets && signedIn} sureCount={surePicks.length}
                    sureCap={DEFAULT_SURE_BETS.maxPerDay} onSureBets={saveSureBets}
```

- [x] **Step 5: ViewPills.jsx — chip + zero-day warning**

Add `sureBets, sureCount, sureCap, onSureBets` to the destructured props. After the `safeOnly` items.push line (~line 20):

```js
    if (sureBets && sureCount > 0) items.push(['sureBets', `⭐ Sure bets (${sureCount} of ${sureCap})`, 'Only the day’s sure-bets list is shown', () => onSureBets(false)]);
    // N=0: the warning takes the chip's place so the user sees WHY the table is
    // empty; the toggle stays on until they dismiss it (spec 2026-07-17 §3).
    if (sureBets && sureCount === 0) items.push(['sureBets', '⭐ No sure bets today - no fixture passed the safety gates', 'Nothing qualified today; × turns Sure bets off', () => onSureBets(false)]);
```

- [x] **Step 6: Verify offline + visually**

Run: `npm test` — Expected: PASS (no count change vs Task 1).
Run: `cd web; npm run dev` (backend serve already on :3001) → open `http://localhost:5173`, sign in, toggle Sure bets on via localStorage (`localStorage.setItem('oddspro.show.sureBets','1')` in DevTools console — the Magic-sheet row arrives in Task 3), reload: table filters to ≤10 fixtures, pill reads "⭐ Sure bets (N of 10)". Signed out: no pill, table unfiltered.

- [x] **Step 7: Commit**

```powershell
git add web/src/App.jsx web/src/components/ViewPills.jsx
git commit -m "feat(web): sure-bets membership filter + view pill with zero-day warning"
```

---

### Task 3: Magic-sheet row (toggle + guest nudge + honesty copy) + Top-3 slip seeding

**Files:**
- Modify: `web/src/components/BetslipPlayground.jsx` (add one export after `_wrap`, ~line 70)
- Modify: `web/src/components/MagicMenu.jsx`
- Modify: `web/src/App.jsx` (import ~line 11; handler next to `saveSureBets`; MagicMenu props ~line 1150)

**Interfaces:**
- Consumes: `surePicks` / `saveSureBets` / `signedIn` / `DEFAULT_SURE_BETS` (Task 2), playground-private `_loadSlips`/`_id`/`_hm`/`LS_SLIPS`.
- Produces: `export function seedSlip(entries, date, name)` in `BetslipPlayground.jsx` (entries = `Array<{ row, prob }>`); MagicMenu props `signedIn, sureBets, sureCount, sureCap, slipSize, onSureBets, onTopSlip`.

- [x] **Step 1: BetslipPlayground.jsx — seedSlip export**

After the `_wrap` helper (~line 70):

```js
// Seed a named slip into the persisted book from sure-bets entries
// [{ row, prob }] (App's "Top-3 slip" action, spec 2026-07-17). Lives HERE so
// the oddspro.betslips format has exactly one owner. Legs are self-contained
// (same fields the candidate mapper emits, minus the optional runner-up
// picks - the leg renderer already tolerates legacy legs without `picks`),
// so they render and settle on any loaded date. The playground loads storage
// on mount, so seed BEFORE opening it. Returns the created slip.
export function seedSlip(entries, date, name) {
    const legs = entries.map(({ row: r, prob }) => ({
        api_id: r.api_id,
        fixture: r.fixture,
        market: r.tip_market,
        price: r.tip_price == null ? null : Number(r.tip_price),
        prob,
        outcome: r.tip_outcome ?? null,
        date,
        time: _hm(r.start_time),
    }));
    const { config, slips } = _loadSlips();
    const slip = { id: _id(), name, legs };
    localStorage.setItem(LS_SLIPS, JSON.stringify({ date, config, slips: [...slips, slip] }));
    return slip;
}
```

- [x] **Step 2: App.jsx — import + handler + MagicMenu props**

Line ~11: `import BetslipPlayground, { seedSlip } from './components/BetslipPlayground.jsx';`

Next to `saveSureBets`:

```js
    // "Top-3 slip" (magic sheet): seed a slip from the top sure-bets legs into
    // the persisted book, then open the playground (it reads storage on mount).
    const seedTopSlip = () => {
        if (!surePicks.length) return;
        seedSlip(surePicks.slice(0, DEFAULT_SURE_BETS.slipSize), date || 'all', 'Sure top-3');
        setShowMagic(false);
        setShowSlips(true);
    };
```

MagicMenu render (~line 1150) gains:

```jsx
                    signedIn={signedIn} sureBets={sureBets} sureCount={surePicks.length}
                    sureCap={DEFAULT_SURE_BETS.maxPerDay} slipSize={DEFAULT_SURE_BETS.slipSize}
                    onSureBets={saveSureBets} onTopSlip={seedTopSlip}
```

- [x] **Step 3: MagicMenu.jsx — Sure bets section**

Extend the props destructuring with `signedIn, sureBets, sureCount, sureCap, slipSize, onSureBets, onTopSlip`. Inside the scroll area, AFTER the `{data && !strategies.length && (...)}` block (~line 74), add:

```jsx
                {/* Sure bets (2026-07-17 spec) - a FILTER, not a sort: the daily
                    top-10 safe list. Signed-in only: guest rows are redacted
                    (no tip_breakdown), so the gates cannot evaluate. */}
                <div className="mt-2 pt-2 border-t border-separator-2">
                    {signedIn ? (
                        <div className={`px-3 py-2.5 rounded-xl ${sureBets ? 'bg-accent-soft' : ''}`}>
                            <button onClick={() => onSureBets(!sureBets)} className="cursor-pointer block w-full text-left">
                                <span className="flex items-center text-[15px]">
                                    <span className="font-semibold text-label">⭐ Sure bets</span>
                                    <span className="ml-2 text-xs text-label-2 tabular-nums">{sureCount} of {sureCap} today</span>
                                    {sureBets && <span className="ml-auto text-accent">✓</span>}
                                </span>
                                <span className="block text-[12.5px] text-label-2">
                                    Filter the table to the day's safest list, ranked by calibrated win chance.
                                </span>
                            </button>
                            {sureBets && sureCount === 0 && (
                                <div className="mt-1 text-xs text-hot">No sure bets today - no fixture passed the safety gates.</div>
                            )}
                            <div className="mt-1.5 flex items-center gap-3">
                                <button
                                    onClick={onTopSlip}
                                    disabled={!sureCount}
                                    title={`Seed a slip with the top ${slipSize} legs and open the playground`}
                                    className="cursor-pointer text-[13px] font-semibold text-accent hover:underline disabled:opacity-50 disabled:cursor-default disabled:no-underline"
                                >
                                    Top-{slipSize} slip
                                </button>
                                {showDetails && (
                                    <span className="text-xs text-label-3" title="Live replay numbers - survival odds, not profit. Flat-stake EV stays ~ -vig.">
                                        legs ~72-76% · 3-leg slip lands ~40% of days
                                    </span>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="px-3 py-2.5 text-[13px] text-label-2">
                            ⭐ Sure bets - sign in to unlock the daily top-10 safe list.
                        </div>
                    )}
                </div>
```

- [x] **Step 4: Verify offline + visually**

Run: `npm test` — Expected: PASS.
On :5173 signed in: ✨ sheet shows the Sure bets row with a live "N of 10 today"; toggling filters the table + shows the pill; "Top-3 slip" closes the sheet, opens the playground with a "Sure top-3" slip of ≤3 legs (fixture names, prices, probs populated; survival/EV rendered). Signed out (or in a private window as guest): the row is the sign-in nudge; no toggle.

- [x] **Step 5: Commit**

```powershell
git add web/src/components/BetslipPlayground.jsx web/src/components/MagicMenu.jsx web/src/App.jsx
git commit -m "feat(web): magic-sheet sure-bets row + guest nudge + top-3 slip seeding"
```

---

### Task 4: Docs + full verification

**Files:**
- Modify: `docs/safety-net-protocol.md` (append a "Sure bets" section)
- Modify: `CLAUDE.md` (one line in the `src/db/magic-rules.js` bullet; one line in the `web/` bullet)

**Interfaces:** none — prose only.

- [x] **Step 1: safety-net-protocol.md — Sure bets section**

Read the doc first and match its heading depth/tone. Append (adjust heading level to fit):

```markdown
## Sure bets (daily top-10 safe list, 2026-07-17)

The ✨ Magic sheet's "Sure bets" toggle (signed-in only) filters the table to
the day's top-10 legs: the shipped safe gates unchanged, ranked by the
calibrated win probability the betslip survival meter shows (NOT the `sure`
strategy - its top ranks underperformed in the design replay, 63-64% at #1 vs
~85% at ranks 8-10). Thin days show fewer than 10; zero-days say so explicitly.

Honest numbers (LODO + strict walk-forward replays, 15 days, design time):
per-leg ~72-76% live; a top-3 slip lands ~40% of days at combined odds
~2.4-3.5; a full 10-leg stack survives ~5-7% of days; flat-stake EV stays
~ -vig. Sure bets maximizes the chance a SMALL slip survives - it does not
promise profit.

Suggested use: the one-tap "Top-3 slip" (the sheet seeds it into the betslip
playground). Same staking discipline as the Safe protocol above - flat small
stakes, never chase; a 10-leg ticket is entertainment, not a strategy.
```

- [x] **Step 2: CLAUDE.md — two one-liners**

In the `src/db/magic-rules.js` bullet, after the `SAFE_TIERS` / M3-additions prose, add one sentence:

```
**Sure bets (2026-07-17):** `DEFAULT_SURE_BETS` (`maxPerDay:10`, `slipSize:3`) + `sureBetsSelection(rows, cal, opts)` — ordered `[{row, prob}]`: safe-gated (`safeQualifies` on the caller's effective safe policy, so Sure bets ⊆ safe pool), ranked by `estimateLegProb` desc (NOT the `sure` strategy — its top ranks underperform, design replay), per-EAT-day cap, null-prob excluded; survival claim, never EV (`docs/superpowers/specs/2026-07-17-sure-bets-filter-design.md`).
```

In the `web/` bullet, after the Safe-only toggle prose, add one sentence:

```
**Sure bets (2026-07-17, signed-in only):** a ✨ Magic-sheet row (guests get a sign-in nudge) toggles `oddspro.show.sureBets` — membership cut by `api_id` over the whole loaded selection exactly like Safe-only, ViewPills chip "⭐ Sure bets (N of 10)" with an explicit zero-day warning, and a "Top-3 slip" action that seeds the top legs into the betslip book (`seedSlip` export in `BetslipPlayground.jsx` — the one owner of the `oddspro.betslips` format) and opens the playground.
```

- [x] **Step 3: Full suite + final browser pass**

Run: `npm test` — Expected: PASS (record the final count).
Re-verify on :5173: toggle on/off round-trips (persisted across reload), Safe-only + Sure bets together = AND (both pills visible), guest view clean. Do NOT rebuild `web/dist`.

- [x] **Step 4: Commit**

```powershell
git add docs/safety-net-protocol.md CLAUDE.md
git commit -m "docs: sure-bets section in safety-net protocol + CLAUDE.md notes"
```

- [x] **Step 5: Update this plan's checkboxes + the spec status line** (`Status: approved by user (conversation), implementation pending` → `implemented <date>, commits <hashes>`), commit with the docs commit above or as `docs(spec): mark sure-bets implemented`.
