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
export function parseManifest(raw) {
    const p = MANIFEST_SCHEMA.safeParse(raw);
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
    const doneSet = new Set(doneList.map(d => `${d?.table} ${d?.chunk}`));
    for (const t of tables) {
        const total = Number(t?.chunks) || 0;
        for (let chunk = 0; chunk < total; chunk++) {
            if (!doneSet.has(`${t?.name} ${chunk}`)) return { table: t?.name, chunk };
        }
    }
    return null;
}
