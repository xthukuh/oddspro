# Filters + slips cross-device sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved spec `docs/dev/specs/2026-07-17-filters-slips-sync-design.md`: persist the advanced-filter tree so it rides the existing prefs sync, add a throttled tab-focus sync, and verify slips (already synced) end to end.

**Architecture:** One new pure function (`sanitizeFilters`) in `web/src/filterValues.js`; App persists `oddspro.filters` and hydrates it catalog-gated; `startAutoSync` gains a focus listener. **Zero server changes, zero prefs-rules changes, zero slips-code changes.**

**Tech Stack:** ES modules, node:test offline suite, React 19.

## Global Constraints

- Filter node shapes (from `splitFilters`/`conditionCount`): flat `Array<condition>` | `{ type:'group', join, items, enabled? }` | condition `{ key, op, value, col?, enabled? }` | `{ type:'expr', ... }`.
- `expr` nodes are ALWAYS client-side — they can never 400 the server, so sanitize keeps them.
- Hydrate only AFTER the catalog loads and only when the session's filters are still the initial `[]`.
- Focus sync = `syncNow` (push-if-dirty first), throttled 30 s.
- Conventional Commits; commit per task. Do NOT rebuild `web/dist`.

---

### Task 1: Pure `sanitizeFilters` + tests

**Files:**
- Modify: `web/src/filterValues.js` (after `conditionCount`, ~line 85)
- Test: `tests/filter-values.test.js` (append; extend its filterValues import)

**Interfaces:**
- Produces: `export function sanitizeFilters(filters, columns)` → same-shape tree; `columns` = the `filterColumns` descriptor array `[{key, group}]`. Task 2 imports it in App.jsx.

- [x] **Step 1: Failing tests** — append to `tests/filter-values.test.js` (import `sanitizeFilters` from `../web/src/filterValues.js` alongside the existing names):

```js
// --- sanitizeFilters (persisted-filter restore, 2026-07-17 sync spec) ---

const SAN_COLS = [{ key: 'league', group: 'base' }, { key: 'status', group: 'base' }, { key: 'score', group: 'base' }];

test('sanitizeFilters keeps known-key conditions and drops unknown ones', () => {
    const kept = { key: 'league', op: 'like', value: 'Premier' };
    const stale = { key: 'gone_column', op: 'eq', value: '1' };
    assert.deepEqual(sanitizeFilters([kept, stale], SAN_COLS), [kept]);
});

test('sanitizeFilters preserves enabled flags and expr nodes', () => {
    const off = { key: 'status', op: 'eq', value: 'FT', enabled: false };
    const expr = { type: 'expr', value: 'a > b' };
    assert.deepEqual(sanitizeFilters([off, expr], SAN_COLS), [off, expr]);
});

test('sanitizeFilters validates column-to-column conditions on both sides', () => {
    const ok = { key: 'league', op: 'eq', col: 'status' };
    const bad = { key: 'league', op: 'eq', col: 'gone_column' };
    assert.deepEqual(sanitizeFilters([ok, bad], SAN_COLS), [ok]);
});

test('sanitizeFilters recurses groups and drops emptied ones', () => {
    const tree = {
        type: 'group', join: 'or', items: [
            { key: 'league', op: 'like', value: 'Cup' },
            { type: 'group', join: 'and', items: [{ key: 'gone_column', op: 'eq', value: 'x' }] },
        ],
    };
    const out = sanitizeFilters(tree, SAN_COLS);
    assert.equal(out.type, 'group');
    assert.equal(out.items.length, 1); // inner group emptied -> dropped
    assert.equal(out.items[0].key, 'league');
});

test('sanitizeFilters returns [] for garbage input or a fully-emptied tree', () => {
    assert.deepEqual(sanitizeFilters(null, SAN_COLS), []);
    assert.deepEqual(sanitizeFilters('nope', SAN_COLS), []);
    assert.deepEqual(sanitizeFilters({ type: 'group', items: [{ key: 'gone', op: 'eq', value: '1' }] }, SAN_COLS), []);
});
```

- [x] **Step 2: Run** `node --test tests/filter-values.test.js` — Expected FAIL (no export).
- [x] **Step 3: Implement** in `web/src/filterValues.js` after `conditionCount`:

```js
// Sanitize a PERSISTED filter tree against the loaded catalog before applying
// it (2026-07-17 sync spec): oddspro.filters may have been saved by an older
// deploy/another device, and a condition on a column the server no longer
// knows would 400 the records query. Keeps expr nodes (always client-side -
// they cannot 400 the server), preserves group nesting + enabled flags, drops
// unknown-key conditions and groups that end up empty. Garbage input -> [].
export function sanitizeFilters(filters, columns) {
    const known = new Set((columns ?? []).map(c => c.key));
    const cond = f => f && typeof f === 'object' && (
        f.type === 'expr'
        || (typeof f.key === 'string' && known.has(f.key) && (f.col == null || known.has(f.col)))
    );
    const walk = node => {
        if (!node || typeof node !== 'object') return null;
        if (node.type === 'group') {
            const items = (Array.isArray(node.items) ? node.items : []).map(walk).filter(Boolean);
            return items.length ? { ...node, items } : null;
        }
        return cond(node) ? node : null;
    };
    if (Array.isArray(filters)) return filters.map(walk).filter(Boolean);
    if (filters && typeof filters === 'object' && filters.type === 'group') return walk(filters) ?? [];
    return [];
}
```

- [x] **Step 4: Run** `node --test tests/filter-values.test.js` then `npm test` — Expected PASS (714 + 5 = 719).
- [x] **Step 5: Commit** `feat(web): sanitizeFilters - catalog-validated restore of persisted filters`

---

### Task 2: App persistence + hydrate; focus sync

**Files:**
- Modify: `web/src/App.jsx` (LS const ~line 60; `applyFilters` ~line 700; hydrate effect near the catalog effect; import `sanitizeFilters`)
- Modify: `web/src/auth/prefsSync.js` (`startAutoSync`)

**Interfaces:**
- Consumes: `sanitizeFilters` (Task 1), existing `filterColumns` memo, `applyFilters`, `syncNow`.

- [x] **Step 1: App.jsx.** Add to the filterValues import: `sanitizeFilters`. Below `LS_SORT` (or near the other LS consts):

```js
// Advanced-filter tree (FilterBuilder wire shape, incl. enabled flags) - persisted
// so filters survive reload AND ride the prefs sync / .oddspro exports
// (2026-07-17 sync spec). Restored catalog-gated through sanitizeFilters.
const LS_FILTERS = 'oddspro.filters';
```

Replace `applyFilters`:

```js
    const applyFilters = useCallback(f => {
        try { localStorage.setItem(LS_FILTERS, JSON.stringify(f ?? [])); } catch { /* private mode */ }
        startTransition(() => setFilters(f));
    }, [startTransition]);
```

Hydrate effect (after the `filterColumns` memo):

```js
    // One-time persisted-filter hydrate, gated on the catalog (a stale saved
    // key would 400 the records query; sanitizeFilters prunes it). Skipped if
    // the user already built filters this session (initial state is []).
    const filtersHydratedRef = useRef(false);
    useEffect(() => {
        if (!catalog || filtersHydratedRef.current) return;
        filtersHydratedRef.current = true;
        if (Array.isArray(filters) ? filters.length : filters) return;
        try {
            const saved = JSON.parse(localStorage.getItem(LS_FILTERS));
            const clean = sanitizeFilters(saved, filterColumns);
            if (Array.isArray(clean) ? clean.length : clean) startTransition(() => setFilters(clean));
        } catch { /* corrupted - ignore */ }
    }, [catalog, filters, filterColumns, startTransition]);
```

- [x] **Step 2: prefsSync.js.** Replace `startAutoSync`:

```js
// Debounced-by-cheapness auto-sync: an interval push that no-ops (no network)
// while the fingerprint is clean, PLUS a tab-focus sync (2026-07-17 spec):
// walking to this device runs syncNow - push-if-dirty FIRST, so our own focus
// event can never clobber fresh local edits, else pull (adopt + reload only
// when another device actually changed content). Throttled; 'focus' catches
// app switches where visibility never changed. Returns the stop function.
export function startAutoSync(userId, intervalMs = 120_000, focusThrottleMs = 30_000) {
    const t = setInterval(() => { pushPrefs(userId); }, intervalMs);
    let last = 0;
    const onFocus = () => {
        if (document.visibilityState !== 'visible') return;
        const now = Date.now();
        if (now - last < focusThrottleMs) return;
        last = now;
        syncNow(userId);
    };
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
    return () => {
        clearInterval(t);
        document.removeEventListener('visibilitychange', onFocus);
        window.removeEventListener('focus', onFocus);
    };
}
```

- [x] **Step 3: Run** `npm test` — Expected PASS (719).
- [x] **Step 4: Commit** `feat(web): persist oddspro.filters + catalog-gated hydrate + tab-focus prefs sync`

---

### Task 3: Browser verification + docs + merge

- [x] **Step 1: Browser (:5173, chrome MCP):** (a) build a filter → reload → filter restored + "N filters" chip; (b) corrupt `oddspro.filters` with an unknown key → reload → pruned, no 400; (c) sign in test account (+254700000199 / 4321) → PUT prefs round-trip: confirm `oddspro.filters` AND `oddspro.betslips` appear in `GET /api/prefs` data (slips E2E); (d) clear both keys locally → `syncNow` pull → both restored.
- [x] **Step 2: Docs.** CLAUDE.md web bullet, after the prefsSync sentence: filters persist under `oddspro.filters` (catalog-sanitized restore), slips already synced, focus-sync note.
- [x] **Step 3:** `npm test` final; commit docs; merge branch to `main` per the standing branch rule; push.
