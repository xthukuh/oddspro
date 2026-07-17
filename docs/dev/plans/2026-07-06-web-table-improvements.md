# Web Table Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the tip filter SQL error with client/server parity, surface derived sort values in cell tooltips, turn the Slips playground into a past-date backtester, and show a left-pinned magic score column while a ✨ strategy is active.

**Architecture:** Registry-driven filter semantics in `src/db/records.js` (a base field may declare a separate text target for `like`), mirrored in the pure client engine `web/src/filterValues.js`. Slip grading is a new pure helper in `src/db/magic-rules.js` (shared server/web module). All UI changes live in `DataTable.jsx` / `BetslipPlayground.jsx`. No new endpoints, no schema changes.

**Tech Stack:** Node ES modules, knex/MySQL, node:test (offline suites), React 19 + Vite 6 + Tailwind 4.

**Spec:** `docs/dev/specs/2026-07-06-web-table-improvements-design.md`

## Global Constraints

- 4-space indentation, single quotes, semicolons (workspace convention).
- Conventional Commits.
- Pure modules (`filterValues.js`, `magic-rules.js`) must stay dependency-free (no config/.env imports) so offline tests keep passing.
- `records.js` imports the DB pool — it is verified by live smoke queries, NOT added to the offline suite.
- Never break: existing filter behavior for non-tip fields, existing slip localStorage shape compatibility (old entries degrade gracefully), the "exactly one ordering mechanism" invariant (magic vs column sort).

---

### Task 1: Server tip filter — `like_sql` target + NaN guard

**Files:**
- Modify: `src/db/records.js:35` (BASE_FIELDS.tip), `:98-115` (_sqlTarget), `:127-131` (_coerce), `:169-185` (filter loop call sites)

**Interfaces:**
- Produces: `BASE_FIELDS.<key>.like_sql` (optional string) — text SQL target used only for `like` conditions. `_coerce(key, value, op)` — throws `TypeError` for unparsable numeric input under comparison ops; returns `String(value)` for `like`.
- Consumes: existing `FILTER_OPS`, `COL_OPS`, the server error handler mapping `TypeError` → 400 (`src/server.js:153`).

- [x] **Step 1: Write the failing smoke script**

Create `C:\Users\User\AppData\Local\Temp\claude\D--Apps-lab-oddspro\9a8a5e07-d8f1-49cb-9433-4a5de72fd115\scratchpad\tip-filter-smoke.mjs` (scratchpad, NOT the repo):

```js
import { queryRecords } from 'file:///D:/Apps/lab/oddspro/src/db/records.js';
import { db } from 'file:///D:/Apps/lab/oddspro/src/db/connection.js';

let fail = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    if (!ok) fail++;
};

// 1. like on tip matches the tip market TEXT
const like = await queryRecords({ date: '2026-07-05', filters: [{ key: 'tip', op: 'like', value: 'O 2.5' }], per_page: 'all' });
check('tip like "O 2.5" returns rows', like.total > 0, `total=${like.total}`);
check('every row tips O 2.5', like.data.every(r => r.tip_market?.includes('O 2.5')));

// 2. numeric comparison still targets confidence
const gte = await queryRecords({ date: '2026-07-05', filters: [{ key: 'tip', op: 'gte', value: '0.7' }], per_page: 'all' });
check('tip gte 0.7 returns rows', gte.total > 0, `total=${gte.total}`);
check('every row confidence >= 0.7', gte.data.every(r => r.tip_confidence >= 0.7));

// 3. non-numeric comparison value -> clean TypeError, never SQL error
try {
    await queryRecords({ date: '2026-07-05', filters: [{ key: 'tip', op: 'eq', value: 'O 2.5' }] });
    check('tip eq "O 2.5" throws TypeError', false, 'no error thrown');
} catch (e) {
    check('tip eq "O 2.5" throws TypeError', e instanceof TypeError && !/Unknown column/.test(e.message), e.message.substring(0, 80));
}

// 4. same guard for other numeric fields
try {
    await queryRecords({ date: '2026-07-05', filters: [{ key: 'goals', op: 'gt', value: 'abc' }] });
    check('goals gt "abc" throws TypeError', false, 'no error thrown');
} catch (e) {
    check('goals gt "abc" throws TypeError', e instanceof TypeError, e.message.substring(0, 80));
}

// 5. unchanged behaviors: like on a numeric field, market price filter
const glike = await queryRecords({ date: '2026-07-05', filters: [{ key: 'goals', op: 'like', value: '3' }], per_page: 'all' });
check('goals like 3 still works', glike.data.every(r => String(r.goals).includes('3')), `total=${glike.total}`);
const mkt = await queryRecords({ date: '2026-07-05', filters: [{ key: 'O 2.5', op: 'lte', value: '1.6' }], per_page: 'all' });
check('market "O 2.5" lte 1.6 still works', mkt.data.every(r => r.markets['O 2.5'] == null || r.markets['O 2.5'] <= 1.6), `total=${mkt.total}`);

await db.destroy();
process.exit(fail ? 1 : 0);
```

- [x] **Step 2: Run it to verify it fails**

Run: `node "C:\Users\User\AppData\Local\Temp\claude\D--Apps-lab-oddspro\9a8a5e07-d8f1-49cb-9433-4a5de72fd115\scratchpad\tip-filter-smoke.mjs"`
Expected: FAIL lines — check 1 returns 0 rows (like against confidence), check 3 fails with `Unknown column 'NaN'` (not a TypeError).

- [x] **Step 3: Implement the registry + guard**

In `src/db/records.js`, change the `tip` entry (line 35):

```js
    // "Tip" column sorts/filters by its blended confidence (0..1); `like`
    // conditions match the tip market TEXT instead (what the cell displays)
    tip: { sql: 'fp.tip_confidence', like_sql: 'fp.tip_market', type: 'number' },
```

Make `_sqlTarget` op-aware (replace lines 96-115):

```js
// Resolve a sort/filter key to an orderable SQL target, adding a LEFT JOIN
// pivot subquery per referenced market column (one join per key, reused).
// `op` is the filter operator: a base field with a `like_sql` text target
// resolves there for `like` conditions (e.g. tip -> fp.tip_market).
function _sqlTarget(query, key, joined, op = null) {
    const base = BASE_FIELDS[key];
    if (base) {
        if (op === 'like' && base.like_sql) return base.like_sql;
        return base.raw ? db.raw(base.sql) : base.sql;
    }
    if (!isMarketKey(key)) return null;
    let alias = joined.get(key);
    if (!alias) {
        alias = `mk${joined.size}`;
        joined.set(key, alias);
        const sub = whereMarket(db('odds_markets'), key)
            .where('is_stale', 0) // dead odds never drive sort/filter
            .groupBy('match_id')
            .select('match_id')
            .min('price as price')
            .as(alias);
        query.leftJoin(sub, `${alias}.match_id`, 'm.id');
    }
    return `${alias}.price`;
}
```

Replace `_coerce` (lines 127-131):

```js
// Coerce a filter value by field type (market columns are numeric prices).
// `like` values stay text (string-contains works on any column); numeric
// comparisons reject unparsable input - mysql2 would otherwise serialize
// NaN as a bare SQL token ("Unknown column 'NaN'").
function _coerce(key, value, op) {
    const type = BASE_FIELDS[key]?.type ?? 'number';
    if (op === 'like' || type !== 'number') return String(value);
    const n = Number(value);
    if (Number.isNaN(n)) {
        throw new TypeError(`Invalid numeric filter value for ${key}: ${JSON.stringify(value)}`);
    }
    return n;
}
```

Update the two call sites in the filter loop (lines 169-185): the LHS target passes the op, and the coercion passes the op:

```js
    const joined = new Map();
    for (const f of Array.isArray(filters) ? filters : []) {
        const target = _sqlTarget(query, f?.key, joined, f?.op);
        if (!target) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
        if (f?.col != null) {
            // Column-to-column comparison: the RHS resolves like the LHS
            // (sharing market joins) and binds as an identifier (??), never
            // a value. SQL NULL semantics drop rows missing either side.
            const op = COL_OPS[f?.op];
            const rhs = _sqlTarget(query, f.col, joined);
            if (!op || !rhs) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
            query.where(target, op, typeof rhs === 'string' ? db.raw('??', [rhs]) : rhs);
        } else {
            const apply = FILTER_OPS[f?.op];
            if (!apply) throw new TypeError(`Invalid filter: ${JSON.stringify(f)}`);
            apply(query, target, _coerce(f.key, f.value, f.op));
        }
    }
```

(Sort call site `_sqlTarget(query, s?.key, joined)` stays unchanged — no op.)

- [x] **Step 4: Run the smoke script to verify it passes**

Run: `node "C:\Users\User\AppData\Local\Temp\claude\D--Apps-lab-oddspro\9a8a5e07-d8f1-49cb-9433-4a5de72fd115\scratchpad\tip-filter-smoke.mjs"`
Expected: all `PASS`, exit 0.

- [x] **Step 5: Run the offline suite (regression gate)**

Run: `npm test`
Expected: all tests pass (records.js is not in the suite; this guards accidental import breakage).

- [x] **Step 6: Commit**

```bash
git add src/db/records.js
git commit -m "fix: tip filter targets market text for like, rejects NaN comparisons"
```

---

### Task 2: Client filter parity — tip `like` matches tip market text

**Files:**
- Modify: `web/src/filterValues.js:55-61` (_raw)
- Test: `tests/filter-values.test.js`

**Interfaces:**
- Consumes: `applyClientFilters(rows, filters, columns)` (existing), `sortValue` tip extractor (confidence + hot bonus — unchanged).
- Produces: `like` on key `tip` matches `row.tip_market` text, mirroring the server's `like_sql`.

- [x] **Step 1: Write the failing test**

Append to `tests/filter-values.test.js`:

```js
test('tip: like matches the tip market text, comparisons use confidence', () => {
    const rows = [
        row({ tip_market: 'O 2.5', tip_confidence: 0.8 }),
        row({ tip_market: '1X', tip_confidence: 0.6 }),
        row({ tip_market: null, tip_confidence: null }),
    ];
    const cols = [...COLUMNS, { key: 'tip', group: 'base' }];
    // contains matches what the cell displays (server parity: fp.tip_market)
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'tip', op: 'like', value: 'o 2' }], cols).map(r => r.tip_market),
        ['O 2.5']);
    // numeric ops keep comparing the blended confidence
    assert.deepEqual(
        applyClientFilters(rows, [{ key: 'tip', op: 'gte', value: '0.7' }], cols).map(r => r.tip_market),
        ['O 2.5']);
    // tipless rows never match either form
    assert.equal(applyClientFilters(rows, [{ key: 'tip', op: 'like', value: '' }], cols).length, 2);
});
```

- [x] **Step 2: Run it to verify it fails**

Run: `node --test tests/filter-values.test.js`
Expected: FAIL — the `like 'o 2'` assertion returns `[]` (reads nonexistent `row.tip`).

- [x] **Step 3: Implement the extractor**

In `web/src/filterValues.js`, replace `_raw` (lines 55-61):

```js
// Raw (displayed) value for `like`: the underlying field text, so e.g.
// `home_form like WWW` matches the letters, not the derived points. The
// tip column's text is its market pick (server parity: like -> tip_market).
function _raw(row, col) {
    if (col.key === 'tip') return row.tip_market ?? null;
    if (col.group === 'market') return row.markets?.[col.key] ?? null;
    if (col.key.startsWith('fs:')) return row.stats?.[col.key] ?? null;
    return row[col.key] ?? null;
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/filter-values.test.js`
Expected: PASS (all tests, including the new one).

- [x] **Step 5: Commit**

```bash
git add web/src/filterValues.js tests/filter-values.test.js
git commit -m "fix: client tip like filter matches tip market text (server parity)"
```

---

### Task 3: Sort-value cell tooltips

**Files:**
- Modify: `web/src/components/DataTable.jsx:7-8` (imports), `:164-172` (_cellTitle)

**Interfaces:**
- Consumes: `sortValue(row, col)` from `web/src/sortValues.js` (existing export).
- Produces: display-only tooltip line; no exports.

- [x] **Step 1: Implement the tooltip hint**

In `web/src/components/DataTable.jsx`, extend the sortValues import (line 8):

```js
import { sortRows, sortValue } from '../sortValues.js';
```

Replace `_cellTitle` (lines 164-172) with:

```js
// Columns whose sort value is DERIVED from the displayed text (form ->
// points, "gf/ga (avg)" -> avg, score -> total goals, tip -> confidence +
// hot bonus, fs: stats -> H+A sum). Plain numbers, dates and odds prices
// are skipped - the display IS the value.
const SORT_HINT_KEYS = new Set(['score', 'tip', 'home_form', 'away_form', 'h2h',
    'home_goals_h2h', 'away_goals_h2h', 'home_goals_oth', 'away_goals_oth']);

// "⇅ sorts as: <derived value>" - the exact value sorting/filtering uses
// (same sortValue call), so the hint can never disagree with the ordering.
function _sortHint(row, col) {
    if (!SORT_HINT_KEYS.has(col.key) && !col.key.startsWith('fs:')) return null;
    const v = sortValue(row, col);
    if (v == null) return null;
    return `⇅ sorts as: ${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}`;
}

function _cellTitle(row, col) {
    const fn = CELL_TITLES[col.key];
    const base = fn
        ? fn(row)
        : col.group === 'market'
            ? _marketInfo(col.key)
            : col.key.startsWith('fs:') && row.stats?.[col.key] != null
                ? 'Home / Away - post-match statistic'
                : null;
    const hint = _sortHint(row, col);
    return [base, hint].filter(Boolean).join('\n') || undefined;
}
```

- [x] **Step 2: Build to verify**

Run: `npm run build:web`
Expected: vite build succeeds, no errors.

- [x] **Step 3: Commit**

```bash
git add web/src/components/DataTable.jsx
git commit -m "feat: cell tooltips surface the derived sort value"
```

---

### Task 4: `slipOutcome` pure helper

**Files:**
- Modify: `src/db/magic-rules.js` (insert after `slipSummary`, line 256)
- Test: `tests/magic-rules.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `slipOutcome(legs)` where legs carry optional `outcome: 'hit' | 'miss' | null` →
  `{ state: 'won' | 'lost' | 'open', settled: number, total: number, broken: number[] }`
  (`broken` = api_ids of missed legs, `[]` unless lost; empty slip = open 0/0).

- [x] **Step 1: Write the failing tests**

Append to `tests/magic-rules.test.js` (match its existing import line — add `slipOutcome` to the import list from `../src/db/magic-rules.js`):

```js
test('slipOutcome: all legs hit -> won', () => {
    const legs = [
        { api_id: 1, outcome: 'hit' },
        { api_id: 2, outcome: 'hit' },
    ];
    assert.deepEqual(slipOutcome(legs), { state: 'won', settled: 2, total: 2, broken: [] });
});

test('slipOutcome: any miss -> lost immediately, names the broken legs', () => {
    const legs = [
        { api_id: 1, outcome: 'hit' },
        { api_id: 2, outcome: 'miss' },
        { api_id: 3, outcome: null }, // pending leg cannot save a broken slip
    ];
    assert.deepEqual(slipOutcome(legs), { state: 'lost', settled: 2, total: 3, broken: [2] });
});

test('slipOutcome: pending legs stay open; legacy legs without outcome are pending', () => {
    assert.deepEqual(
        slipOutcome([{ api_id: 1, outcome: 'hit' }, { api_id: 2 }]),
        { state: 'open', settled: 1, total: 2, broken: [] });
    assert.deepEqual(slipOutcome([]), { state: 'open', settled: 0, total: 0, broken: [] });
    assert.deepEqual(slipOutcome(null), { state: 'open', settled: 0, total: 0, broken: [] });
});
```

- [x] **Step 2: Run to verify failure**

Run: `node --test tests/magic-rules.test.js`
Expected: FAIL — `slipOutcome` is not exported.

- [x] **Step 3: Implement**

In `src/db/magic-rules.js`, insert after `slipSummary` (after line 256):

```js
// Grade a slip from its legs' settled tip outcomes (backtest mode): every
// leg hit -> won; any miss -> lost (a pending leg cannot save it); else
// open. Legacy stored legs without an `outcome` field count as pending.
export function slipOutcome(legs) {
    const list = Array.isArray(legs) ? legs : [];
    let settled = 0;
    const broken = [];
    for (const leg of list) {
        if (leg?.outcome === 'hit') settled++;
        else if (leg?.outcome === 'miss') { settled++; broken.push(leg.api_id); }
    }
    const state = broken.length ? 'lost' : (list.length && settled === list.length ? 'won' : 'open');
    return { state, settled, total: list.length, broken };
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `node --test tests/magic-rules.test.js`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/db/magic-rules.js tests/magic-rules.test.js
git commit -m "feat: slipOutcome pure helper grades slips from settled legs"
```

---

### Task 5: Slips backtest — settled candidates + slip grading UI

**Files:**
- Modify: `web/src/components/BetslipPlayground.jsx` (imports line 2, candidates memo lines 51-66, candidates header line 152, candidate rows lines 155-177, leg rows lines 222-241, summary line lines 245-256)

**Interfaces:**
- Consumes: `slipOutcome(legs)` from Task 4; candidate/leg objects gain `outcome: 'hit' | 'miss' | null`.
- Produces: UI only. localStorage legs now persist `outcome`; old entries (no field) degrade to pending.

- [x] **Step 1: Widen the candidate gate and carry outcomes**

Import `slipOutcome` (line 2):

```js
import { estimateLegProb, magicSortRows, slipOutcome, slipSummary, tipView } from '../../../src/db/magic-rules.js';
```

Replace the candidates memo (lines 51-66):

```js
    // Slip candidates: the table's non-vetoed tips - one per canonical
    // fixture - ranked by the active magic strategy. Settled tips are
    // included (backtest mode: past dates replay at their frozen tip
    // prices); their outcome grades the slip.
    const candidates = useMemo(() => {
        const seen = new Set();
        const unique = [];
        for (const r of rows) {
            if (seen.has(r.api_id)) continue;
            seen.add(r.api_id);
            if (r.tip_market != null && r.tip_ai_verdict !== 'veto') unique.push(r);
        }
        return magicSortRows(unique, magic?.id ?? 'confidence', magic?.calibration ?? calibration).map(r => ({
            api_id: r.api_id,
            fixture: r.fixture,
            market: r.tip_market,
            price: r.tip_price,
            prob: estimateLegProb(tipView(r), calibration),
            outcome: r.tip_outcome ?? null,
        }));
    }, [rows, magic, calibration]);
```

- [x] **Step 2: Show outcomes in the candidate list and update its header**

Header (line 151-153) — the count is no longer pending-only:

```js
                        <h3 className="text-sm font-medium text-slate-700 mb-1">
                            Tips <span className="text-slate-400 font-normal">({candidates.length}, best first{magic ? ' · magic' : ''})</span>
                        </h3>
```

In each candidate row, insert the outcome mark right after the price span (after line 174):

```js
                                    <span className="tabular-nums">{c.price?.toFixed(2) ?? '—'}</span>
                                    {c.outcome === 'hit' && <span className="text-emerald-600 font-bold">✓</span>}
                                    {c.outcome === 'miss' && <span className="text-rose-600 font-bold">✗</span>}
                                    <span className="tabular-nums text-slate-500" title="Calibrated win estimate">{_pct(c.prob)}</span>
```

- [x] **Step 3: Grade slips — verdict line + leg outcome marks**

Inside the `slips.map(slip => …)` render (line 188), compute the verdict next to the existing summary:

```js
                                const sum = slipSummary(slip.legs, config.stake);
                                const verdict = slipOutcome(slip.legs);
                                const over = slip.legs.length > config.maxLegs;
                                const under = slip.legs.length > 0 && sum.odds < config.minOdds;
```

In each leg row (lines 222-241), mark outcomes and highlight broken legs — replace the leg row block with:

```js
                                        {slip.legs.map(l => (
                                            <div
                                                key={l.api_id}
                                                className={`flex items-center gap-2 text-xs py-0.5 ${live.has(l.api_id) ? '' : 'opacity-50'} ${
                                                    verdict.broken.includes(l.api_id) ? 'text-rose-600' : ''}`}
                                            >
                                                <span className="truncate grow" title={l.fixture}>{l.fixture}</span>
                                                {!live.has(l.api_id) && (
                                                    <span className="text-amber-600" title="No longer a tip on this view">gone</span>
                                                )}
                                                <span className="font-medium whitespace-nowrap">{l.market}</span>
                                                <span className="tabular-nums">{l.price?.toFixed(2) ?? '—'}</span>
                                                {l.outcome === 'hit' && <span className="text-emerald-600 font-bold">✓</span>}
                                                {l.outcome === 'miss' && <span className="text-rose-600 font-bold">✗</span>}
                                                <span className="tabular-nums text-slate-500">{_pct(l.prob)}</span>
                                                <button
                                                    onClick={() => removeLeg(slip.id, l.api_id)}
                                                    className="cursor-pointer text-slate-400 hover:text-red-600"
                                                >
                                                    &times;
                                                </button>
                                            </div>
                                        ))}
```

Add the verdict to the summary line (insert as FIRST children of the summary flex div, before the odds span, line 245):

```js
                                        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 pt-1 border-t border-slate-100 text-xs tabular-nums">
                                            {verdict.state === 'won' && (
                                                <span className="text-emerald-700 font-semibold">WON · paid {sum.payout.toFixed(2)}</span>
                                            )}
                                            {verdict.state === 'lost' && (
                                                <span className="text-rose-600 font-semibold">
                                                    LOST · {verdict.broken.length} leg{verdict.broken.length > 1 ? 's' : ''} broke it
                                                </span>
                                            )}
                                            {verdict.state === 'open' && verdict.settled > 0 && (
                                                <span className="text-slate-500">alive · {verdict.settled}/{verdict.total} settled</span>
                                            )}
                                            <span>odds <b>{sum.odds.toFixed(2)}</b></span>
```

(The rest of the summary line — payout/survival/EV/warnings — stays exactly as is.)

- [x] **Step 4: Build to verify**

Run: `npm run build:web`
Expected: vite build succeeds.

- [x] **Step 5: Commit**

```bash
git add web/src/components/BetslipPlayground.jsx
git commit -m "feat: betslip playground backtests past dates - settled tips grade slips"
```

---

### Task 6: Magic values column (left-pinned, beside Tip)

**Files:**
- Modify: `web/src/components/DataTable.jsx` (import line 11, component body around lines 306-374, header render lines 387-419, cell render lines 428-439)

**Interfaces:**
- Consumes: `scoreTip(row, strategyId, cal)`, `STRATEGIES` from `src/db/magic-rules.js` (existing exports); the `magic` prop `{ id, calibration } | null` (existing).
- Produces: UI only — synthetic column key `'magic'`, never part of the settings catalog or persisted column order.

- [x] **Step 1: Import the scorer surface**

Line 11 becomes:

```js
import { magicSortRows, scoreTip, STRATEGIES } from '../../../src/db/magic-rules.js';
```

- [x] **Step 2: Compute per-fixture rank + score, inject the column**

After the `sorted` memo (line 329), add:

```js
    // Magic column data: rank per unique fixture (provider rows share it)
    // in the magic order, plus the raw strategy score. Null score = tipless/
    // vetoed row - shows an em dash and shares the sunk tail.
    const magicMeta = useMemo(() => {
        if (!magic) return null;
        const label = STRATEGIES.find(s => s.id === magic.id)?.label ?? magic.id;
        const info = new Map(); // api_id -> { rank, score } | null
        let n = 0;
        for (const row of sorted) {
            if (info.has(row.api_id)) continue;
            const score = scoreTip(row, magic.id, magic.calibration);
            info.set(row.api_id, score == null ? null : { rank: ++n, score });
        }
        return { label, info };
    }, [magic, sorted]);

    // While magic is active a synthetic score column sits immediately left
    // of Tip (ephemeral: not in the catalog, order persistence or settings).
    const displayColumns = useMemo(() => {
        if (!magicMeta) return columns;
        const col = { key: 'magic', label: '✨', group: 'base' };
        const i = columns.findIndex(c => c.key === 'tip');
        return i < 0 ? [...columns, col] : [...columns.slice(0, i), col, ...columns.slice(i)];
    }, [columns, magicMeta]);
```

Then switch the pin pipeline onto `displayColumns` and add `'magic'` to the pin keys — replace `const PIN_KEYS = ['score', 'tip'];` (line 343) with:

```js
    const PIN_KEYS = ['score', 'magic', 'tip'];
```

and replace the two uses of `columns` in the pin assembly (lines 369-374) with `displayColumns`:

```js
    let pinLeft = 0;
    const pins = displayColumns.filter(c => pinState[c.key]).map(c => {
        const p = { ...c, pin: true, left: pinLeft };
        pinLeft += pinThRefs.current[c.key]?.offsetWidth ?? 0;
        return p;
    });
    const pinned = pins.length ? [...pins, ...displayColumns] : displayColumns;
```

(The `sorted` memo keeps using `columns` — the synthetic column never drives sorting.)

- [x] **Step 3: Header — ✨ label, no sort, no magic-clear**

In the header `<th>` render (lines 399-418), the magic column must not trigger `onSort` (which clears magic). Change the `onClick` and `title` attributes:

```js
                                    onClick={col.key === 'magic' ? undefined : e => onSort(col.key, e.shiftKey)}
```

and the title expression:

```js
                                    title={col.key === 'magic'
                                        ? `Magic sort: ${magicMeta?.label} - #rank · strategy score`
                                        : `${info ? `${info}\n` : ''}${meta?.short ? `${col.label}\n` : ''}Click to sort (desc first) - shift-click for multi-sort`}
```

Also drop the pointer cursor for the magic header — the className `cursor-pointer hover:bg-slate-100` part becomes conditional:

```js
                                    className={`${sticky} bg-slate-50 px-2 py-1.5 font-medium ${col.key === 'magic' ? '' : 'cursor-pointer hover:bg-slate-100'} ${col.group === 'market' ? 'text-center' : ''}`}
```

- [x] **Step 4: Cell — `#rank · score`**

Add a module-level cell renderer next to `_marketCell` (after line 292):

```js
// Magic column cell: the row's rank under the active strategy + its raw
// score (strategies keep their native scales - no fake percentages).
function _magicCell(row, meta) {
    const m = meta?.info.get(row.api_id);
    if (!m) return <span className="text-slate-300">—</span>;
    return <span className="tabular-nums whitespace-nowrap">#{m.rank} · {m.score.toFixed(3)}</span>;
}
```

In the body cell render (line 437), branch on the magic key:

```js
                                    {col.key === 'magic' ? _magicCell(row, magicMeta)
                                        : col.group === 'market' ? _marketCell(row, col.key)
                                        : _cell(row, col.key, links, openTip)}
```

- [x] **Step 5: Build + offline suite**

Run: `npm run build:web && npm test`
Expected: build succeeds; all tests pass.

- [x] **Step 6: Commit**

```bash
git add web/src/components/DataTable.jsx
git commit -m "feat: left-pinned magic score column (#rank · score) while a strategy is active"
```

---

### Task 7: End-to-end verification + docs

**Files:**
- Modify: `docs/dev/implementation-plan.md` (progress tracking), `docs/memory-bank.md` (if present)

- [x] **Step 1: Full test suite + build**

Run: `npm test && npm run build:web`
Expected: everything green.

- [x] **Step 2: Live smoke via the API**

Restart the serve process (stale :3001 holds old code), then:

```bash
curl -s "http://127.0.0.1:3001/api/records?date=2026-07-05&per_page=all&filters=%5B%7B%22key%22%3A%22tip%22%2C%22op%22%3A%22like%22%2C%22value%22%3A%22O%202.5%22%7D%5D" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('total',j.total,'all O 2.5:',j.data.every(r=>r.tip_market?.includes('O 2.5')))})"
```

Expected: `total <n> all O 2.5: true`.

```bash
curl -s "http://127.0.0.1:3001/api/records?date=2026-07-05&filters=%5B%7B%22key%22%3A%22tip%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22O%202.5%22%7D%5D" -o /dev/null -w "%{http_code}\n"
```

Expected: `400` (clean client error, not 500).

- [x] **Step 3: Browser sanity check (dev server or built app)**

Open the app on a PAST date (e.g. `?date=2026-07-04`) and verify:
- Filters: `tip contains O 2.5` narrows rows; `tip ≥ 0.7` narrows by confidence; `tip = abc` shows the 400 error banner (not a crash).
- Hover a form cell (`WWDLW`) → tooltip ends with `⇅ sorts as: <points>`.
- Slips: candidates list settled tips with ✓/✗; "Fill from top" builds a slip; the card shows WON + payout or LOST + broken legs.
- Magic: pick a ✨ strategy → the ✨ column appears left of Tip showing `#rank · score`; scroll right → Score/✨/Tip pin left in order; clicking ✨ header does nothing; clicking any other header clears magic and removes the column.
- Clean up any browser instance / dev-server process started for this check.

- [x] **Step 4: Update progress docs + commit**

Append a Phase 16 entry to `docs/dev/implementation-plan.md` mirroring the existing phase-entry style (filter parity + tip fix, sort tooltips, slips backtest, magic column) and note it in `docs/memory-bank.md` if that file exists.

```bash
git add docs/dev/implementation-plan.md docs/memory-bank.md
git commit -m "docs: phase 16 web table improvements (filter parity, sort hints, slips backtest, magic column)"
```

---

## Self-Review Notes

- **Spec coverage:** §1 → Tasks 1+2; §2 → Task 3; §3 → Tasks 4+5; §4 → Task 6; verification → Task 7. No gaps.
- **Type consistency:** `slipOutcome` return shape (Task 4 tests ↔ Task 5 usage: `verdict.state/broken/settled/total`) matches. `_sqlTarget(query, key, joined, op)` signature matches call sites. Candidate `outcome` field name matches leg render usage.
- **Placeholder scan:** none — every code step carries the full code.
