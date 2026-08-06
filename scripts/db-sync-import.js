// DB-sync IMPORT: the opposite of scripts/db-sync-export.js - restore an
// exported bundle into THIS machine's database via the M10 apply machinery
// (src/db-transfer.js): FK-safe ordered, chunk-resumable, upsert-only (never
// deletes destination rows), with a full pre-import safety export by default.
// Production-specific tables (users/sessions/prefs/visits/settings/audit/SMS)
// are protected TWICE: they never ride a bundle at all (export-side policy),
// and --skip adds import-side retention for anything else.
//
// Usage:
//   node scripts/db-sync-import.js <bundle>          # export dir OR .zip
//     [--skip <t1,t2>]     extra tables to leave untouched on THIS db
//     [--no-safety]        skip the pre-import full-warehouse safety export
//     [--stage-only]       stage into var/imports/ without applying
//     [--yes]              actually apply (without it: dry-run report only)
//
// ⚠ Run with the serve process STOPPED (or use the Admin -> Database UI,
// which serializes on the in-process job slot) - a CLI apply and a running
// serve are separate processes writing the same rows (InnoDB gap-lock rule).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stageImportFromDir, runImportApply } from '../src/db-transfer.js';
import { closeDb } from '../src/db/connection.js';

const args = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--skip']);
const positional = args.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(args[i - 1]));
function argValueOf(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
const src = positional[0];
const skipTables = (argValueOf('--skip') ?? '').split(',').map(s => s.trim()).filter(Boolean);
const safetyExport = !args.includes('--no-safety');
const stageOnly = args.includes('--stage-only');
const confirmed = args.includes('--yes');

if (!src) {
    console.error('Usage: node scripts/db-sync-import.js <bundle dir|zip> [--skip t1,t2] [--no-safety] [--stage-only] [--yes]');
    process.exit(1);
}

let tempDir = null;
try {
    let bundleDir = path.resolve(src);
    if (!existsSync(bundleDir)) {
        console.error(`[db-sync-import] "${src}" does not exist`);
        process.exit(1);
    }
    if (statSync(bundleDir).isFile() && bundleDir.toLowerCase().endsWith('.zip')) {
        tempDir = mkdtempSync(path.join(os.tmpdir(), 'oddspro-sync-'));
        console.log(`[db-sync-import] extracting ${bundleDir} ...`);
        unzipTo(bundleDir, tempDir);
        bundleDir = tempDir;
    }

    console.log(`[db-sync-import] staging bundle from ${bundleDir} ...`);
    const staged = await stageImportFromDir(bundleDir);
    console.log(`[db-sync-import] staged "${staged.stamp}": ${staged.tables} tables, ${staged.rows} rows, ${staged.files} chunk files`);
    if (skipTables.length) console.log(`[db-sync-import] import-side retention (--skip): ${skipTables.join(', ')}`);

    if (stageOnly) {
        console.log(`[db-sync-import] --stage-only: apply later with the Admin -> Database UI, SYNC_IMPORT_ON_BOOT, or re-run without --stage-only.`);
    } else if (!confirmed) {
        console.log('[db-sync-import] DRY RUN (no --yes): nothing applied. The apply is upsert-only (no destination deletes), '
            + `safety export ${safetyExport ? 'ON' : 'OFF'}. Re-run with --yes to apply.`);
    } else {
        console.log(`[db-sync-import] applying (safety export ${safetyExport ? 'ON' : 'OFF'})...`);
        const result = await runImportApply({
            stamp: staged.stamp,
            skipTables,
            safetyExport,
            onStep: s => process.stdout.write(`\r[db-sync-import] ${s}                    `),
        });
        process.stdout.write('\n');
        if (result.already_complete) {
            console.log(`[db-sync-import] bundle "${result.stamp}" was already fully applied (${result.applied_chunks} chunks).`);
        } else {
            console.log(`[db-sync-import] applied ${result.applied_chunks} chunks across ${result.tables} tables.`);
        }
    }
} finally {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    await closeDb();
}

// Cross-platform unzip (Expand-Archive on Windows, unzip elsewhere).
function unzipTo(zipPath, destDir) {
    if (process.platform === 'win32') {
        const esc = s => s.replace(/'/g, "''");
        const cmd = `Expand-Archive -Path '${esc(zipPath)}' -DestinationPath '${esc(destDir)}' -Force`;
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`Expand-Archive failed: ${r.stderr || r.error?.message}`);
    } else {
        const r = spawnSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`unzip failed (is 'unzip' installed?): ${r.stderr || r.error?.message}`);
    }
}
