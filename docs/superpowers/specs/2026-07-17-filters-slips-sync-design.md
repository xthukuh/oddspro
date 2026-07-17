# Filters + slips in cross-device prefs sync (design)

Date: 2026-07-17. Status: approved by user (conversation), implementation follows
immediately in-session. Owner intent (verbatim): "include filters and playground
slips in synchronized settings so logged in users can replicate the same page
state across all their devices."

## 1. Findings that shaped the design (code-verified 2026-07-17)

- **Playground slips ALREADY sync.** `oddspro.betslips` is an `oddspro.*`
  localStorage key (a JSON string), `collectConfig()` collects every such key,
  it is on no device-key exclusion list, and localStorage values are strings —
  which pass `validatePrefsPut`'s scalar gate. Nothing to build; verify E2E.
- **Filters are the real gap: they are not persisted at all** (React state
  only — a reload clears them), so the sync has nothing to carry.
- Cross-device freshness today: push every 2 min + on logout; other devices
  APPLY synced state only on page load or the manual "Sync settings" row.
  User picked "sync on tab focus" to close that gap.

## 2. Decisions

- **Persist the filter tree** under `oddspro.filters` (JSON string of the
  exact FilterBuilder wire shape `applyFilters` receives, including per-node
  `enabled:false`). Save on every filter change; it then syncs (and rides
  `.oddspro` config exports) automatically. Guests get local persistence too —
  a deliberate side effect; the ViewPills "N filters" chip keeps a restored
  filter visible, never silent.
- **Hydrate AFTER the catalog loads** (one-time effect), through a new pure
  `sanitizeFilters(filters, filterColumns)` in `web/src/filterValues.js`:
  saved conditions reference column keys and the server 400s unknown keys, so
  a stale tree from an older deploy must be pruned, not sent. Keeps conditions
  whose key the catalog knows (incl. synthetic `score`/`no`), preserves group
  nesting + `enabled` flags, drops unknown-key conditions and empty groups.
- **Focus sync**: `startAutoSync` additionally listens for `visibilitychange`;
  on becoming visible it runs `syncNow` (push-if-dirty FIRST — a device's own
  focus event can never clobber its fresh local edits — else pull), throttled
  to once per 30 s. A pull adopts + reloads only when content actually changed
  on another device; the loaded date survives via the URL, scroll resets
  (accepted trade-off).
- **Zero server changes. Zero prefs-rules changes.** Slips code untouched.
- Per-date row selections stay excluded (data, not config) — unchanged.

## 3. Components

1. `web/src/filterValues.js`: `sanitizeFilters(filters, columns)` — pure,
   tolerant of the flat-array and nested-group forms; unknown/malformed nodes
   drop; returns `[]` for garbage input.
2. `web/src/App.jsx`: `LS_FILTERS = 'oddspro.filters'`; persist in the
   existing `applyFilters` path; one-time catalog-gated hydrate effect
   (`sanitizeFilters` over the stored tree, applied only when the user hasn't
   already set filters this session).
3. `web/src/auth/prefsSync.js`: focus listener + 30 s throttle inside
   `startAutoSync` (teardown removes it).
4. Tests (offline, node:test — extends `tests/filter-values.test.js`):
   sanitize keeps known keys / drops unknown / preserves nesting + enabled /
   drops empty groups / handles non-array input.
5. Docs: CLAUDE.md web bullet one-liner (filters persist + sync, focus sync).

## 4. Out of scope

Immediate per-edit push (rejected — churn), per-date filter memory, syncing
per-date selections, any server/prefs-rules change, slips code changes.
