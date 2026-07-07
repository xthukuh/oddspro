// Dumps the local Docker MySQL/MariaDB database, gzipped, for phpMyAdmin
// import on the remote host (see docs/DEPLOYMENT.md). No CREATE DATABASE in
// the dump - correct for importing into an already-created, differently-
// named cPanel database. Usage:
//   node scripts/db-export.js [--container <name>]
// Container resolution: --container > DB_DOCKER_CONTAINER env > auto-detect
// (docker ps filtered on a mysql/mariadb image exposing 3306).

import { spawnSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { config } from '../src/config.js';

function die(msg) {
    console.error(`[db-export] ERROR: ${msg}`);
    process.exit(1);
}

const args = process.argv.slice(2);
const i = args.indexOf('--container');
const explicitContainer = i >= 0 ? args[i + 1] : (process.env.DB_DOCKER_CONTAINER || null);

function resolveContainer() {
    if (explicitContainer) return explicitContainer;
    const res = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Ports}}'], { encoding: 'utf8' });
    if (res.status !== 0) die(`docker ps failed: ${res.stderr || res.error?.message}`);
    const candidates = res.stdout.trim().split('\n').filter(Boolean)
        .map(line => line.split('\t'))
        .filter(([, image, ports]) => /mysql|mariadb/i.test(image) && /:3306->/.test(ports));
    if (candidates.length === 1) {
        console.log(`[db-export] auto-detected container "${candidates[0][0]}" (${candidates[0][1]}).`);
        return candidates[0][0];
    }
    console.error(`[db-export] could not auto-detect a single MySQL/MariaDB container on port 3306.`);
    console.error(candidates.length ? `Candidates:\n${candidates.map(c => `  ${c[0]}\t${c[1]}\t${c[2]}`).join('\n')}` : 'No candidates found.');
    console.error(`Pass --container <name> explicitly. Lookup: docker ps --format "table {{.Names}}\\t{{.Image}}\\t{{.Ports}}"`);
    process.exit(1);
}

function resolveDumpBinary(container) {
    const inspect = spawnSync('docker', ['inspect', '--format', '{{.State.Running}}', container], { encoding: 'utf8' });
    if (inspect.status !== 0) die(`no container named "${container}" - check "docker ps".`);
    if (inspect.stdout.trim() !== 'true') die(`container "${container}" exists but isn't running.`);
    for (const bin of ['mariadb-dump', 'mysqldump']) {
        const res = spawnSync('docker', ['exec', container, 'which', bin], { encoding: 'utf8' });
        if (res.status === 0) return bin;
    }
    die(`neither mariadb-dump nor mysqldump found inside container "${container}".`);
}

const container = resolveContainer();
const dumpBin = resolveDumpBinary(container);
console.log(`[db-export] using ${dumpBin} in container "${container}" for database "${config.DB_DATABASE}".`);

const backupsDir = path.join(process.cwd(), 'backups');
if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const outPath = path.join(backupsDir, `oddspro_${stamp}.sql.gz`);

const dumpArgs = [
    'exec', '-e', `MYSQL_PWD=${config.DB_PASSWORD}`, container, dumpBin,
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

dump.on('error', e => die(`docker exec failed to start: ${e.message}`));

const exitCode = await new Promise(resolve => dump.on('close', resolve));
await new Promise(resolve => out.on('close', resolve));

if (exitCode !== 0) {
    if (existsSync(outPath)) unlinkSync(outPath);
    die(`dump exited ${exitCode}:\n${stderr.trim()}`);
}

const { size } = statSync(outPath);
console.log(`[db-export] wrote ${outPath} (${(size / 1024).toFixed(1)} KB).`);
console.log(`[db-export] import via phpMyAdmin's upload UI (gzip is imported natively) - check upload_max_filesize/post_max_size if it's large.`);
