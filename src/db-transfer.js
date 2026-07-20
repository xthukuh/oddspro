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
import { createWriteStream, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, renameSync } from 'node:fs';
import { createGzip, gunzipSync } from 'node:zlib';
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
    ndjsonLine, buildExportListing, parseManifest,
    buildUploadPlan, buildFkDeps, fkSafeOrder, nextCursor,
    shouldSkipSafetyExport,
} from './db/transfer-rules.js';
import { AuthError } from './auth.js';

export const EXPORT_ROOT = path.join('var', 'exports');
export const IMPORT_ROOT = path.join('var', 'imports');

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
//
// `stamp` lets a caller pin the export directory's name instead of minting a
// fresh one - Task 4's safety export uses this to land in
// `var/exports/<import-stamp>-pre-import/` (obviously tied to the import it's
// insuring) rather than an unrelated timestamp. Every other caller (manual
// export, startExport) omits it and gets the normal fresh-timestamp dir.
export async function runExport({ excluded = [], onStep = null, shouldCancel = null, stamp: stampOverride = null } = {}) {
    const stamp = stampOverride || exportStamp(new Date());
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
        // parseManifest is now string-tolerant (Task 4 fold-in fix) - it takes
        // the raw file TEXT directly, so this no longer needs its own guarded
        // JSON.parse (a malformed manifest can't throw past parseManifest
        // anymore). The try/catch stays around the readFileSync itself - a
        // concurrent delete between the readdirSync above and here (or any
        // other read failure) still degrades to manifest:null rather than
        // aborting the whole listing, same as before.
        let manifest = null;
        if (files.some(f => f.name === 'manifest.json')) {
            try {
                const parsed = parseManifest(readFileSync(path.join(dirPath, 'manifest.json'), 'utf8'));
                manifest = parsed.ok ? parsed.manifest : null;
            } catch {
                manifest = null;
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

// ===========================================================================
// Task 4 - Import: three-phase upload (manifest -> chunks -> apply), sized
// for the cPanel/Passenger host (spec decision 11). The apply phase is the
// DESTRUCTIVE half of this module - it writes rows into the live warehouse.
// ===========================================================================

// --- Progress cursor (var/imports/<stamp>/progress.json) -------------------
// The applied-chunk ledger nextCursor() (transfer-rules.js) walks to find
// where a killed apply should resume. Written after EVERY chunk (not just at
// the end) - that's what makes resume possible: each chunk's upsert commits
// independently on the dedicated connection (no wrapping transaction, see
// runImportApply below), so whatever the ledger says is "done" really is done
// in the DB, even if the process was killed a moment later.
function _readProgress(dir) {
    const p = path.join(dir, 'progress.json');
    if (!existsSync(p)) return [];
    try {
        const data = JSON.parse(readFileSync(p, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch {
        return []; // corrupt ledger - safer to redo (upserts are idempotent) than to guess
    }
}
// Atomic write (fix pass 2, LOW finding): write to a `.tmp` sibling then
// `renameSync` over the real path. A plain writeFileSync truncates-then-
// writes in place, so a kill mid-write leaves a torn (partial-JSON) ledger -
// harmless (it degrades to [] via _readProgress's catch, a safe-but-wasteful
// full re-apply) but avoidable. rename is atomic on the same filesystem, so a
// kill leaves either the OLD complete file or the NEW complete file, never a
// torn one.
function _writeProgress(dir, done) {
    const target = path.join(dir, 'progress.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify(done));
    renameSync(tmp, target);
}

// Reads one gzip NDJSON chunk file back into row objects. Bounded to ONE
// chunk's worth of rows at a time (<=5000, or <=500 for `matches` - the same
// per-table sizes the export used to write it), matching the export side's
// memory discipline: nothing here ever holds more than one chunk in memory.
function _readChunkRows(filePath) {
    const text = gunzipSync(readFileSync(filePath)).toString('utf8');
    return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
}

// --- Phase 1: manifest upload -----------------------------------------------
// POST /api/admin/db/import/manifest. `rawBody` is the parsed JSON request
// body (express.json already ran) - parseManifest still runs it through
// MANIFEST_SCHEMA (a client can POST anything). The schema_head guard fires
// HERE, at upload time, and again at apply time (runImportApply below) -
// migrations can run in the gap between the two.
export async function startImportManifest(rawBody) {
    const parsed = parseManifest(rawBody);
    if (!parsed.ok) throw new AuthError(400, `Invalid manifest: ${parsed.error}`);
    const manifest = parsed.manifest;

    const localHead = await schemaHead();
    if (manifest.schema_head !== localHead) {
        throw new AuthError(409, 'This manifest was exported from a different migration state - importing it would corrupt the warehouse', {
            manifest_schema_head: manifest.schema_head,
            local_schema_head: localHead,
        });
    }

    const stamp = exportStamp(new Date());
    const dir = path.join(IMPORT_ROOT, stamp);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return {
        stamp,
        schema_head: manifest.schema_head,
        tables: manifest.tables.length,
        rows: manifest.tables.reduce((sum, t) => sum + t.rows, 0),
        upload_plan: buildUploadPlan(manifest),
    };
}

// --- Phase 2: chunk upload --------------------------------------------------
// POST /api/admin/db/import/chunk?stamp=&file=. Both params are validated by
// the route via safeExportFilename BEFORE express.raw's body even matters
// (400, never touches disk) - re-validated here too as defense-in-depth, the
// same idiom as deleteExport above. Idempotent: writeFileSync overwrites, so
// re-uploading the same chunk (a retried request) is safe.
export async function saveImportChunk(stamp, file, buffer) {
    const safeStamp = safeExportFilename(stamp);
    const safeFile = safeExportFilename(file);
    if (!safeStamp || !safeFile) throw new AuthError(400, 'Invalid import chunk path');
    const dir = path.join(IMPORT_ROOT, safeStamp);
    if (!existsSync(dir)) throw new AuthError(404, 'Import staging not found - upload the manifest first');
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AuthError(400, 'Empty chunk upload');
    writeFileSync(path.join(dir, safeFile), buffer);
    return { ok: true, stamp: safeStamp, file: safeFile, bytes: buffer.length };
}

// --- Phase 4 (route order): staging + job state for the UI poll ------------
// GET /api/admin/db/import/:stamp. Reads the staged manifest + which planned
// chunk files have actually arrived + the resumable-apply cursor - everything
// the wizard needs to know whether it's still uploading, ready to apply, or
// (after a resume) partway through applying.
export async function importStagingState(stamp) {
    const safe = safeExportFilename(stamp);
    if (!safe) throw new AuthError(400, 'Invalid import stamp');
    const dir = path.join(IMPORT_ROOT, safe);
    if (!existsSync(dir)) throw new AuthError(404, 'Import staging not found');

    const manifestPath = path.join(dir, 'manifest.json');
    let manifest = null;
    if (existsSync(manifestPath)) {
        const parsed = parseManifest(readFileSync(manifestPath, 'utf8'));
        manifest = parsed.ok ? parsed.manifest : null;
    }
    const uploadPlan = manifest ? buildUploadPlan(manifest) : [];
    const onDisk = new Set(readdirSync(dir).filter(n => n !== 'manifest.json' && n !== 'progress.json'));
    const missing = uploadPlan.filter(p => !onDisk.has(p.file)).map(p => p.file);
    const done = _readProgress(dir);
    const cursor = manifest ? nextCursor(manifest, done) : null;

    return {
        stamp: safe,
        manifest_ok: manifest != null,
        schema_head: manifest?.schema_head ?? null,
        upload_plan: uploadPlan,
        total_files: uploadPlan.length,
        uploaded_files: uploadPlan.length - missing.length,
        missing_files: missing,
        ready_to_apply: manifest != null && missing.length === 0,
        applied_chunks: done.length,
        apply_complete: manifest != null && cursor == null && done.length > 0,
    };
}

// --- Phase 3: apply ----------------------------------------------------------
// POST /api/admin/db/import/apply's job body, run under the shared single-slot
// job (startImport below) exactly like the export. This is the destructive
// step - everything before it (manifest validation, chunk upload) only wrote
// to var/imports/, never touched a real table.
//
// Single dedicated connection: db.client.acquireConnection() pulls ONE
// connection out of the pool for the whole apply; every upsert below runs
// pinned to it via knex's `.connection(conn)` (query-builder method - NOT a
// db.transaction, deliberately: see the resume note below). SET
// FOREIGN_KEY_CHECKS=0/1 are plain statements on that SAME connection (not a
// session variable set once and hoped-for on whatever connection a later
// query happens to draw from the pool) - the finally block restores it and
// releases the connection back to the pool no matter how the loop exits.
//
// Why NOT a wrapping transaction: a killed process rolls back an uncommitted
// transaction when its connection drops, which would silently undo every
// chunk applied so far - exactly the opposite of resumability. Each chunk's
// insert().onConflict().merge() runs and commits on its own (MySQL
// autocommit, no explicit transaction) BEFORE progress.json is updated for
// that chunk - so a kill mid-run leaves the DB and the progress ledger
// mutually consistent, and nextCursor() picks up exactly where the DB
// actually is.
export async function runImportApply({ stamp, onStep = null, shouldCancel = null } = {}) {
    const safeStamp = safeExportFilename(stamp);
    if (!safeStamp) throw new Error('db-transfer: invalid import stamp');
    const dir = path.join(IMPORT_ROOT, safeStamp);
    if (!existsSync(dir)) throw new Error(`db-transfer: import staging "${safeStamp}" not found`);

    const manifestPath = path.join(dir, 'manifest.json');
    if (!existsSync(manifestPath)) throw new Error('db-transfer: staged manifest.json is missing');
    const staged = parseManifest(readFileSync(manifestPath, 'utf8'));
    if (!staged.ok) throw new Error(`db-transfer: staged manifest is invalid - ${staged.error}`);
    const manifest = staged.manifest;

    // Safety export FIRST - before a single row of the import is written. If
    // this throws, the whole import aborts here: nothing below has run yet,
    // so there is nothing to roll back. Deliberately excluded:[] (the
    // DEFAULT policy) rather than reusing whatever `excluded` list the
    // ORIGINAL export used - the safety net's job is to protect what's about
    // to be at risk on THIS host, not to mirror a remote export's choices.
    //
    // ONLY on the FIRST apply attempt for this stamp (fix pass 2, MEDIUM
    // finding): runImportApply re-runs from the top on a RESUMED apply too,
    // and the safety export always targets the same
    // `<stamp>-pre-import/` dir. Without this guard, a resume would take a
    // SECOND safety export capturing the now-partially-imported DB and
    // overwrite the manifest + overlapping chunks of the FIRST, pristine
    // snapshot - destroying the rollback backup in exactly the
    // killed-then-resumed scenario where it's needed most. `runExport`'s
    // `mkdirSync(dir,{recursive:true})` never clears an existing dir, so
    // simply skipping the call (rather than changing runExport itself)
    // leaves the pristine snapshot untouched. `shouldSkipSafetyExport` only
    // says yes when a VALID manifest is already there - a missing, torn, or
    // otherwise malformed prior snapshot (first run, or a previous safety
    // export that itself got killed mid-write) still takes a fresh one, so
    // requirement (b) - a valid pristine backup always exists before any
    // write - keeps holding.
    const preImportDir = path.join(EXPORT_ROOT, `${safeStamp}-pre-import`);
    const preImportManifestPath = path.join(preImportDir, 'manifest.json');
    const preImportManifestRaw = existsSync(preImportManifestPath)
        ? readFileSync(preImportManifestPath, 'utf8')
        : null;
    if (shouldSkipSafetyExport(preImportManifestRaw)) {
        _step(onStep, shouldCancel, 'safety export: reusing existing pre-import snapshot');
    } else {
        _step(onStep, shouldCancel, 'safety export: starting');
        await runExport({
            excluded: [],
            stamp: `${safeStamp}-pre-import`,
            onStep: s => _step(onStep, shouldCancel, `safety export: ${s}`),
            shouldCancel,
        });
    }

    // Re-verify schema_head from the STAGED manifest - the upload-time guard
    // (startImportManifest) is not enough on its own, since a migration can
    // run in the gap between upload and apply.
    _step(onStep, shouldCancel, 'verifying schema');
    const localHead = await schemaHead();
    if (manifest.schema_head !== localHead) {
        throw new Error(`db-transfer: schema_head mismatch at apply time (manifest=${manifest.schema_head}, local=${localHead}) - refusing to import`);
    }

    // FK-safe apply order, derived LIVE from information_schema (never
    // hardcoded - a hand-maintained dep map drifts the moment a migration
    // adds a new FK). Filtered to only the tables this manifest actually
    // carries (buildFkDeps drops edges to e.g. `users`, default-excluded).
    _step(onStep, shouldCancel, 'computing apply order');
    const tableNames = manifest.tables.map(t => t.name);
    const [fkRows] = await db.raw(
        `SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent
         FROM information_schema.KEY_COLUMN_USAGE
         WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`
    );
    const deps = buildFkDeps(fkRows, tableNames);
    let order;
    try {
        order = fkSafeOrder(tableNames, deps);
    } catch (e) {
        // A cycle means FK checks must stay off and order can't be
        // guaranteed - report it rather than guessing an order that could
        // corrupt data. Nothing has been applied yet (order is computed
        // before the apply loop below), so this is a clean abort.
        throw new Error(`db-transfer: cannot determine a safe apply order - ${e.message}`);
    }
    const byName = new Map(manifest.tables.map(t => [t.name, t]));
    const orderedManifest = { ...manifest, tables: order.map(n => byName.get(n)) };

    // Resume from the persisted cursor instead of redoing applied chunks.
    const done = _readProgress(dir);
    const cursor = nextCursor(orderedManifest, done);
    if (cursor == null) {
        return { stamp: safeStamp, applied_chunks: done.length, already_complete: true };
    }
    const startTableIdx = order.indexOf(cursor.table);

    const conn = await db.client.acquireConnection();
    try {
        await db.raw('SET FOREIGN_KEY_CHECKS=0').connection(conn);
        for (let ti = startTableIdx; ti < order.length; ti++) {
            const tableEntry = byName.get(order[ti]);
            const table = tableEntry.name;
            const totalChunks = Number(tableEntry.chunks) || 0;
            const fromChunk = table === cursor.table ? cursor.chunk : 0;
            const pkCols = String(tableEntry.pk).split(',').map(s => s.trim()).filter(Boolean);

            for (let chunk = fromChunk; chunk < totalChunks; chunk++) {
                _step(onStep, shouldCancel, `${table} chunk ${chunk + 1}/${totalChunks}`);
                const rows = _readChunkRows(path.join(dir, chunkFileName(table, chunk)));
                if (rows.length > 0) {
                    // Concurrency 1 - one chunk applied at a time, sequentially,
                    // on the SAME pinned connection (the codebase's parallel
                    // delete+insert deadlock rule, src/utils.js's _batch note).
                    await db(table).insert(rows).onConflict(pkCols).merge().connection(conn);
                }
                done.push({ table, chunk });
                _writeProgress(dir, done);
            }
        }
    } finally {
        // Restore FK checks before the connection goes anywhere near the
        // pool again. On the (near-impossible - only an already-dead
        // connection) chance this throws, DESTROY the connection instead of
        // releasing it: a plain `releaseConnection` would hand a possibly
        // still-FK-checks-off connection back to the pool, where a LATER,
        // unrelated query could silently inherit checks-off. `destroyRawConnection`
        // is knex's own eviction primitive - the mysql2 client's (inherited
        // from the mysql dialect, node_modules/knex/lib/dialects/mysql/index.js
        // ~line 95) `connection.end()` wrapper, the exact method knex's own
        // tarn pool wiring calls internally to retire a dead connection
        // (node_modules/knex/lib/client.js ~line 364-368) - so a bad-state
        // connection is closed outright and can never re-enter the pool.
        // The happy path (restore succeeded) still releases normally.
        let restored = false;
        try {
            await db.raw('SET FOREIGN_KEY_CHECKS=1').connection(conn);
            restored = true;
        } catch (e) {
            console.error('db-transfer: failed to restore FOREIGN_KEY_CHECKS on the import connection:', e?.message ?? e);
        }
        if (restored) {
            await db.client.releaseConnection(conn);
        } else {
            await db.client.destroyRawConnection(conn);
        }
    }

    return { stamp: safeStamp, applied_chunks: done.length, tables: order.length };
}

// Claim the shared job slot and run the apply without awaiting - same
// start-and-poll idiom as startExport. Returns {started:false} when a
// refresh/export/import already holds the slot (409 upstream, never queued).
export function startImport({ stamp, onDone = null } = {}) {
    const started = startJob({
        mode: 'db-import',
        dates: [],
        run: (onStep, shouldCancel) => runImportApply({ stamp, onStep, shouldCancel }),
        onFinish: onDone,
    });
    return { started };
}
