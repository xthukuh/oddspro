// Pure DB export/import decision rules (M10; zod-only, zero other imports,
// offline-testable). Owns the whole transfer decision surface: the manifest
// contract, PK-range chunk planning, the excluded-tables policy, path-safety
// for anything built from a URL parameter, FK-safe apply ordering, and the
// resumable-import cursor. src/db-transfer.js is the thin knex/fs
// orchestration over these - the same split as campaign-rules/campaigns.js.
//
// Safety note: spec decision 12 default-excludes the auth tables (credential/
// PK-collision risk moving local<->remote). resolveExcluded hardcodes the two
// migration-bookkeeping tables into every result unconditionally - the same
// "no caller can switch it off" idiom as campaign-rules.audienceCriteria's
// excludeOptOut, because importing knex_migrations/knex_migrations_lock rows
// would corrupt the destination's migration state.
import { z } from 'zod';

// --- Manifest contract ---------------------------------------------------
// Written by the exporter (src/db-transfer.js), read back by both the export
// list and the import upload flow. A hand-edited or corrupted manifest is
// EXTERNAL data reaching a request path, so parseManifest below must never
// throw - only the schema decides what is well-formed.
export const MANIFEST_SCHEMA = z.object({
    version: z.literal(1),
    created_at: z.string().min(1),
    database: z.string().min(1),
    // Newest applied migration filename at export time - the import
    // compatibility guard (a mismatch means the two schemas have diverged).
    schema_head: z.string().min(1),
    tables: z.array(z.object({
        name: z.string().min(1),
        rows: z.coerce.number().int().nonnegative(),
        chunks: z.coerce.number().int().nonnegative(),
        pk: z.string().min(1),
    })),
    excluded: z.array(z.string()),
});

// safeParse wrapper - NEVER throws. A hand-edited manifest.json (or a client
// POSTing garbage to /api/admin/db/import/manifest) is external data; the
// caller gets a human-readable reason instead of an uncaught ZodError.
//
// STRING-TOLERANT (Task 4 fold-in fix): `raw` may be the manifest object
// itself (the export writer's own callers, the parsed JSON body of the
// upload route) OR the raw file text (re-reading manifest.json off disk at
// apply time, a hand-edited file). A string is JSON.parse'd first, inside its
// own try/catch - a malformed string is exactly the "hand-edited manifest"
// case this function exists for, so it returns {ok:false, error} rather than
// throwing a SyntaxError past this function's contract. Anything already an
// object (including non-string junk like numbers/arrays) skips straight to
// the schema, unchanged from before.
export function parseManifest(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
        try {
            obj = JSON.parse(raw);
        } catch (e) {
            return { ok: false, error: `invalid JSON: ${e?.message ?? 'parse error'}` };
        }
    }
    const p = MANIFEST_SCHEMA.safeParse(obj);
    if (p.success) return { ok: true, manifest: p.data };
    const first = p.error.issues[0];
    const path = first?.path?.length ? first.path.join('.') : '(root)';
    return { ok: false, error: `${path}: ${first?.message ?? 'invalid manifest'}` };
}

// --- Chunk planning --------------------------------------------------------
// Inclusive PK ranges covering [minId, maxId] in steps of chunkSize. The
// caller (src/db-transfer.js) turns each range into one
// `WHERE pk BETWEEN from AND to` SELECT, so an interrupted export/import
// never has to hold a whole table in memory.
//
// chunkSize is PROGRAMMER-supplied config (a literal 5000/500 in
// db-transfer.js), never user input, so a bad value is a bug and throws
// rather than silently clamping to something "safe" that would hide it.
export function chunkPlan({ minId, maxId, chunkSize } = {}) {
    if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
        throw new TypeError(`chunkPlan: chunkSize must be a positive integer, got ${JSON.stringify(chunkSize)}`);
    }
    if (minId == null || maxId == null) return [];   // empty table - nothing to chunk
    const min = Number(minId);
    const max = Number(maxId);
    const ranges = [];
    for (let from = min; from <= max; from += chunkSize) {
        // Math.min pins the FINAL range's end to maxId exactly, even when
        // chunkSize overshoots the remaining span.
        ranges.push({ from, to: Math.min(from + chunkSize - 1, max) });
    }
    return ranges;
}

// --- Excluded tables ---------------------------------------------------------
// Spec decision 12: auth/session/analytics tables carry credentials or would
// PK-collide moving between the local warehouse and the remote host, so they
// never ride an export/import by default. Verified against the live 33-table
// schema listing (2026-07-20) - every name below exists on the live DB.
export const DEFAULT_EXCLUDED_TABLES = Object.freeze([
    'users', 'sessions', 'otp_codes', 'user_prefs',
    'visits', 'visit_events', 'visitors', 'visitor_devices', 'visit_sessions',
    'knex_migrations', 'knex_migrations_lock',
]);

// Migration bookkeeping tables. Importing/exporting these would corrupt the
// destination's migration state (a foreign knex_migrations row could make a
// live schema think a migration ran that never did). Added HERE,
// unconditionally, independent of DEFAULT_EXCLUDED_TABLES's own contents and
// of anything a caller supplies - no combination of inputs can produce a
// resolveExcluded() result missing them.
const ALWAYS_EXCLUDED = Object.freeze(['knex_migrations', 'knex_migrations_lock']);

// Union of the defaults, the caller's own picks (e.g. an admin opting to also
// skip `sms_campaign_recipients`) and the non-negotiable pair above - deduped
// and sorted so the result is stable/testable regardless of input order.
export function resolveExcluded(userExcluded) {
    const user = Array.isArray(userExcluded) ? userExcluded.filter(t => typeof t === 'string' && t) : [];
    const merged = new Set([...DEFAULT_EXCLUDED_TABLES, ...user, ...ALWAYS_EXCLUDED]);
    return [...merged].sort();
}

// --- Path safety -------------------------------------------------------------
// Gates every path segment built from a URL parameter (export stamp, chunk
// filename, import stamp) BEFORE it ever touches the filesystem. Rejects
// anything but a plain, single-segment name: no traversal (`..`), no leading
// dot, no path separators (the character class alone excludes `/` and `\`,
// which also rejects absolute paths on both POSIX and Windows).
const SAFE_FILENAME_RX = /^[A-Za-z0-9._-]+$/;
export function safeExportFilename(name) {
    if (typeof name !== 'string' || name.length === 0) return null;
    if (name.startsWith('.')) return null;
    if (name.includes('..')) return null;
    if (!SAFE_FILENAME_RX.test(name)) return null;
    return name;
}

// --- FK-safe apply order -----------------------------------------------------
// Orders `tables` so every parent precedes its children (import applies
// parents first so a child's FK never references a row that isn't there
// yet). `deps` is a {child: [parents]} map. Deterministic: same inputs always
// produce the same output, regardless of the input array's own order - each
// round's ready set (zero remaining unresolved parents) is sorted by name
// before being appended, so ties never depend on iteration order.
//
// A cycle is a bug in the caller's dep map (not user input), so it throws
// rather than silently truncating the plan.
export function fkSafeOrder(tables, deps) {
    const nodes = Array.isArray(tables) ? [...new Set(tables)] : [];
    const depMap = deps && typeof deps === 'object' && !Array.isArray(deps) ? deps : {};
    const nodeSet = new Set(nodes);

    const parentsOf = new Map();
    for (const n of nodes) {
        const parents = (Array.isArray(depMap[n]) ? depMap[n] : [])
            .filter(p => nodeSet.has(p) && p !== n);
        parentsOf.set(n, new Set(parents));
    }

    const result = [];
    const remaining = new Set(nodes);
    while (remaining.size > 0) {
        const ready = [...remaining]
            .filter(n => [...parentsOf.get(n)].every(p => !remaining.has(p)))
            .sort();
        if (ready.length === 0) {
            const cycle = [...remaining].sort();
            throw new TypeError(`fkSafeOrder: dependency cycle among tables: ${cycle.join(', ')}`);
        }
        for (const n of ready) {
            result.push(n);
            remaining.delete(n);
        }
    }
    return result;
}

// --- Resumable import cursor -------------------------------------------------
// Chunk index within a table is its position in that table's chunkPlan()
// array (0-based) - the same number manifest.tables[i].chunks counts. `done`
// is the applied-cursor ledger (var/imports/<stamp>/progress.json): every
// {table, chunk} pair already upserted. Walks manifest.tables IN THE ORDER
// THEY APPEAR (the caller is responsible for handing tables in the fk-safe
// order it wants applied - this function only tracks per-table progress).
//
// Returns the next pair to apply, or null once every table's every chunk is
// done - what lets a killed import resume instead of redoing applied chunks.
export function nextCursor(manifest, done) {
    const tables = Array.isArray(manifest?.tables) ? manifest.tables : [];
    const doneList = Array.isArray(done) ? done : [];
    const doneSet = new Set(doneList.map(d => `${d?.table} ${d?.chunk}`));
    for (const t of tables) {
        const total = Number(t?.chunks) || 0;
        for (let chunk = 0; chunk < total; chunk++) {
            if (!doneSet.has(`${t?.name} ${chunk}`)) return { table: t?.name, chunk };
        }
    }
    return null;
}

// --- Export stamp --------------------------------------------------------
// YYYYMMDD_HHMMSS derived from an ISO instant - the EXACT formula already
// used by scripts/db-export.js's CLI entry, reused verbatim so both DB-dump
// paths (the phpMyAdmin gzip dump and this NDJSON exporter) name directories
// the same way. src/db-transfer.js calls this with `new Date()`; a fixed Date
// is passed here so the derivation itself stays pure/offline-testable.
export function exportStamp(d = new Date()) {
    return d.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

// Reverses exportStamp back to an ISO instant (seconds precision). The stamp
// ALREADY encodes creation time, so the exports list derives created_at from
// the directory NAME rather than a filesystem mtime (which a copy/rsync/zip
// can rewrite) - this is that parser. Accepts a suffixed stamp too (the
// Task 4 safety-export idiom names its dir `<stamp>-pre-import`) since the
// leading YYYYMMDD_HHMMSS is always what matters. Returns null on anything
// that doesn't start with the expected shape - never throws (stamps
// ultimately come from a directory listing, i.e. external input).
const STAMP_RX = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/;
export function stampToIso(stamp) {
    const m = typeof stamp === 'string' ? STAMP_RX.exec(stamp) : null;
    if (!m) return null;
    const [, y, mo, d, h, mi, s] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
    return Number.isFinite(Date.parse(iso)) ? iso : null;
}

// --- Chunk file naming -----------------------------------------------------
// <table>.<NNNN>.ndjson.gz - zero-padded to 4 digits. The largest live table
// (odds_markets, ~2.2M rows / chunkSize 5000) is ~445 chunks, comfortably
// inside the 9999 budget this format allows.
export function chunkFileName(table, index) {
    if (typeof table !== 'string' || !table) {
        throw new TypeError(`chunkFileName: table must be a non-empty string, got ${JSON.stringify(table)}`);
    }
    if (!Number.isInteger(index) || index < 0) {
        throw new TypeError(`chunkFileName: index must be a non-negative integer, got ${JSON.stringify(index)}`);
    }
    return `${table}.${String(index).padStart(4, '0')}.ndjson.gz`;
}

// --- Per-table chunk size ------------------------------------------------
// Spec-pinned: 5000 rows/chunk, except `matches` at 500 - its `metadata`
// column holds ~39 KB/row of raw provider JSON (src/db/store.js), so 5000
// rows would balloon a single chunk file's in-flight memory ~8x over every
// other table.
const CHUNK_SIZE_DEFAULT = 5000;
const CHUNK_SIZE_MATCHES = 500;
export function chunkSizeFor(table) {
    return table === 'matches' ? CHUNK_SIZE_MATCHES : CHUNK_SIZE_DEFAULT;
}

// --- PK type classification --------------------------------------------------
// Only a SINGLE integer-typed PK column supports numeric min/max range
// chunking (chunkPlan + `WHERE pk BETWEEN`); every other shape - a composite
// PK (fixture_ai_insights: fixture_id,kind,provider) or a non-integer single
// PK (ip_geo.ip, settings.key, both VARCHAR) - falls back to an ORDER BY +
// LIMIT/OFFSET pagination in src/db-transfer.js. Verified against the live
// 33-table schema (2026-07-20): every other table has a single int/bigint PK.
const INTEGER_PK_TYPES = new Set(['int', 'bigint', 'mediumint', 'smallint', 'tinyint']);
export function isIntegerPkType(dataType) {
    return typeof dataType === 'string' && INTEGER_PK_TYPES.has(dataType.toLowerCase());
}

// --- NDJSON row serialization -------------------------------------------------
// One JSON object per line - what the exporter writes into each gzip chunk
// file and the importer (Task 4) parses back. A row that can't JSON.stringify
// (a BigInt/circular value from the driver) is a genuine bug worth throwing
// on, not something to swallow mid-export.
export function ndjsonLine(row) {
    return `${JSON.stringify(row)}\n`;
}

// --- Byte formatting -----------------------------------------------------
// Human-readable size for the exports list UI. Iterative division rather
// than a log-based formula - Math.log(n)/Math.log(1024) is vulnerable to
// floating-point drift landing just under an exact power-of-1024 boundary
// (e.g. mis-classifying exactly 1 MB as "1024.0 KB").
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    let value = n;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

// --- Export listing mapper -----------------------------------------------
// Turns raw per-directory filesystem facts (already read by the caller -
// src/db-transfer.js's listExports - this function stays pure/offline) into
// the shape GET /api/admin/db/exports returns. Newest first: stamps sort
// lexicographically == chronologically (YYYYMMDD_HHMMSS).
export function buildExportListing(entries) {
    const list = Array.isArray(entries) ? entries : [];
    return list.map(e => {
        const files = Array.isArray(e?.files)
            ? e.files.map(f => ({ name: f?.name ?? null, bytes: Number(f?.bytes) || 0 }))
            : [];
        const bytes = files.reduce((sum, f) => sum + f.bytes, 0);
        const manifest_ok = e?.manifest != null && parseManifest(e.manifest).ok === true;
        return {
            stamp: e?.stamp ?? null,
            files,
            bytes,
            created_at: e?.created_at ?? null,
            manifest_ok,
        };
    }).sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

// --- Export request body -------------------------------------------------
// POST /api/admin/db/export's body. `excluded` is ADDITIVE on top of
// resolveExcluded's own defaults (see above) - there is no way to un-exclude
// a default or the always-excluded migration tables through this schema.
export const exportRequestSchema = z.object({
    excluded: z.array(z.string()).max(64).optional(),
});

// ===========================================================================
// Task 4 - import (upload plan, FK-dependency map, destructive-confirm
// matcher, apply request shape). src/db-transfer.js orchestrates the actual
// upload/apply against the filesystem + DB; everything decidable without
// either stays here, pure and offline-tested.
// ===========================================================================

// --- Upload plan -----------------------------------------------------------
// Turns a validated manifest into the flat, ordered list of chunk filenames
// the client must upload (POST /api/admin/db/import/manifest's response) -
// reuses chunkFileName so the plan and the actual on-disk chunk names can
// NEVER drift apart. One entry per (table, chunk index) in manifest.tables
// order; a table with 0 chunks (empty table) contributes nothing. Total:
// tolerant of a malformed manifest/table entry (skips it) rather than
// throwing chunkFileName's programmer-error TypeError from what is, here,
// externally-sourced data.
export function buildUploadPlan(manifest) {
    const tables = Array.isArray(manifest?.tables) ? manifest.tables : [];
    const files = [];
    for (const t of tables) {
        const name = t?.name;
        if (typeof name !== 'string' || !name) continue;
        const total = Number(t?.chunks) || 0;
        for (let chunk = 0; chunk < total; chunk++) {
            files.push({ table: name, chunk, file: chunkFileName(name, chunk) });
        }
    }
    return files;
}

// --- FK dependency map -------------------------------------------------------
// Turns raw {child, parent} rows - read live at apply time from
// information_schema.KEY_COLUMN_USAGE (never hardcoded; see src/db-transfer.js)
// - into the {child: [parents]} shape fkSafeOrder expects. `tableSet` is the
// set of tables actually being imported (the manifest's own table list): an
// FK edge pointing at a table OUTSIDE that set - most commonly a
// default-excluded table like `users` (spec decision 12; e.g.
// admin_audit -> users, settings -> users) - is dropped rather than blocking
// the child from ever becoming "ready", since that parent's rows are never
// part of this import to begin with. Composite FKs repeat the same
// (child,parent) pair once per column; deduped here so fkSafeOrder never sees
// a duplicate. Total against malformed rows (a bad row is skipped, not
// thrown on) - these rows come from a live DB read, not programmer input.
export function buildFkDeps(rows, tableSet) {
    const set = tableSet instanceof Set ? tableSet : new Set(Array.isArray(tableSet) ? tableSet : []);
    const deps = {};
    for (const r of (Array.isArray(rows) ? rows : [])) {
        const child = r?.child;
        const parent = r?.parent;
        if (typeof child !== 'string' || typeof parent !== 'string') continue;
        if (child === parent) continue;
        if (!set.has(child) || !set.has(parent)) continue;
        if (!deps[child]) deps[child] = [];
        if (!deps[child].includes(parent)) deps[child].push(parent);
    }
    return deps;
}

// --- Destructive-action confirm ---------------------------------------------
// The apply route (POST /api/admin/db/import/apply) requires the admin to
// type this exact phrase before a single row is written - the same
// typed-confirmation idiom M9's campaign send uses (campaign-rules.js
// campaignSendSchema: `confirm: z.literal('SEND')`). Here the expected string
// is DYNAMIC (it embeds the live database name, config.DB_DATABASE), so it
// can't be a zod literal - these two functions are the runtime equivalent,
// shared by the server route and (eventually) the web wizard so the phrase
// shown to the admin and the phrase the server accepts can never drift.
export function importConfirmPhrase(database) {
    return `IMPORT ${typeof database === 'string' ? database : ''}`;
}
export function matchesImportConfirm(confirm, database) {
    return typeof confirm === 'string' && confirm === importConfirmPhrase(database);
}

// --- Apply request body ----------------------------------------------------
// POST /api/admin/db/import/apply's body shape. The confirm-PHRASE equality
// check itself (matchesImportConfirm, above) happens in the route after this
// parses - it needs the live database name, which zod can't see here.
export const importApplySchema = z.object({
    stamp: z.string().min(1),
    confirm: z.string().min(1),
});

// --- Safety-export-on-resume guard (fix pass 2, MEDIUM finding) ------------
// runImportApply (src/db-transfer.js) re-runs from the top on EVERY apply
// invocation, including a resume after a kill - and its safety export always
// targets the SAME dir (`var/exports/<stamp>-pre-import/`). Without this
// guard, a resumed apply would take a SECOND safety export that captures the
// now-PARTIALLY-IMPORTED database and overwrites the manifest + overlapping
// chunks of the FIRST, pristine snapshot - destroying the one backup an
// operator most needs in exactly the killed-then-resumed scenario.
//
// `preImportManifestRawOrNull` is whatever the caller read off disk at
// `var/exports/<stamp>-pre-import/manifest.json` (raw file text) - or `null`
// when that file doesn't exist yet. Skip the safety export iff a VALID
// manifest is already there (the pristine snapshot from a prior run); a
// missing, torn, or otherwise malformed prior manifest must NOT skip it -
// that's either a genuine first run or a snapshot that never finished, and
// requirement (b) ("a valid pristine backup always exists before any write")
// only holds if a fresh attempt is made.
export function shouldSkipSafetyExport(preImportManifestRawOrNull) {
    if (preImportManifestRawOrNull == null) return false;
    return parseManifest(preImportManifestRawOrNull).ok === true;
}
