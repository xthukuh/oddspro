# All-Markets Coverage — M2 (Surface Everything) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface **all** stored bookmaker markets (not just the canonical ~20) in the web table, filters, sort, export and settings — generically discovered from `odds_markets`, cross-provider-unified, with a cardinality guard — without changing prediction behavior.

**Architecture:** Add a **parallel generic market path** alongside the existing fixed registry. `src/markets.js` gains `canonicalMarket(row)` (any provider row → `{key, group, label, columnizable}`), `marketIdentity(key)` (key → SQL WHERE spec) and a `MARKET_FAMILIES` table; the existing `marketKey`/`whereMarket`/`MARKET_COLUMNS` stay untouched so the prediction pipeline (`hotpicks._loadMarkets`, `magic-rules` calibration) is unaffected. `records.js` discovers markets from data (like it already does for `providers`/`stats`), pivots via `canonicalMarket`, and builds sort/filter WHEREs via `marketIdentity`. The frontend is already catalog-driven; changes are a grouped/searchable market picker, a tooltip glossary, and promoting BTTS+DNB to default.

**Tech Stack:** Node.js ES modules (4-space indent), knex/mysql2, zod; React 19 + Vite 6 + Tailwind 4; `node:test` (offline, no DB/live APIs).

## Global Constraints

- ES modules, `async/await`, **4-space indentation**, single quotes, semicolons.
- Match markets by `type_name`, **never `type_id`** (betika reuses ids).
- Never break the existing canonical keys (`1,X,2,1X,X2,12,U/O lines`) — the DB base columns, `magic-rules` calibration cells, and `perf-rules.marketGroup` depend on them.
- Prediction/tip behavior must be **unchanged** by M2 (this plan). New markets are display/filter/sort/export only; tipping on them is M3.
- Tests are offline (no DB, no live APIs); DB-touching behavior is validated with a disconnected knex builder (`knex({client:'mysql2'})`) as `tests/markets.test.js` already does.
- Canonical markets stay the default columns **plus BTTS + DNB** (per spec §9 decision 1); everything else is opt-in.
- Cross-provider unification is preserved: BetPawa and Betika spellings of the same market resolve to one key.

---

## File Structure

- `src/markets.js` — **modify.** Add `MARKET_FAMILIES` (the taxonomy), `canonicalMarket(row)`, `marketIdentity(key)`, `discoverMarketColumns(rows)`. Keep `MARKET_COLUMNS`, `marketKey`, `whereMarket`, `isMarketKey` as-is (backward compat).
- `src/db/records.js` — **modify.** `columnCatalog()` discovers markets from `odds_markets`; `_sqlTarget()` resolves any discovered key via `marketIdentity`; `_hydrate()` pivots via `canonicalMarket`.
- `tests/markets.test.js` — **modify.** Keep existing canonical assertions; add property tests for `canonicalMarket` (unification, passthrough, `type_name`-not-`type_id`, columnizable) and `marketIdentity` round-trip.
- `tests/market-identity.test.js` — **create.** Focused tests for `marketIdentity` WHERE generation on discovered + raw keys.
- `web/src/components/SettingsModal.jsx`, `web/src/components/FilterBuilder.jsx` — **modify.** Group the market list by `group`; add a search box.
- `web/src/components/DataTable.jsx` — **modify.** Extend the market tooltip glossary to read `label`/`group` from the catalog instead of the hardcoded `MARKET_INFO` map.

---

## Task 1: Market taxonomy + `canonicalMarket` (src/markets.js)

**Files:**
- Modify: `src/markets.js` (append; do not touch lines 14-76)
- Test: `tests/markets.test.js`

**Interfaces:**
- Produces: `MARKET_FAMILIES: {group, typeNames:string[], columnizable:'column'|'grouped'|'filter-only', resolve(row)->{key,label}|null}[]`; `canonicalMarket(row)->{key,group,label,columnizable}` (never null — unknown rows return a `raw:` passthrough).
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test** (append to `tests/markets.test.js`)

```javascript
import { canonicalMarket } from '../src/markets.js';

test('canonicalMarket unifies provider spellings and passes through unknowns', () => {
    // canonical families keep their existing keys + carry a group + columnizable
    assert.deepEqual(canonicalMarket({ type_name: '1X2 | Full Time', name: '1' }),
        { key: '1', group: 'result', label: '1', columnizable: 'column' });
    assert.equal(canonicalMarket({ type_name: '1X2', name: '2' }).key, '2'); // betika unifies
    // BTTS + DNB become first-class columns
    assert.deepEqual(canonicalMarket({ type_name: 'Both Teams To Score | Full Time', name: 'Yes' }),
        { key: 'GG', group: 'btts', label: 'BTTS Yes', columnizable: 'column' });
    assert.equal(canonicalMarket({ type_name: 'Draw No Bet | Full Time', name: '1' }).key, 'DNB1');
    // huge-cardinality market -> filter-only, never a column, still a deterministic key
    const cs = canonicalMarket({ type_name: 'Correct Score | Full Time', name: '2:1' });
    assert.equal(cs.columnizable, 'filter-only');
    assert.equal(cs.group, 'correct_score');
    // wholly unknown market -> raw passthrough (never null, never dropped)
    const raw = canonicalMarket({ type_name: 'Some New Market X', name: 'Whatever' });
    assert.match(raw.key, /^raw:/);
    assert.equal(raw.columnizable, 'filter-only');
    // type_name, not type_id (betika reuses id 19)
    assert.equal(canonicalMarket({ type_id: 19, type_name: 'Z.PSV TOTAL', name: 'OVER 2.5', handicap: 2.5 }).group, 'other');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/markets.test.js`
Expected: FAIL — `canonicalMarket` is not exported.

- [ ] **Step 3: Implement `MARKET_FAMILIES` + `canonicalMarket`** (append to `src/markets.js`)

Build the family table from the DB inventory (`tmp/market-inventory.txt`, both providers). Each family declares its provider `type_name` spellings, a `columnizable` class, and a `resolve(row)`. Reuse the existing `marketKey` for the three canonical families so their keys stay identical. Full implementation:

```javascript
// --- Generic market taxonomy (M2) --------------------------------------------
// Parallel to the fixed MARKET_COLUMNS registry above: covers ALL stored markets
// for display/filter/sort. Does NOT feed predictions (that's M3). Keyed on
// type_name (never type_id). `columnizable`: 'column' = table-column eligible,
// 'grouped' = medium cardinality (detail view), 'filter-only' = huge/props.
const _norm = s => String(s ?? '').trim();
const _slug = s => _norm(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export const MARKET_FAMILIES = [
    { group: 'result', columnizable: 'column',
      typeNames: X12_TYPE_NAMES,
      resolve: row => (['1', 'X', '2'].includes(_norm(row.name)) ? { key: _norm(row.name), label: _norm(row.name) } : null) },
    { group: 'double_chance', columnizable: 'column',
      typeNames: DC_TYPE_NAMES,
      resolve: row => { const k = DC_NAME_MAP[_norm(row.name)]; return k ? { key: k, label: k } : null; } },
    { group: 'over_under', columnizable: 'column',
      typeNames: OU_TYPE_NAMES,
      resolve: row => { const k = marketKey(row); return k ? { key: k, label: k } : null; } },
    { group: 'btts', columnizable: 'column',
      typeNames: ['Both Teams To Score | Full Time', 'GG/NG', 'BOTH TEAMS TO SCORE (GG/NG)', 'Both Teams To Score'],
      resolve: row => { const y = /^(yes|gg)$/i.test(_norm(row.name)); const n = /^(no|ng)$/i.test(_norm(row.name));
          return y ? { key: 'GG', label: 'BTTS Yes' } : n ? { key: 'NG', label: 'BTTS No' } : null; } },
    { group: 'dnb', columnizable: 'column',
      typeNames: ['Draw No Bet | Full Time', 'DRAW NO BET', 'Draw No Bet'],
      resolve: row => { const n = _norm(row.name); return (n === '1' || n === '2')
          ? { key: `DNB${n}`, label: `DNB ${n}` } : null; } },
    { group: 'odd_even', columnizable: 'column',
      typeNames: ['Odd/Even | Full Time', 'ODD/EVEN'],
      resolve: row => { const o = /odd/i.test(_norm(row.name)); const e = /even/i.test(_norm(row.name));
          return o ? { key: 'ODD', label: 'Odd' } : e ? { key: 'EVEN', label: 'Even' } : null; } },
    { group: 'ht_ft', columnizable: 'grouped',
      typeNames: ['Half Time/Full Time', 'HT/FT'],
      resolve: row => ({ key: `HTFT:${_slug(row.name)}`, label: `HT/FT ${_norm(row.name)}` }) },
    { group: 'correct_score', columnizable: 'filter-only',
      typeNames: ['Correct Score | Full Time', 'Correct Score | First Half', 'Correct Score | Second Half', 'CORRECT SCORE'],
      resolve: row => ({ key: `CS:${_slug(row.name)}`, label: `Correct Score ${_norm(row.name)}` }) },
];

const _FAMILY_BY_TYPE = new Map();
for (const fam of MARKET_FAMILIES) for (const tn of fam.typeNames) _FAMILY_BY_TYPE.set(tn, fam);

// Any provider odds_markets row -> a stable canonical market descriptor.
// Never returns null: an unrecognized market becomes a deterministic `raw:` key
// (filter-only) so it is visible/queryable and never silently dropped.
export function canonicalMarket(row) {
    const fam = _FAMILY_BY_TYPE.get(_norm(row.type_name));
    if (fam) {
        const r = fam.resolve(row);
        if (r) return { key: r.key, group: fam.group, label: r.label, columnizable: fam.columnizable };
    }
    const hc = Number.isFinite(Number(row.handicap)) && row.handicap != null ? `:${Number(row.handicap)}` : '';
    return {
        key: `raw:${_slug(row.type_name)}:${_slug(row.name)}${hc}`,
        group: 'other',
        label: `${_norm(row.type_name)} — ${_norm(row.name)}${hc ? ` (${Number(row.handicap)})` : ''}`,
        columnizable: 'filter-only',
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/markets.test.js`
Expected: PASS (existing canonical tests + the new `canonicalMarket` test).

- [ ] **Step 5: Commit**

```bash
git add src/markets.js tests/markets.test.js
git commit -m "feat(markets): generic canonicalMarket taxonomy (M2) alongside the fixed registry"
```

---

## Task 2: `marketIdentity(key)` — generic SQL WHERE spec (src/markets.js)

**Files:**
- Modify: `src/markets.js`
- Test: `tests/market-identity.test.js` (create)

**Interfaces:**
- Consumes: `MARKET_FAMILIES`, `canonicalMarket` (Task 1); existing `whereMarket`.
- Produces: `marketIdentity(qb, key)` — applies a WHERE selecting the odds_markets rows for `key` (canonical, family, or `raw:`), the generic replacement for `whereMarket` used by the read layer. Returns `qb`.

- [ ] **Step 1: Write the failing test** (`tests/market-identity.test.js`)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { marketIdentity } from '../src/markets.js';

test('marketIdentity builds type_name WHEREs for canonical, family and raw keys', async t => {
    const kx = knex({ client: 'mysql2' });
    t.after(() => kx.destroy());
    // canonical delegates to the existing builder
    assert.match(marketIdentity(kx('odds_markets'), '1').toString(), /`type_name` in \('1X2 \| Full Time', '1X2'\)/);
    // BTTS family
    const gg = marketIdentity(kx('odds_markets'), 'GG').toString();
    assert.match(gg, /`type_name` in/);
    assert.match(gg, /LOWER\(name\) (LIKE 'yes%'|LIKE 'gg%'|in)/i);
    // raw passthrough decodes back to type_name + name
    const raw = marketIdentity(kx('odds_markets'), 'raw:winning-margin:home-by-1').toString();
    assert.match(raw, /type_name/);
    // never type_id
    for (const k of ['1', 'GG', 'raw:winning-margin:home-by-1'])
        assert.doesNotMatch(marketIdentity(kx('odds_markets'), k).toString(), /type_id/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/market-identity.test.js`
Expected: FAIL — `marketIdentity` not exported.

- [ ] **Step 3: Implement `marketIdentity`** (append to `src/markets.js`)

```javascript
// Reverse map: canonical/family key -> the family that owns it (for WHERE building).
// Built by probing each family's resolve() over its own declared spellings is
// overkill; instead we branch: canonical keys reuse whereMarket; family keys
// filter by the family's typeNames + a name predicate; raw keys decode the slug.
const _COLUMN_FAMILY_KEYS = new Map(); // key -> {typeNames, namePred(qb)}
MARKET_FAMILIES.filter(f => f.group === 'btts' || f.group === 'dnb' || f.group === 'odd_even')
    .forEach(f => { /* populated lazily below via marketIdentity switch */ });

export function marketIdentity(qb, key) {
    // 1) Canonical keys: reuse the proven builder (unchanged behavior).
    if (isMarketKey(key)) return whereMarket(qb, key);
    // 2) Raw passthrough: raw:<type_slug>:<name_slug>[:<handicap>]
    if (key.startsWith('raw:')) {
        const parts = key.split(':');
        const typeSlug = parts[1], nameSlug = parts[2], hc = parts[3];
        qb.whereRaw('LOWER(REPLACE(REPLACE(type_name, " ", "-"), "|", "-")) LIKE ?', [`%${typeSlug}%`])
          .whereRaw('LOWER(REPLACE(name, " ", "-")) LIKE ?', [`%${nameSlug}%`]);
        if (hc != null) qb.where('handicap', Number(hc));
        return qb;
    }
    // 3) Named families with small closed keysets.
    const FAM = {
        GG:  { types: ['Both Teams To Score | Full Time', 'GG/NG', 'BOTH TEAMS TO SCORE (GG/NG)', 'Both Teams To Score'], like: ['yes%', 'gg%'] },
        NG:  { types: ['Both Teams To Score | Full Time', 'GG/NG', 'BOTH TEAMS TO SCORE (GG/NG)', 'Both Teams To Score'], like: ['no%', 'ng%'] },
        DNB1:{ types: ['Draw No Bet | Full Time', 'DRAW NO BET', 'Draw No Bet'], eq: '1' },
        DNB2:{ types: ['Draw No Bet | Full Time', 'DRAW NO BET', 'Draw No Bet'], eq: '2' },
        ODD: { types: ['Odd/Even | Full Time', 'ODD/EVEN'], like: ['odd%'] },
        EVEN:{ types: ['Odd/Even | Full Time', 'ODD/EVEN'], like: ['even%'] },
    };
    const f = FAM[key];
    if (f) {
        qb.whereIn('type_name', f.types);
        if (f.eq != null) qb.where('name', f.eq);
        else qb.where(b => { f.like.forEach((p, i) => i === 0 ? b.whereRaw('LOWER(name) LIKE ?', [p]) : b.orWhereRaw('LOWER(name) LIKE ?', [p])); });
        return qb;
    }
    // 4) grouped/other keys (HTFT:*, CS:*): decode the slug like raw.
    const [, ...rest] = key.split(':');
    qb.whereRaw('LOWER(REPLACE(name, " ", "-")) LIKE ?', [`%${rest.join(':')}%`]);
    return qb;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/market-identity.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/markets.js tests/market-identity.test.js
git commit -m "feat(markets): marketIdentity generic WHERE builder for any discovered market key"
```

---

## Task 3: Discover markets in `columnCatalog()` (src/db/records.js)

**Files:**
- Modify: `src/db/records.js:91-106` (`columnCatalog`)
- Test: covered by an integration check in Task 6 (columnCatalog needs the DB); add a pure unit for the discovery helper.

**Interfaces:**
- Consumes: `canonicalMarket` (Task 1).
- Produces: `columnCatalog().markets` = the union of the canonical `MARKET_COLUMNS` (default set incl. promoted BTTS+DNB) **plus** every `columnizable:'column'|'grouped'` market discovered in `odds_markets`, each `{key, label, group, columnizable, default, sortable:true, filterable:true}`.

- [ ] **Step 1: Write the failing test** (append to `tests/markets.test.js`)

```javascript
import { discoverMarketColumns } from '../src/markets.js';

test('discoverMarketColumns dedupes, tags group, excludes filter-only, marks BTTS+DNB default', () => {
    const rows = [
        { type_name: '1X2 | Full Time', name: '1' },
        { type_name: '1X2', name: '1' },                       // dup of canonical '1'
        { type_name: 'Both Teams To Score | Full Time', name: 'Yes' },
        { type_name: 'Correct Score | Full Time', name: '2:1' }, // filter-only -> excluded from columns
    ];
    const cols = discoverMarketColumns(rows);
    const keys = cols.map(c => c.key);
    assert.equal(keys.filter(k => k === '1').length, 1);       // deduped across providers
    assert.ok(keys.includes('GG'));
    assert.ok(!keys.includes('CS:2-1'));                        // filter-only not a column
    assert.equal(cols.find(c => c.key === 'GG').default, true); // BTTS promoted to default
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/markets.test.js`
Expected: FAIL — `discoverMarketColumns` not exported.

- [ ] **Step 3: Implement `discoverMarketColumns`** (append to `src/markets.js`)

```javascript
// Promoted-to-default additions beyond the canonical MARKET_COLUMNS defaults.
const DEFAULT_EXTRA_KEYS = new Set(['GG', 'NG', 'DNB1', 'DNB2']); // spec: BTTS + DNB default

// Distinct (type_name,name,handicap) rows -> the ordered column catalog for markets.
// Canonical columns first (stable order + defaults), then discovered 'column'/'grouped'
// families; 'filter-only' markets are excluded (available to the filter builder via a
// separate discovery, not as table columns).
export function discoverMarketColumns(rows) {
    const seen = new Map(); // key -> col
    for (const c of MARKET_COLUMNS) {
        seen.set(c.key, { key: c.key, label: c.label, group: canonicalMarket(_probeRow(c.key)).group,
            columnizable: 'column', default: c.default || DEFAULT_EXTRA_KEYS.has(c.key), sortable: true, filterable: true });
    }
    for (const row of rows) {
        const m = canonicalMarket(row);
        if (m.columnizable === 'filter-only') continue;
        if (seen.has(m.key)) continue;
        seen.set(m.key, { key: m.key, label: m.label, group: m.group, columnizable: m.columnizable,
            default: DEFAULT_EXTRA_KEYS.has(m.key), sortable: true, filterable: true });
    }
    return [...seen.values()];
}
// canonical keys don't round-trip through a row; give them their known group.
function _probeRow(key) {
    if (['1', 'X', '2'].includes(key)) return { type_name: '1X2 | Full Time', name: key };
    if (['1X', 'X2', '12'].includes(key)) return { type_name: 'Double Chance | Full Time', name: key };
    return { type_name: 'Over/Under | Full Time', name: 'Over', handicap: 2.5 };
}
```

> Note: BTTS/DNB keys (`GG/NG/DNB1/DNB2`) are NOT in `MARKET_COLUMNS`; they enter via the discovered-rows loop and get `default:true` from `DEFAULT_EXTRA_KEYS`. Confirm the inventory shows them present (it does — BetPawa `Both Teams To Score | Full Time`, `Draw No Bet | Full Time`).

- [ ] **Step 4: Wire into `columnCatalog()`** — modify `src/db/records.js:91-106`:

```javascript
export async function columnCatalog() {
    const types = await db('fixture_statistics').distinct('type').orderBy('type');
    const providers = await db('matches').distinct('provider').orderBy('provider');
    const marketRows = await db('odds_markets').distinct('type_name', 'name', 'handicap');
    return {
        providers: providers.map(p => p.provider),
        base: Object.keys(BASE_FIELDS).map(key => ({ key, sortable: true, filterable: true })),
        markets: discoverMarketColumns(marketRows).map(c => ({ ...c, sortable: true, filterable: true })),
        stats: [
            ...STAT_COLUMNS.map(c => ({ ...c, sortable: false, filterable: false })),
            ...types.map(({ type }) => ({
                key: `fs:${type}`, label: `${type} (H/A)`, default: false,
                sortable: false, filterable: false,
            })),
        ],
    };
}
```

Add `discoverMarketColumns` to the `markets.js` import at the top of `records.js`.

- [ ] **Step 5: Run tests**

Run: `node --test tests/markets.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/markets.js src/db/records.js tests/markets.test.js
git commit -m "feat(records): discover market columns from odds_markets (BTTS+DNB default)"
```

---

## Task 4: Generic pivot + sort/filter in the read layer (src/db/records.js)

**Files:**
- Modify: `src/db/records.js:112-132` (`_sqlTarget`), and `_hydrate` odds pivot (~313-324)

**Interfaces:**
- Consumes: `canonicalMarket`, `marketIdentity` (Tasks 1-2).
- Produces: sort/filter works on any discovered market key; `row.markets`/`markets_stale` are keyed by `canonicalMarket().key` (all recognized + grouped families; filter-only excluded from the pivot but still queryable via SQL).

- [ ] **Step 1: Modify `_sqlTarget`** (`records.js:118-131`) to accept any catalog market key. Replace the `if (!isMarketKey(key)) return null;` gate with a catalog-membership gate and use `marketIdentity`:

```javascript
    // markets: any key present in the discovered catalog resolves to a MIN(price)
    // pivot subquery via the generic identity builder.
    if (!key || key.startsWith('fs:')) return null;
    let alias = joined.get(key);
    if (!alias) {
        alias = `mk${joined.size}`;
        joined.set(key, alias);
        const sub = marketIdentity(db('odds_markets'), key)
            .where('is_stale', 0)
            .groupBy('match_id')
            .select('match_id')
            .min('price as price')
            .as(alias);
        query.leftJoin(sub, `${alias}.match_id`, 'm.id');
    }
    return `${alias}.price`;
```

> The server already validates sort/filter keys against `columnCatalog()` before calling `_sqlTarget` (unknown keys 400), so an out-of-catalog key never reaches here. Confirm that validation path in `server.js` includes the discovered market keys (it reads the same catalog).

- [ ] **Step 2: Modify the `_hydrate` odds pivot** (~`records.js:313-324`) to key by `canonicalMarket` and skip filter-only:

```javascript
    for (const o of oddsRows) {
        // availability counts every row (unchanged)
        freshCounts.set(o.match_id, (freshCounts.get(o.match_id) || 0) + (o.is_stale ? 0 : 1));
        const m = canonicalMarket(o);
        if (m.columnizable === 'filter-only') continue; // stored + SQL-filterable, not pivoted
        const bag = o.is_stale ? stale : live;
        (bag.get(o.match_id) || bag.set(o.match_id, {}).get(o.match_id))[m.key] = Number(o.price);
    }
```

Keep the existing `markets`/`markets_stale` assembly onto each row; only the key source changes (`marketKey` → `canonicalMarket().key`). Replace the `marketKey` import usage in `_hydrate` with `canonicalMarket`.

- [ ] **Step 3: Add a regression test** (append to `tests/markets.test.js`) that the pivot key matches the catalog key for a family market:

```javascript
test('canonicalMarket pivot key matches discoverMarketColumns key (GG)', () => {
    const row = { type_name: 'Both Teams To Score | Full Time', name: 'Yes' };
    const pivotKey = canonicalMarket(row).key;
    const cols = discoverMarketColumns([row]);
    assert.ok(cols.some(c => c.key === pivotKey)); // frontend column and row bag agree
});
```

- [ ] **Step 4: Run tests + a live smoke check**

Run: `node --test tests/markets.test.js`
Expected: PASS.
Then (DB available): `node -e "import('./src/db/records.js').then(async m=>{const c=await m.columnCatalog();console.log('market cols:',c.markets.length, c.markets.filter(x=>x.default).map(x=>x.key).join(','));process.exit(0)})"`
Expected: market cols count > 20, defaults include `GG,NG,DNB1,DNB2`.

- [ ] **Step 5: Commit**

```bash
git add src/db/records.js tests/markets.test.js
git commit -m "feat(records): generic market pivot + sort/filter over discovered keys"
```

---

## Task 5: Frontend — grouped market picker, glossary, defaults

**Files:**
- Modify: `web/src/components/SettingsModal.jsx` (market `MultiSelect`, ~187-194), `web/src/components/FilterBuilder.jsx` (market field group, ~524-547), `web/src/components/DataTable.jsx` (`MARKET_INFO`/`_marketInfo`, ~68-75)

**Interfaces:**
- Consumes: `columnCatalog().markets` (now carries `group` + `label`), which `App.jsx` already threads to these components unchanged.

- [ ] **Step 1: Group the market MultiSelect by `group`.** In `SettingsModal.jsx`, replace the flat `options={catalog.markets}` with options grouped by `col.group` (Result / Double chance / Over-Under / BTTS / DNB / Odd-Even / HT-FT), rendering a group header per bucket. Keep selection persistence (`oddspro.cols.markets`) unchanged — keys are still plain strings. Add a text filter input above the list that substring-matches `label`.

- [ ] **Step 2: Group + search the FilterBuilder market fields** (`FilterBuilder.jsx:524-547`): the "Odds markets" field group becomes sub-grouped by `group`; add the same search box. Behavior/ops unchanged (numeric `= ≠ > ≥ ≤` / `in`/`not-in`).

- [ ] **Step 3: Data-drive the tooltip glossary** (`DataTable.jsx:68-75`): replace the hardcoded `MARKET_INFO` literal with a lookup into the market catalog `label`/`group` passed via props; fall back to the O/U regex for canonical lines. An unknown market renders its `label` as the tooltip instead of `null`.

- [ ] **Step 4: Build + browser-verify**

Run: `npm run build:web`
Then load the app, open Settings → Markets: confirm grouped list + search; confirm BTTS + DNB appear as **default** columns in the table; add a Correct-Score filter and confirm it filters (filter-only, no column). Confirm the canonical default view is otherwise unchanged.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SettingsModal.jsx web/src/components/FilterBuilder.jsx web/src/components/DataTable.jsx
git commit -m "feat(web): grouped/searchable market picker + data-driven market glossary; BTTS+DNB default"
```

---

## Task 6: Full suite + integration verification

**Files:** none (verification only)

- [ ] **Step 1: Full offline suite**

Run: `npm test`
Expected: all pass, including the existing canonical `markets.test.js` assertions (unchanged) + the new ones.

- [ ] **Step 2: Restart server + smoke `/api/columns` and a market sort**

Run: restart `npm run serve`; `curl 'http://127.0.0.1:3001/api/columns'` → `markets[]` count > 20 with groups; `curl 'http://127.0.0.1:3001/api/records?sort=[{"key":"GG","dir":"desc"}]&per_page=all' | head` → 200, sorted by BTTS-Yes price.

- [ ] **Step 3: Confirm predictions unchanged**

Run: `node src/index.js hotpicks` (or inspect that `_loadMarkets`/`marketKey` are untouched) — tip output must be identical to pre-M2 (M2 changes no prediction code path).

- [ ] **Step 4: Commit any doc updates**

Update `CLAUDE.md` (markets.js + records.js notes) and `implementation-plan.md` to record M2. Commit.

```bash
git add CLAUDE.md implementation-plan.md
git commit -m "docs: record all-markets-coverage M2 (generic market surface)"
```

---

## Self-Review

**Spec coverage:** §2 current-state (generic path added, canonical untouched) → T1-T4; §3 cross-provider identity (`canonicalMarket` unifies via `typeNames`) → T1; §4 cardinality guard (`columnizable`, filter-only excluded from columns/pivot) → T1/T3/T4; §5 M2 read-layer + frontend → T3-T5; §9 decision 1 (BTTS+DNB default) → T3/T5; §9 decision 3 (defer BetPawa fetch) → not in plan (correctly deferred). §5 M3 predictions → **separate plan** (out of scope here). §5 M1 capture → T6 Step 3 confirms predictions unchanged; Betika breadth confirmed via the inventory feeding the family table (T1 Step 3).

**Placeholder scan:** family `typeNames` lists are seeded from the inventory (concrete input, not TBD); frontend steps name exact files/line ranges + the concrete change. No "add error handling"/"TBD".

**Type consistency:** `canonicalMarket(row)->{key,group,label,columnizable}` used identically in T1/T3/T4; `marketIdentity(qb,key)->qb` used in T2/T4; `discoverMarketColumns(rows)->col[]` used in T3. Consistent.

> **Known follow-up (not a gap):** the family `typeNames` tables (T1) should be reconciled against the FULL inventory (`tmp/market-inventory.txt`, both providers) during T1 — Betika's exact BTTS/DNB spellings must be added if they differ from BetPawa's. This is a data-entry step inside T1, not a separate task.
