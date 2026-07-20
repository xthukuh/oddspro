// M10: DB export job - a chunked NDJSON+gzip dump of the warehouse, riding
// the EXISTING single-slot refresh job (src/auto-refresh.js) so it can NEVER
// overlap a data refresh (spec decision 11 - InnoDB delete+insert gap-lock
// safety, the same rule as `_batch` DB-writing concurrency 1). Thin knex/fs
// orchestration over the pure decision layer in src/db/transfer-rules.js -
// the same split as campaign-rules.js/campaigns.js.
//
// Task 4 (import) extends this file: `runExport` is exported (not just the
// job-slot-wrapped `startExport`) so the import job's "safety export first"
// step can call it directly from INSIDE its own run() - it already holds the
// shared slot, so it can't call startExport (which would try to claim it
// again and get `false`).
//
// TZ note: DATETIME/TIMESTAMP columns decode through the mysql2 driver as JS
// Date objects parsed in the NODE PROCESS's local timezone, not the pinned
// +03:00 SQL session (the same hazard src/db/ai-rules.js's KICKOFF_SQL_EXPR
// guards against elsewhere). A plain `select('*')` would silently reinterpret
// every stored EAT wall-clock value through whatever timezone the export
// happens to run in. `_selectList` sidesteps the driver entirely for those
// columns via a server-side DATE_FORMAT cast, so the NDJSON captures the
// exact wall-clock string MySQL itself sees - portable across hosts/timezones
// and safe to re-insert verbatim on import.
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { db } from './db/connection.js';
import { config } from './config.js';
import { startJob } from './auto-refresh.js';
import { migrationStatus } from './db/migrate-rules.js';
import {
    MANIFEST_SCHEMA, chunkPlan, resolveExcluded, safeExportFilename,
    exportStamp, stampToIso, chunkFileName, chunkSizeFor, isIntegerPkType,
    ndjsonLine, buildExportListing,
} from './db/transfer-rules.js';
import { AuthError } from './auth.js';

export const EXPORT_ROOT = path.join('var', 'exports');

// --- Schema introspection -----------------------------------------------------
// One query per table: every column (name, type, ordinal position) LEFT
// JOINed against whether it's part of the PRIMARY KEY (and at what position
// within it, for composite keys). Nothing else in the codebase queries
// information_schema.COLUMNS - this is new territory, same as db-info.js's
// TABLES/knex_migrations reads.
async function describeTable(table) {
    const [rows] = await db.raw(
        `SELECT c.COLUMN_NAME AS name, c.DATA_TYPE AS data_type,
                (k.COLUMN_NAME IS NOT NULL) AS is_pk, k.ORDINAL_POSITION AS pk_pos
         FROM information_schema.COLUMNS c
         LEFT JOIN information_schema.KEY_COLUMN_USAGE k
           ON k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME
              AND k.COLUMN_NAME = c.COLUMN_NAME AND k.CONSTRAINT_NAME = 'PRIMARY'
         WHERE c.TABLE_SCHEMA = DATABASE() AND c.TABLE_NAME = ?
         ORDER BY c.ORDINAL_POSITION`,
        [table],
    );
    const pk = rows.filter(r => Number(r.is_pk) === 1)
        .sort((a, b) => (Number(a.pk_pos) || 0) - (Number(b.pk_pos) || 0));
    return { columns: rows, pk };
}

// See the TZ note at the top of the file: DATETIME/TIMESTAMP/DATE columns are
// cast to their exact wall-clock string server-side rather than left to the
// driver's Date decoding.
function _selectList(columns) {
    return columns.map(c => {
        if (c.data_type === 'datetime' || c.data_type === 'timestamp') {
            return db.raw('DATE_FORMAT(??, "%Y-%m-%d %H:%i:%s") AS ??', [c.name, c.name]);
        }
        if (c.data_type === 'date') {
            return db.raw('DATE_FORMAT(??, "%Y-%m-%d") AS ??', [c.name, c.name]);
        }
        return c.name;
    });
}

async function tableList() {
    const [rows] = await db.raw(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
    );
    return rows.map(r => r.name);
}

async function schemaHead() {
    // migrationStatus's `head` is derived purely from the APPLIED list
    // (sorted, last one) - `disk` only feeds `pending`, which this caller
    // never reads. Passing [] skips a wasted readdirSync of MIGRATIONS_DIR
    // without changing `head` at all.
    const appliedRows = await db('knex_migrations').select('name').orderBy('id');
    return migrationStatus(appliedRows.map(r => r.name), []).head;
}

// --- Chunk file writing --------------------------------------------------
// Streams the already-fetched chunk's rows through gzip to disk. Memory stays
// bounded to ONE chunk's rows (<=5000, or <=500 for `matches`) at a time -
// stream.pipeline manages the gzip<->disk backpressure, so nothing here ever
// buffers a whole file, let alone a whole table, in memory.
async function writeChunkFile(filePath, rows) {
    await pipeline(
        Readable.from(rows.map(r => ndjsonLine(r))),
        createGzip(),
        createWriteStream(filePath),
    );
}

function _throwIfCancelled(shouldCancel) {
    if (typeof shouldCancel === 'function' && shouldCancel()) throw new Error('cancelled');
}
function _step(onStep, shouldCancel, label) {
    _throwIfCancelled(shouldCancel);
    if (typeof onStep === 'function') onStep(label);
}

// --- The export itself ---------------------------------------------------
// Exported directly (not just via startExport) so Task 4's import job can run
// a "safety export first" step from inside its OWN run() - it already holds
// the shared job slot at that point, so going through startJob again would
// just get refused.
export async function runExport({ excluded = [], onStep = null, shouldCancel = null } = {}) {
    const stamp = exportStamp(new Date());
    const dir = path.join(EXPORT_ROOT, stamp);
    mkdirSync(dir, { recursive: true });

    const excludedList = resolveExcluded(excluded);
    const excludedSet = new Set(excludedList);
    const allTables = await tableList();
    const tables = allTables.filter(t => !excludedSet.has(t));

    const manifestTables = [];
    for (const table of tables) {
        _step(onStep, shouldCancel, `${table} starting`);
        const { columns, pk } = await describeTable(table);
        if (pk.length === 0) {
            // Every base table in this schema carries a PRIMARY KEY (verified
            // 2026-07-20 - see src/db/transfer-rules.js's isIntegerPkType
            // comment). A future table without one is a schema bug, not
            // something to silently guess an ORDER BY for.
            throw new Error(`db-transfer: table "${table}" has no primary key - cannot export safely`);
        }
        const pkNames = pk.map(c => c.name);
        const selectList = _selectList(columns);
        const chunkSize = chunkSizeFor(table);
        let rowCount = 0;
        let chunkIndex = 0;

        if (pk.length === 1 && isIntegerPkType(pk[0].data_type)) {
            // Single integer PK: numeric min/max range chunking (the common
            // case - every table but fixture_ai_insights/ip_geo/settings).
            const pkCol = pkNames[0];
            const [[bounds]] = await db.raw('SELECT MIN(??) AS minId, MAX(??) AS maxId FROM ??', [pkCol, pkCol, table]);
            const ranges = chunkPlan({ minId: bounds?.minId, maxId: bounds?.maxId, chunkSize });
            for (let i = 0; i < ranges.length; i++) {
                _step(onStep, shouldCancel, `${table} chunk ${i + 1}/${ranges.length}`);
                const rows = await db(table).select(selectList)
                    .whereBetween(pkCol, [ranges[i].from, ranges[i].to]).orderBy(pkCol);
                await writeChunkFile(path.join(dir, chunkFileName(table, chunkIndex)), rows);
                rowCount += rows.length;
                chunkIndex += 1;
            }
        } else {
            // Composite PK (fixture_ai_insights: fixture_id,kind,provider) or
            // a non-integer single PK (ip_geo.ip, settings.key - both
            // VARCHAR): no numeric range to chunk on, so ORDER BY the PK
            // columns and page with LIMIT/OFFSET instead. Every one of these
            // tables is small today (<=~1100 rows), so an upfront COUNT(*) to
            // size the progress label is cheap.
            const [[cnt]] = await db.raw('SELECT COUNT(*) AS c FROM ??', [table]);
            const totalRows = Number(cnt?.c) || 0;
            const totalChunks = Math.ceil(totalRows / chunkSize);
            const orderSpec = pkNames.map(c => ({ column: c, order: 'asc' }));
            for (let i = 0; i < totalChunks; i++) {
                _step(onStep, shouldCancel, `${table} chunk ${i + 1}/${totalChunks}`);
                const rows = await db(table).select(selectList).orderBy(orderSpec)
                    .limit(chunkSize).offset(i * chunkSize);
                await writeChunkFile(path.join(dir, chunkFileName(table, chunkIndex)), rows);
                rowCount += rows.length;
                chunkIndex += 1;
            }
        }
        manifestTables.push({ name: table, rows: rowCount, chunks: chunkIndex, pk: pkNames.join(',') });
    }

    _step(onStep, shouldCancel, 'writing manifest');
    const head = await schemaHead();
    const manifest = {
        version: 1,
        created_at: new Date().toISOString(),
        database: config.DB_DATABASE,
        schema_head: head,
        tables: manifestTables,
        excluded: excludedList,
    };
    // Validate the manifest we are ABOUT TO WRITE against Task 1's own schema
    // before it touches disk - a manifest that fails its own contract (e.g.
    // schema_head null because this DB has literally never been migrated) is
    // a bug in this exporter, not something to write anyway.
    const parsed = MANIFEST_SCHEMA.safeParse(manifest);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`db-transfer: built manifest fails MANIFEST_SCHEMA (${issue?.path?.join('.') || '(root)'}: ${issue?.message})`);
    }
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(parsed.data, null, 2));

    return {
        stamp,
        tables: manifestTables.length,
        rows: manifestTables.reduce((sum, t) => sum + t.rows, 0),
        excluded: excludedList,
    };
}

// Claim the shared refresh/export/import job slot and run the export without
// awaiting - the route answers immediately (202) and the web polls job state
// via GET /api/admin/db/exports. Returns {started:false} without touching the
// filesystem when a refresh/export/import is already in flight (409 upstream).
export function startExport({ excluded = [], onDone = null } = {}) {
    const started = startJob({
        mode: 'db-export',
        dates: [],
        run: (onStep, shouldCancel) => runExport({ excluded, onStep, shouldCancel }),
        onFinish: onDone,
    });
    return { started };
}

// --- Listing / deletion ---------------------------------------------------
// GET /api/admin/db/exports: every export on disk, newest first, with the
// manifest validated (not just "present") so a truncated/corrupt write from
// an interrupted export is visibly flagged rather than silently offered for
// download or import.
export async function listExports() {
    if (!existsSync(EXPORT_ROOT)) return [];
    const dirs = readdirSync(EXPORT_ROOT, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

    const entries = dirs.map(stamp => {
        const dirPath = path.join(EXPORT_ROOT, stamp);
        const files = readdirSync(dirPath).map(name => {
            const st = statSync(path.join(dirPath, name));
            return { name, bytes: st.size };
        });
        let manifest = null;
        if (files.some(f => f.name === 'manifest.json')) {
            try {
                manifest = JSON.parse(readFileSync(path.join(dirPath, 'manifest.json'), 'utf8'));
            } catch {
                manifest = null; // corrupt/partial write -> manifest_ok:false via buildExportListing
            }
        }
        return { stamp, files, manifest, created_at: stampToIso(stamp) ?? manifest?.created_at ?? null };
    });
    return buildExportListing(entries);
}

// DELETE /api/admin/db/exports/:stamp. The route already runs the stamp
// through safeExportFilename before calling this (the 400-before-filesystem
// gate); re-validated here too as defense-in-depth for any other caller.
export async function deleteExport(stamp) {
    const safe = safeExportFilename(stamp);
    if (!safe) throw new AuthError(400, 'Invalid export name');
    const dir = path.join(EXPORT_ROOT, safe);
    if (!existsSync(dir)) throw new AuthError(404, 'Export not found');
    rmSync(dir, { recursive: true, force: true });
    return { deleted: true, stamp: safe };
}
