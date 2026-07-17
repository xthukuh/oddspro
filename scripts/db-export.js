// Dumps the local Docker MySQL/MariaDB database, gzipped, for phpMyAdmin
// import on the remote host (see docs/DEPLOYMENT.md). No CREATE DATABASE in
// the dump - correct for importing into an already-created, differently-
// named cPanel database. Usage:
//   node scripts/db-export.js [--container <name>]
// Container resolution: --container > DB_DOCKER_CONTAINER env > auto-detect
// (docker ps filtered on a mysql/mariadb image exposing 3306).
//
// Also importable: exportDb({ outPath, container }) runs the same dump to an
// explicit path and throws on failure (used by package-deploy.js --export-db).
// Importing this module never runs the CLI (main-module gate at the bottom).

import { spawnSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';

function resolveContainer(explicit) {
    if (explicit) return explicit;
    const res = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`docker ps failed: ${res.stderr || res.error?.message}`);
    const candidates = res.stdout.trim().split('\n').filter(Boolean)
        .map(line => line.split('\t'))
        .filter(([, image, ports]) => /mysql|mariadb/i.test(image) && /:3306->/.test(ports));
    if (candidates.length === 1) {
        console.log(`[db-export] auto-detected container "${candidates[0][0]}" (${candidates[0][1]}).`);
        return candidates[0][0];
    }
    throw new Error(
        'could not auto-detect a single MySQL/MariaDB container on port 3306.\n'
        + (candidates.length ? `Candidates:\n${candidates.map(c => `  ${c[0]}\t${c[1]}\t${c[2]}`).join('\n')}\n` : 'No candidates found.\n')
        + 'Pass --container <name> explicitly. Lookup: docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Ports}}"');
}

function resolveDumpBinary(container) {
    const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], { encoding: 'utf8' });
    if (inspect.status !== 0) throw new Error(`no container named "${container}" - check "docker ps".`);
    if (inspect.stdout.trim() !== 'true') throw new Error(`container "${container}" exists but isn't running.`);
    for (const bin of ['mariadb-dump', 'mysqldump']) {
        const res = spawnSync('docker', ['exec', container, 'which', bin], { encoding: 'utf8' });
        if (res.status === 0) return bin;
    }
    throw new Error(`neither mariadb-dump nor mysqldump found inside container "${container}".`);
}

// Dump the configured database, gzipped, to outPath. Resolves { path, bytes };
// throws on any failure so the caller decides how to die.
export async function exportDb({ outPath, container = null }) {
    const name = resolveContainer(container || process.env.DB_DOCKER_CONTAINER || null);
    const dumpBin = resolveDumpBinary(name);
    console.log(`[db-export] using ${dumpBin} in container "${name}" for database "${config.DB_DATABASE}".`);

    const outDir = path.dirname(outPath);
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const dumpArgs = [
        'exec', '-e', `MYSQL_PWD=${config.DB_PASSWORD}`, name, dumpBin,
        `-u${config.DB_USERNAME}`,
        '--single-transaction', '--routines', '--triggers', '--events',
        '--no-tablespaces', '--default-character-set=utf8mb4',
        config.DB_DATABASE,
    ];

    const dump = spawn('docker', dumpArgs);
    const gzip = createGzip();
    const out = createWriteStream(outPath);
    let stderr = '';
    dump.stderr.on('data', d => stderr += d);
    dump.stdout.pipe(gzip).pipe(out);

    let exitCode;
    try {
        exitCode = await new Promise((resolve, reject) => {
            dump.on('error', e => reject(new Error(`docker exec failed to start: ${e.message}`)));
            dump.on('close', resolve);
        });
    } catch (e) {
        out.destroy();
        if (existsSync(outPath)) unlinkSync(outPath);
        throw e;
    }
    await new Promise(resolve => out.on('close', resolve));

    if (exitCode !== 0) {
        if (existsSync(outPath)) unlinkSync(outPath);
        throw new Error(`dump exited ${exitCode}:\n${stderr.trim()}`);
    }
    return { path: outPath, bytes: statSync(outPath).size };
}

// --- CLI entry (byte-compatible with the pre-refactor script) ----------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const args = process.argv.slice(2);
    const i = args.indexOf('--container');
    const cliContainer = i >= 0 ? args[i + 1] : null;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
    const outPath = path.join(process.cwd(), 'backups', `oddspro_${stamp}.sql.gz`);
    try {
        const { bytes } = await exportDb({ outPath, container: cliContainer });
        console.log(`[db-export] wrote ${outPath} (${(bytes / 1024).toFixed(1)} KB).`);
        console.log(`[db-export] import via phpMyAdmin's upload UI (gzip is imported natively) - check upload_max_filesize/post_max_size if it's large.`);
    } catch (e) {
        console.error(`[db-export] ERROR: ${e.message}`);
        process.exit(1);
    }
}
