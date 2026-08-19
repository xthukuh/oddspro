// Emergency file-level live patch route for the cPanel SSH host (v1.4.0+
// deploy-remote.js companion). For the rare case a single backend file needs
// a hotfix between real deploys - no zip build, no npm install, no full
// `deploy-remote.js --app` re-extract. Every write is preceded by a remote
// backup so the exact rollback command can be printed up front, and every
// JS upload is syntax-checked remotely before the fix is considered live.
//
// Usage:
//   node scripts/hotfix-remote.js <repo-relative file...> [--from <dir>] [--restart] [--dry-run]
//
// Examples:
//   node scripts/hotfix-remote.js src/utils.js
//   node scripts/hotfix-remote.js src/utils.js src/db/records.js --restart
//   node scripts/hotfix-remote.js src/utils.js --from tmp/hotfix-v1.4.0 --dry-run
//
// `--from <dir>` sources the local file(s) from `<dir>/<file>` instead of the
// repo root (e.g. a scratch checkout of a specific commit) - the remote
// destination path is always the plain repo-relative `<file>`.
//
// Safety: `.env*` paths are refused outright (before any host contact) - this
// script is for code, never secrets. Paths containing `..` or a single quote
// are refused too (repo-escape / remote-quoting hazards). Every file gets a
// `cp -n <file> <file>.orig-<stamp>` backup first (one stamp for the whole
// run, `cp -n` never clobbers an existing backup); `.js`/`.mjs`/`.cjs`
// uploads are `node --check`ed remotely and auto-rolled-back on a syntax
// error. `--restart` touches `tmp/restart.txt` (Passenger) once every file
// in the run has landed cleanly.
//
// The ssh/config plumbing lives in scripts/lib/remote.js (shared with
// deploy-remote.js) - this script adds no new ssh code of its own.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { remoteConfig, ssh as sshRemote, sshStreamUpload as sshStreamUploadRemote } from './lib/remote.js';

const REPO_ROOT = process.cwd();
const args = process.argv.slice(2);
const has = f => args.includes(f);
const argVal = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const DRY = has('--dry-run');
const RESTART = has('--restart');
const FROM = argVal('--from');

function die(msg) { console.error(`[hotfix] ERROR: ${msg}`); process.exit(1); }

// Positional args = files; `--from <dir>` consumes its value, `--restart`/
// `--dry-run` are bare flags. Anything else starting with `--` is a typo.
const files = [];
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--from') { i++; continue; }
    if (a === '--restart' || a === '--dry-run') continue;
    if (a.startsWith('--')) die(`unknown flag: ${a}`);
    files.push(a);
}
if (files.length === 0) {
    console.log('Usage: node scripts/hotfix-remote.js <repo-relative file...> [--from <dir>] [--restart] [--dry-run]');
    process.exit(1);
}

// ---- config -------------------------------------------------------------
const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
let cfg;
try {
    cfg = remoteConfig({ version });
} catch (e) {
    die(e.message);
}
const { SSH_TARGET, APP_DIR, NODE_BIN } = cfg;

const ssh = (cmd, opts = {}) => sshRemote(cfg, cmd, { dry: DRY, ...opts });
const sshStream = (localFile, remoteCmd, label, opts = {}) => sshStreamUploadRemote(cfg, localFile, remoteCmd, label, { dry: DRY, ...opts });

function utcStamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
const STAMP = utcStamp();

// Single-quote a remote path for use inside a `ssh ... '<cmd>'` shell string.
// Refuses (rather than escapes) a path containing a single quote - the
// backend never needs one and it's not worth a quoting bug on this path.
function q(p) {
    if (p.includes("'")) die(`path contains a single quote (refusing to build a remote command): ${p}`);
    return `'${p}'`;
}

// ---- validate every file BEFORE touching the host ------------------------
// One bad argument (an .env path, a `..` escape, a missing local source)
// must never leave an earlier file in the list already patched - build the
// whole plan first, dying loudly on the first violation.
const plan = files.map(rawFile => {
    const file = rawFile.replace(/\\/g, '/'); // Windows callers may pass backslashes
    const segments = file.split('/');
    if (path.posix.isAbsolute(file) || /^[a-zA-Z]:/.test(file) || segments.includes('..')) {
        die(`refusing path outside the repo: ${rawFile}`);
    }
    const base = path.posix.basename(file);
    if (/^\.env/i.test(base)) die(`refusing .env* path (secrets never travel through hotfix-remote): ${rawFile}`);
    if (file.includes("'")) die(`path contains a single quote: ${rawFile}`);

    const localDir = FROM ? path.resolve(REPO_ROOT, FROM) : REPO_ROOT;
    const source = path.join(localDir, file);
    if (!existsSync(source)) {
        die(`local source not found: ${source}${FROM ? ` (--from ${FROM})` : ''}`);
    }

    const remotePath = `${APP_DIR}/${file}`;
    const backupPath = `${remotePath}.orig-${STAMP}`;
    const remoteDir = path.posix.dirname(remotePath);
    const isJs = /\.(js|mjs|cjs)$/i.test(file);
    return { file, source, remotePath, backupPath, remoteDir, isJs };
});

console.log(`[hotfix] target ${SSH_TARGET}  app root ${APP_DIR}  stamp ${STAMP}${DRY ? '  (DRY RUN)' : ''}`);
console.log(`[hotfix] ${plan.length} file(s): ${plan.map(p => p.file).join(', ')}${RESTART ? '  (+ restart after)' : ''}`);

// ---- run ------------------------------------------------------------------
// Rollback lines are registered the moment a backup lands, not after the
// whole run succeeds - a failure partway through (die() below, or a thrown
// error) must still tell the operator how to revert every file already
// touched, not just the ones from a clean full run.
const rollbacks = []; // { file, hadBackup, backupPath, remotePath }

function printRollbacks() {
    console.log('\n[hotfix] rollback commands (run any of these to revert that one file):');
    if (rollbacks.length === 0) {
        console.log('  (none yet - no file was backed up before this run stopped)');
        return;
    }
    for (const r of rollbacks) {
        if (r.hadBackup || DRY) {
            // The whole remote command is already wrapped in ONE pair of
            // single quotes here for the operator's local shell to copy-
            // paste - q() (which itself single-quotes) must not run inside
            // that, or it breaks the quoting instead of protecting it.
            console.log(`  ssh ${SSH_TARGET} 'cp ${r.backupPath} ${r.remotePath} && touch ${APP_DIR}/tmp/restart.txt'`);
        } else {
            console.log(`  # ${r.file}: no prior remote version existed - nothing to roll back to (remove ${r.remotePath} to undo)`);
        }
    }
}

// die() that also dumps whatever rollback lines are known so far, then exits.
function dieWithRollbacks(msg) {
    console.error(`[hotfix] ERROR: ${msg}`);
    printRollbacks();
    process.exit(1);
}

async function patchOne(item) {
    const { file, source, remotePath, backupPath, remoteDir, isJs } = item;
    console.log(`\n[hotfix] === ${file} ===`);

    // 1. Backup first - only if the remote file actually exists (a brand-new
    // file has nothing to back up); `cp -n` itself would just error on a
    // missing source, so check first rather than treat that as fatal.
    let hadBackup = false;
    if (DRY) {
        console.log(`[dry-run] would check: test -f ${remotePath}`);
        console.log(`[dry-run] if present, would run: cp -n ${remotePath} ${backupPath}`);
    } else {
        const exists = ssh(`test -f ${q(remotePath)} && echo yes || echo no`).stdout === 'yes';
        if (exists) {
            ssh(`cp -n ${q(remotePath)} ${q(backupPath)}`);
            hadBackup = true;
            console.log(`[hotfix] backed up ${remotePath} -> ${backupPath}`);
        } else {
            console.log('[hotfix] remote file does not exist yet, skipping backup (new file)');
        }
    }
    // Registered as soon as the backup decision is made (even "no backup
    // needed, it's a new file") so printRollbacks() always has an entry for
    // every file that reached this point, on every exit path.
    rollbacks.push({ file, hadBackup, backupPath, remotePath });

    // 2. Upload.
    await sshStream(source, `mkdir -p ${q(remoteDir)} && cat > ${q(remotePath)}`, `upload ${file}`);

    // 3. Syntax-check JS uploads; auto-restore + die loudly on failure.
    if (isJs) {
        if (DRY) {
            console.log(`[dry-run] node --check (skipped, dry run): ${remotePath}`);
        } else {
            const check = ssh(`${NODE_BIN}/node --check ${q(remotePath)}`, { allowFail: true });
            if (check.status !== 0) {
                if (!hadBackup) {
                    dieWithRollbacks(`node --check failed for ${file} (no prior backup existed to restore, the bad upload is still live at ${remotePath})\n${check.stderr}`);
                }
                const restore = ssh(`cp ${q(backupPath)} ${q(remotePath)}`, { allowFail: true });
                if (restore.status === 0) {
                    dieWithRollbacks(`node --check failed for ${file}, restored backup from ${backupPath}\n${check.stderr}`);
                } else {
                    dieWithRollbacks(`node --check failed for ${file}, AND THE AUTO-RESTORE ALSO FAILED - ${remotePath} is NOT RESTORED, still holds the broken upload. Restore manually: ssh ${SSH_TARGET} 'cp ${backupPath} ${remotePath}'\ncheck error: ${check.stderr}\nrestore error: ${restore.stderr}`);
                }
            }
            console.log(`[hotfix] node --check OK: ${remotePath}`);
        }
    }
}

try {
    for (const item of plan) {
        await patchOne(item);
    }

    if (RESTART) {
        console.log(`\n[hotfix] restarting (touch ${APP_DIR}/tmp/restart.txt)...`);
        ssh(`mkdir -p ${q(APP_DIR)}/tmp && touch ${q(APP_DIR)}/tmp/restart.txt`);
    }

    console.log('\n[hotfix] done.');
    printRollbacks();
} catch (e) {
    dieWithRollbacks(e.message);
}
