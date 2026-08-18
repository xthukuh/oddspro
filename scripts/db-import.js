// The reverse of db-export.js: streams a gzipped SQL dump into the local
// Docker MySQL/MariaDB database, gzip-decompressing on the fly (the dump
// never touches disk decompressed). Usage:
//   node scripts/db-import.js <file.sql.gz> [--container <name>] [--database <name>] [--yes] [--no-preamble]
// Refuses to run without --yes (it OVERWRITES data in the target database).
// Container/client resolution mirrors db-export.js: --container >
// DB_DOCKER_CONTAINER env > auto-detect; client binary prefers `mariadb`
// over `mysql` (the container's dump binary preference, mirrored).
//
// Also importable: importDb({ inPath, container, database, preamble,
// onProgress }) resolves { bytes, seconds } and throws on failure (the
// thrown Error carries .exitCode when the client itself exited non-zero, so
// a caller can propagate that exact code). Importing this module never runs
// the CLI (main-module gate at the bottom, same idiom as db-export.js).

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config } from '../src/config.js';
import { resolveContainer } from './db-export.js';
import { importPreamble } from './lib/sync-rules.js';

function resolveClientBinary(container) {
    const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], { encoding: 'utf8' });
    if (inspect.status !== 0) throw new Error(`no container named "${container}" - check "docker ps".`);
    if (inspect.stdout.trim() !== 'true') throw new Error(`container "${container}" exists but isn't running.`);
    for (const bin of ['mariadb', 'mysql']) {
        const res = spawnSync('docker', ['exec', container, 'which', bin], { encoding: 'utf8' });
        if (res.status === 0) return bin;
    }
    throw new Error(`neither mariadb nor mysql client found inside container "${container}".`);
}

// Import inPath (gzipped SQL) into `database`. Progress is reported against
// the COMPRESSED (gz) byte count read from disk, since that's the only total
// known up front - onProgress({ bytes, total, seconds }) fires per chunk.
export async function importDb({ inPath, container = null, database = config.DB_DATABASE, preamble = true, onProgress = null }) {
    if (!existsSync(inPath)) throw new Error(`input file not found: ${inPath}`);
    const name = resolveContainer(container || process.env.DB_DOCKER_CONTAINER || null);
    const clientBin = resolveClientBinary(name);
    console.log(`[db-import] using ${clientBin} in container "${name}" for database "${database}".`);

    const total = statSync(inPath).size;
    const started = Date.now();

    const child = spawn('docker', ['exec', '-i', '-e', `MYSQL_PWD=${config.DB_PASSWORD}`, name, clientBin, `-u${config.DB_USERNAME}`, database]);
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    child.stdin.on('error', () => {}); // EPIPE if the client exits early - the close handler reports the real failure

    if (preamble) child.stdin.write(importPreamble());

    let read = 0;
    const src = createReadStream(inPath, { highWaterMark: 1048576 });
    const gunzip = createGunzip();
    src.on('data', chunk => {
        read += chunk.length;
        if (onProgress) onProgress({ bytes: read, total, seconds: (Date.now() - started) / 1000 });
    });
    src.pipe(gunzip).pipe(child.stdin);

    const exitCode = await new Promise((resolve, reject) => {
        child.on('error', e => reject(new Error(`docker exec failed to start: ${e.message}`)));
        child.on('close', resolve);
        src.on('error', e => reject(new Error(`read failed: ${e.message}`)));
        gunzip.on('error', e => reject(new Error(`gunzip failed (is "${inPath}" actually gzipped?): ${e.message}`)));
    });

    if (exitCode !== 0) {
        const err = new Error(`import exited ${exitCode}:\n${stderr.trim()}`);
        err.exitCode = exitCode;
        throw err;
    }
    return { bytes: total, seconds: (Date.now() - started) / 1000 };
}

// --- CLI entry -----------------------------------------------------------
function parseArgs(argv) {
    const flags = {};
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--container' || a === '--database') flags[a.slice(2)] = argv[++i];
        else if (a === '--yes' || a === '--no-preamble') flags[a.slice(2)] = true;
        else positional.push(a);
    }
    return { flags, positional };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const { flags, positional } = parseArgs(process.argv.slice(2));
    const inPath = positional[0];
    if (!inPath) {
        console.error('Usage: node scripts/db-import.js <file.sql.gz> [--container <name>] [--database <name>] [--yes] [--no-preamble]');
        process.exit(1);
    }
    if (!existsSync(inPath)) {
        console.error(`[db-import] ERROR: file not found: ${inPath}`);
        process.exit(1);
    }
    const container = flags.container || null;
    const database = flags.database || config.DB_DATABASE;
    const preamble = !flags['no-preamble'];
    const size = statSync(inPath).size;

    console.log(`[db-import] target database "${database}" <- ${inPath} (${(size / 1048576).toFixed(1)} MB gzipped)`);
    if (!flags.yes) {
        console.error('[db-import] refusing to import without --yes (this OVERWRITES data in the target database).');
        process.exit(1);
    }

    let lastDraw = 0;
    try {
        const result = await importDb({
            inPath, container, database, preamble,
            onProgress: ({ bytes, total, seconds }) => {
                const now = Date.now();
                if (now - lastDraw < 250 && bytes !== total) return;
                lastDraw = now;
                const pct = total ? (bytes / total * 100).toFixed(1) : '0.0';
                const rate = bytes / Math.max(seconds, 0.001) / 1048576;
                const eta = rate > 0 ? Math.max(0, (total - bytes) / (rate * 1048576)) : 0;
                process.stdout.write(`\r[db-import] ${pct}%  ${(bytes / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB  ${rate.toFixed(1)} MB/s  ETA ${Math.ceil(eta)}s   `);
            },
        });
        process.stdout.write('\n');
        console.log(`[db-import] done: ${(result.bytes / 1048576).toFixed(1)} MB in ${result.seconds.toFixed(1)}s.`);
    } catch (e) {
        process.stdout.write('\n');
        console.error(`[db-import] ERROR: ${e.message}`);
        process.exit(e.exitCode || 1);
    }
}
