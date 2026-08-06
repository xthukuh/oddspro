// DB-sync EXPORT: the portable warehouse bundle for deploy data sync - the
// pure-Node twin of scripts/db-export.js (which needs mariadb-dump in a Docker
// container and produces a phpMyAdmin SQL dump). This one rides the M10
// NDJSON+gzip machinery (src/db-transfer.js runExport): chunked, manifest'd,
// FK-safe on import, and PROD-RETENTIVE by construction - users, sessions,
// prefs, visits, settings, audit and SMS tables never ride a bundle
// (src/db/transfer-rules.js DEFAULT_EXCLUDED_TABLES).
//
// Usage:
//   node scripts/db-sync-export.js [--zip <out.zip>] [--exclude <t1,t2>]
//
// Output: var/exports/<stamp>/ (manifest.json + <table>.NNNN.ndjson.gz), and
// with --zip a single archive of that directory's CONTENTS ready to upload +
// extract into the remote app's var/imports/<stamp>/ (cPanel File Manager),
// where the admin Database section or SYNC_IMPORT_ON_BOOT applies it.
// The counterpart CLI is scripts/db-sync-import.js.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runExport, EXPORT_ROOT } from '../src/db-transfer.js';
import { closeDb } from '../src/db/connection.js';

const args = process.argv.slice(2);
function argValue(flag) {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const zipOut = argValue('--zip');
const extraExcluded = (argValue('--exclude') ?? '').split(',').map(s => s.trim()).filter(Boolean);

try {
    console.log('[db-sync-export] exporting warehouse bundle (prod-specific tables excluded by policy)...');
    const result = await runExport({
        excluded: extraExcluded,
        onStep: s => process.stdout.write(`\r[db-sync-export] ${s}                    `),
    });
    process.stdout.write('\n');
    const dir = path.join(EXPORT_ROOT, result.stamp);
    console.log(`[db-sync-export] wrote ${dir} - ${result.tables} tables, ${result.rows} rows`);
    console.log(`[db-sync-export] excluded (never ride a sync bundle): ${result.excluded.join(', ')}`);

    if (zipOut) {
        const outZip = path.resolve(zipOut);
        const outDir = path.dirname(outZip);
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        zipDirContents(dir, outZip);
        console.log(`[db-sync-export] zipped -> ${outZip}`);
        console.log(`[db-sync-export] remote: upload + extract into <app root>/var/imports/${result.stamp}/ then apply via Admin -> Database, or set SYNC_IMPORT_ON_BOOT=1 and Restart.`);
    } else {
        console.log(`[db-sync-export] local restore: node scripts/db-sync-import.js ${dir}`);
    }
} finally {
    await closeDb();
}

// Same cross-platform helper as package-deploy.js zipDirContents (contents at
// the archive root, so an extract lands manifest.json + chunks directly).
function zipDirContents(srcDir, outZip) {
    if (process.platform === 'win32') {
        const esc = s => s.replace(/'/g, "''");
        const cmd = `Compress-Archive -Path '${esc(srcDir)}\\*' -DestinationPath '${esc(outZip)}' -Force`;
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`Compress-Archive failed: ${r.stderr || r.error?.message}`);
    } else {
        if (existsSync(outZip)) rmSync(outZip);
        const r = spawnSync('zip', ['-r', '-q', outZip, '.'], { cwd: srcDir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`zip failed (is 'zip' installed?): ${r.stderr || r.error?.message}`);
    }
}
