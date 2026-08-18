// SSH deploy/sync helpers shared by scripts/deploy-remote.js and a future
// scripts/db-sync.js - extracted verbatim (same behavior) from
// deploy-remote.js's original private helpers so a second script never grows
// its own drifting copy of "how we talk to the cPanel host".
//
// Every function here takes `cfg` (built by remoteConfig()) first. Unlike
// scripts/lib/sync-rules.js this module is NOT pure (it spawns ssh, touches
// the filesystem) - it throws plain Error on failure and leaves the `die()`
// decision (print + exit) to the calling script, so the same helpers work
// whether the caller wants to abort immediately or catch and report.

import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import dotenv from 'dotenv';

export const fmtMB = b => `${(b / 1048576).toFixed(1)} MB`;

// Mask the DB password in any printed/logged command line - dry-run echoes
// and thrown-error messages both embed `cfg.MYSQL_ENV` (MYSQL_PWD='<pass>')
// verbatim inside the command text, and that text used to reach the console
// in plaintext. Only what's PRINTED is touched here; the real `cmd`/`input`
// handed to spawn/spawnSync (what's actually executed over ssh) never goes
// through this function.
function redact(cfg, text) {
    if (!cfg || !cfg.DB_PASS || !text) return text;
    return text.split(cfg.DB_PASS).join('***');
}

// Reads .env.deploy (gitignored) layered over the same defaults
// deploy-remote.js has always used. `version` (package.json's version, read
// by the caller - keeping filesystem reads of package.json out of this
// module) drives the two paths/names that derive from it.
export function remoteConfig({ version }) {
    const dep = existsSync('.env.deploy') ? dotenv.parse(readFileSync('.env.deploy', 'utf8')) : {};
    const SSH_TARGET = dep.DEPLOY_SSH || 'oddsprok@oddspro-p';
    const REMOTE_HOME = dep.DEPLOY_REMOTE_HOME || '/home2/oddsprok';
    const APP_DIR = dep.DEPLOY_APP_DIR || `${REMOTE_HOME}/oddspro-app-v${version}`;
    const WEB_DIR = dep.DEPLOY_WEB_DIR || `${REMOTE_HOME}/public_html`;
    const DB_NAME = dep.DEPLOY_DB_NAME || `oddsprok_prod_${version.replace(/\./g, '_')}`;
    const DB_USER = dep.DEPLOY_DB_USER || 'oddsprok_root';
    const DB_PASS = dep.DEPLOY_DB_PASSWORD ?? '';
    const NODE_BIN = dep.DEPLOY_NODE_BIN || `${REMOTE_HOME}/.nvm/versions/node/v24.18.0/bin`;
    const TMP_DIR = `${REMOTE_HOME}/tmp/deploy`;

    // Remote commands run under `bash -c` via ssh; the DB password rides the
    // environment of the remote command (single-quoted - no single quotes allowed).
    if (DB_PASS.includes("'")) throw new Error('DEPLOY_DB_PASSWORD may not contain single quotes (remote quoting).');
    const MYSQL_ENV = `MYSQL_PWD='${DB_PASS}'`;

    return { SSH_TARGET, REMOTE_HOME, APP_DIR, WEB_DIR, DB_NAME, DB_USER, DB_PASS, NODE_BIN, TMP_DIR, MYSQL_ENV };
}

// Run a remote command, capturing (or inheriting) stdout/stderr.
export function ssh(cfg, cmd, { capture = true, allowFail = false, dry = false } = {}) {
    if (dry) { console.log(`[dry-run] ssh: ${redact(cfg, cmd)}`); return { status: 0, stdout: '' }; }
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', cfg.SSH_TARGET, cmd],
        { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'], maxBuffer: 64 * 1048576 });
    if (r.status !== 0 && !allowFail) {
        throw new Error(`remote command failed (${r.status}): ${redact(cfg, cmd)}\n${redact(cfg, (r.stderr || '').trim())}`);
    }
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Run a remote command feeding `input` on stdin - used for every SQL snippet
// so quoting hazards (a scrypt hash's $-runs, backticks) never touch the
// remote shell.
export function sshInput(cfg, cmd, input, { allowFail = false, dry = false } = {}) {
    if (dry) {
        console.log(`[dry-run] ssh(stdin ${input.length}B): ${redact(cfg, cmd)}\n${redact(cfg, input).split('\n').map(l => `    | ${l}`).join('\n')}`);
        return { status: 0, stdout: '' };
    }
    const r = spawnSync('ssh', ['-o', 'BatchMode=yes', cfg.SSH_TARGET, cmd],
        { encoding: 'utf8', input, maxBuffer: 64 * 1048576 });
    if (r.status !== 0 && !allowFail) {
        throw new Error(`remote command failed (${r.status}): ${redact(cfg, cmd)}\n${redact(cfg, (r.stderr || '').trim())}`);
    }
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// Stream a local file into `remoteCmd`'s stdin with a byte-progress meter
// (total known up front from the local file size). Rejects (never crashes
// the process) on a source-read failure or a remote-side non-zero exit;
// `child.stdin`'s own 'error' listener swallows the EPIPE that fires when
// the remote side closes early - the 'close' handler below reports the real
// failure from the captured exit code + stderr.
export function sshStreamUpload(cfg, localFile, remoteCmd, label, { dry = false } = {}) {
    if (dry) { console.log(`[dry-run] stream ${localFile} -> ssh: ${redact(cfg, remoteCmd)}`); return Promise.resolve(); }
    const total = statSync(localFile).size;
    const started = Date.now();
    let sent = 0, lastDraw = 0;
    const child = spawn('ssh', ['-o', 'BatchMode=yes', cfg.SSH_TARGET, remoteCmd], { stdio: ['pipe', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    child.stdin.on('error', () => {}); // EPIPE if the remote side exits early - 'close' below reports the real failure
    const src = createReadStream(localFile, { highWaterMark: 1048576 });
    src.on('data', chunk => {
        sent += chunk.length;
        const now = Date.now();
        if (now - lastDraw > 250 || sent === total) {
            lastDraw = now;
            const pct = (sent / total * 100).toFixed(1);
            const secs = (now - started) / 1000;
            const rate = sent / Math.max(secs, 0.001) / 1048576;
            const eta = rate > 0 ? Math.max(0, (total - sent) / (rate * 1048576)) : 0;
            process.stdout.write(`\r[deploy] ${label}: ${pct}%  ${fmtMB(sent)}/${fmtMB(total)}  ${rate.toFixed(2)} MB/s  ETA ${Math.ceil(eta)}s   `);
        }
    });
    src.pipe(child.stdin);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = fn => { if (settled) return; settled = true; process.stdout.write('\n'); fn(); };
        src.on('error', e => finish(() => { child.kill(); reject(new Error(`${label} failed: reading "${localFile}": ${e.message}`)); }));
        child.on('error', e => finish(() => reject(new Error(`ssh failed to start: ${e.message}`))));
        child.on('close', code => finish(() => {
            if (code !== 0) reject(new Error(`${label} failed (exit ${code}): ${redact(cfg, stderr.trim())}`));
            else resolve();
        }));
    });
}

// Stream `remoteCmd`'s stdout into a local file with a byte-progress meter -
// the reverse of sshStreamUpload, for pulling a remote dump down (db-sync's
// job). Total is unknown up front (the remote side never reports a
// Content-Length), so the meter shows bytes received + throughput + elapsed
// time rather than a percentage/ETA. Rejects (never crashes the process) on
// a destination-write failure (disk full, permission denied) or a
// remote-side non-zero exit.
export function sshStreamDownload(cfg, remoteCmd, localFile, label, { dry = false } = {}) {
    if (dry) { console.log(`[dry-run] ssh: ${redact(cfg, remoteCmd)} -> ${localFile}`); return Promise.resolve(); }
    const started = Date.now();
    let received = 0, lastDraw = 0;
    const child = spawn('ssh', ['-o', 'BatchMode=yes', cfg.SSH_TARGET, remoteCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => stderr += d);
    const out = createWriteStream(localFile);
    child.stdout.on('data', chunk => {
        received += chunk.length;
        const now = Date.now();
        if (now - lastDraw > 250) {
            lastDraw = now;
            const secs = (now - started) / 1000;
            const rate = received / Math.max(secs, 0.001) / 1048576;
            process.stdout.write(`\r[deploy] ${label}: ${fmtMB(received)} received  ${rate.toFixed(2)} MB/s  ${secs.toFixed(0)}s   `);
        }
    });
    child.stdout.pipe(out);
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = fn => { if (settled) return; settled = true; process.stdout.write('\n'); fn(); };
        out.on('error', e => finish(() => { child.kill(); reject(new Error(`${label} failed: writing "${localFile}": ${e.message}`)); }));
        child.on('error', e => finish(() => reject(new Error(`ssh failed to start: ${e.message}`))));
        child.on('close', code => finish(() => {
            if (code !== 0) reject(new Error(`${label} failed (exit ${code}): ${redact(cfg, stderr.trim())}`));
            else resolve();
        }));
    });
}
