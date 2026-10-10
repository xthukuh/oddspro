// Emergency file-level live patch route for the cPanel SSH host (v1.4.0+
// deploy-remote.js companion). For the rare case a single backend file needs
// a hotfix between real deploys - no zip build, no npm install, no full
// `deploy-remote.js --app` re-extract.
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
// ONE upload, ONE remote apply (2026-10 rework): the original version opened
// roughly five ssh connections PER FILE (probe/backup/mkdir/upload/check),
// which a shared host under load was observed resetting mid-run, landing a
// half-applied set (docs/agents/toolset.md, 2026-08-29). This version builds
// a local tarball of the files plus a generated POSIX apply script
// (scripts/lib/hotfix-rules.js's buildApplyScript), and sends the whole
// thing over a SINGLE ssh call that extracts it into a stamp-scoped staging
// dir under the remote user's own home and runs the apply script:
//
//   ssh <target> 'mkdir -p ~/tmp/hotfix-<stamp> && tar -xzf - -C ~/tmp/hotfix-<stamp> && sh ~/tmp/hotfix-<stamp>/apply.sh'
//
// (`~` resolves to whatever the remote user's home actually is - never a
// hardcoded /home or /home2 prefix; the live host's home directory has
// already moved once). The apply script itself does the per-file work with
// no further network round trips: back up (`cp -n <file> <file>.orig-<stamp>`,
// skipped + noted for a brand-new file), install, `node --check` a
// .js/.mjs/.cjs file, print its md5sum - and on ANY failure, restore every
// file this run already touched from its backup (or remove it, if it was
// new) before exiting non-zero. A `&&`-chained tar extract also means a
// truncated/corrupted transfer never even reaches the apply script, so
// nothing in APP_DIR is touched by a transfer that didn't fully land.
//
// Safety: `.env*` paths are refused outright (before any host contact), and
// every file argument must match a safe character allow-list (letters,
// digits, '.', '_', '-', '/') with no `..`/absolute segment - both checked by
// scripts/lib/hotfix-rules.js's validateRelativePath, tested in
// tests/hotfix-rules.test.js. `--restart` touches `tmp/restart.txt`
// (Passenger) once every file in the run has landed cleanly.
//
// The ssh/config plumbing lives in scripts/lib/remote.js (shared with
// deploy-remote.js) - this script adds no new ssh code of its own beyond
// remote.js's sshStreamApply.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { remoteConfig, sshStreamApply } from './lib/remote.js';
import {
    parseHotfixArgs, validateRelativePath, utcStamp, buildRemoteApplyCommand,
    buildApplyScript, parseApplyOutput, formatRollbackLine,
} from './lib/hotfix-rules.js';

const REPO_ROOT = process.cwd();

function die(msg) { console.error(`[hotfix] ERROR: ${msg}`); process.exit(1); }

let parsed;
try {
    parsed = parseHotfixArgs(process.argv.slice(2));
} catch (e) { die(e.message); }
const { files: rawFiles, FROM, RESTART, DRY } = parsed;

if (rawFiles.length === 0) {
    console.log('Usage: node scripts/hotfix-remote.js <repo-relative file...> [--from <dir>] [--restart] [--dry-run]');
    process.exit(1);
}

// ---- validate every file BEFORE touching the host --------------------------
// Build the whole plan first, dying loudly on the first violation - one bad
// argument (an .env path, a `..` escape, a missing local source) must never
// leave an earlier file in the list already staged.
const plan = rawFiles.map(rawFile => {
    let file;
    try {
        file = validateRelativePath(rawFile);
    } catch (e) { die(e.message); }

    const localDir = FROM ? path.resolve(REPO_ROOT, FROM) : REPO_ROOT;
    const source = path.join(localDir, file);
    if (!existsSync(source)) {
        die(`local source not found: ${source}${FROM ? ` (--from ${FROM})` : ''}`);
    }
    const isJs = /\.(js|mjs|cjs)$/i.test(file);
    return { file, source, isJs };
});

// ---- config ------------------------------------------------------------------
const version = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
let cfg;
try {
    cfg = remoteConfig({ version });
} catch (e) { die(e.message); }
const { SSH_TARGET, APP_DIR, NODE_BIN } = cfg;

const STAMP = utcStamp();

console.log(`[hotfix] target ${SSH_TARGET}  app root ${APP_DIR}  stamp ${STAMP}${DRY ? '  (DRY RUN)' : ''}`);
console.log(`[hotfix] ${plan.length} file(s): ${plan.map(p => p.file).join(', ')}${RESTART ? '  (+ restart after)' : ''}`);

// ---- stage locally: copy files + generated apply.sh into one directory -----
const localMd5 = new Map(); // file -> hex md5, computed before anything leaves this machine
const stagingDir = mkdtempSync(path.join(os.tmpdir(), 'oddspro-hotfix-'));
let tarPath = null;
try {
    for (const item of plan) {
        const bytes = readFileSync(item.source);
        localMd5.set(item.file, createHash('md5').update(bytes).digest('hex'));
        const destPath = path.join(stagingDir, item.file);
        mkdirSync(path.dirname(destPath), { recursive: true });
        copyFileSync(item.source, destPath);
    }

    const applyScript = buildApplyScript({
        stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN,
        files: plan.map(p => p.file), restart: RESTART,
    });
    writeFileSync(path.join(stagingDir, 'apply.sh'), applyScript);

    const remoteCmd = buildRemoteApplyCommand(STAMP);

    if (DRY) {
        console.log('\n[dry-run] generated apply.sh:\n' + applyScript);
        console.log(`[dry-run] would run: ssh ${SSH_TARGET} '${remoteCmd}'`);
        console.log('[dry-run] local file md5sums:');
        for (const [file, md5] of localMd5) console.log(`  ${md5}  ${file}`);
        process.exit(0);
    }

    // ---- tar the staging dir into a single archive -------------------------
    tarPath = path.join(os.tmpdir(), `oddspro-hotfix-${STAMP}.tar.gz`);
    const tar = spawnSync('tar', ['-czf', tarPath, '-C', stagingDir, '.'], { encoding: 'utf8' });
    if (tar.status !== 0) {
        die(`failed to build the local tarball (exit ${tar.status}): ${(tar.stderr || '').trim()}`);
    }

    // ---- the one remote call: upload + extract + apply ----------------------
    console.log(`\n[hotfix] ssh ${SSH_TARGET} '${remoteCmd}'`);
    const result = await sshStreamApply(cfg, tarPath, remoteCmd, 'upload+apply');
    const report = parseApplyOutput(result.stdout);

    // ---- report --------------------------------------------------------------
    console.log('\n[hotfix] per-file result:');
    for (const item of plan) {
        const r = report.files[item.file];
        if (!r) {
            console.log(`  ${item.file}: NO RESULT (run aborted before this file - see above)`);
            continue;
        }
        const md5Match = r.md5 && localMd5.get(item.file) === r.md5
            ? 'md5 OK' : r.md5 ? `md5 MISMATCH (local ${localMd5.get(item.file)}, remote ${r.md5})` : 'no md5 (not installed)';
        console.log(`  ${item.file}: backup=${r.backedUp ? 'yes' : 'no'}${item.isJs ? ` check=${r.checked ? 'ok' : 'FAILED'}` : ''} ${md5Match}${r.failed ? ` FAIL(${r.failReason})` : ''}`);
    }

    if (result.status !== 0 || !report.ok) {
        console.error(`\n[hotfix] FAILED (remote exit ${result.status}).`);
        if (report.aborted) console.error(`[hotfix] aborted at: ${report.aborted}`);
        if (report.rolledBack.length || report.removed.length) {
            console.error(`[hotfix] server-side rollback already restored: ${[...report.rolledBack, ...report.removed].join(', ') || '(none)'}`);
        }
        process.exit(1);
    }

    for (const [file, md5] of localMd5) {
        const remoteMd5 = report.files[file]?.md5;
        if (remoteMd5 && remoteMd5 !== md5) {
            die(`post-apply md5 mismatch for ${file}: local ${md5}, remote ${remoteMd5} - investigate before trusting this run`);
        }
    }

    console.log('\n[hotfix] done.' + (report.restarted ? ' (restarted)' : ''));
    console.log('\n[hotfix] rollback commands (run any of these to revert that one file):');
    for (const item of plan) {
        const hadBackup = report.files[item.file]?.backedUp === true;
        console.log(formatRollbackLine({ sshTarget: SSH_TARGET, appDir: APP_DIR, file: item.file, stamp: STAMP, hadBackup }));
    }
} finally {
    // Local staging is scratch - always clean it up, success or failure. The
    // REMOTE staging dir (~/tmp/hotfix-<stamp>) is deliberately left in
    // place, same ethos as the .orig-<stamp> backups: evidence for the next
    // person to look at, not litter to race to delete.
    rmSync(stagingDir, { recursive: true, force: true });
    if (tarPath) rmSync(tarPath, { force: true });
}
