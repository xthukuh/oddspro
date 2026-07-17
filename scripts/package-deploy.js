// Builds the upload archives for the manual cPanel deploy (see
// docs/DEPLOYMENT.md), so a deploy is "run this, upload the zips":
//   1. oddspro-app_<ts>.zip  - the BACKEND app tree (tracked files minus web/),
//      extracted into the Node app's Application Root (e.g. oddspro-app).
//   2. oddspro-web_<ts>.zip   - the built FRONTEND (web/dist contents at the
//      zip root), extracted into public_html.
//   3. (only with --export-db) oddspro-db_<ts>.sql.gz - a gzipped dump of the
//      local Docker DB via db-export.js exportDb(), same <ts> as the zips so
//      one release = one matching artifact set.
// Usage: node scripts/package-deploy.js [--out-dir <dir>] [--export-db]
//
// RELEASE RULE: releases are built from `main` only; version tags exist only
// on `main` (every other branch is feature work). The script refuses to run
// off-main (deliberately NO auto-checkout - least astonishment), and after
// ALL artifacts succeed it idempotently tags HEAD as v<package.json version>
// and pushes the tag. An existing tag is never recreated; if it no longer
// points at HEAD you get a loud "bump the version" warning instead.
//
// Dependency-free unless --export-db is passed: the backend zip is `git
// archive` (tracked files at HEAD, so node_modules/.env/web-dist are excluded
// for free); the frontend zip is the real web/dist built earlier by `npm run
// build:web`; db-export.js (which loads src/config.js/dotenv) is imported
// lazily so plain packaging never touches config.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

function die(msg) {
    console.error(`[package-deploy] ERROR: ${msg}`);
    process.exit(1);
}

function git(argv) {
    const r = spawnSync('git', argv, { cwd: REPO_ROOT, encoding: 'utf8' });
    return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || r.error?.message || '').trim() };
}

const REPO_ROOT = process.cwd();
const args = process.argv.slice(2);
const oi = args.indexOf('--out-dir');
const outDir = path.resolve(REPO_ROOT, oi >= 0 && args[oi + 1] ? args[oi + 1] : 'release');
const wantDbExport = args.includes('--export-db');

// Sanity: run from the repo root.
const pkgPath = path.join(REPO_ROOT, 'package.json');
if (!existsSync(pkgPath)) die('no package.json in cwd - run from the repo root (node scripts/package-deploy.js).');

// The frontend must be built first (with the intended VITE_* vars in .env).
const distDir = path.join(REPO_ROOT, 'web', 'dist');
if (!existsSync(path.join(distDir, 'index.html'))) {
    die('web/dist/index.html missing - build the frontend first:\n    npm run build:web');
}

// Branch guard: releases are built from main only. Runs BEFORE any artifact.
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
if (branch.status !== 0) die(`git rev-parse failed: ${branch.stderr}`);
if (branch.stdout !== 'main') {
    die(`releases are built from the main branch (currently on "${branch.stdout}") - run: git checkout main`);
}

// The backend zip comes from HEAD; warn if tracked files have uncommitted edits
// so the user isn't surprised by a stale backend archive.
const dirty = git(['status', '--porcelain', '--untracked-files=no']);
if (dirty.status === 0 && dirty.stdout) {
    console.warn('[package-deploy] WARNING: uncommitted changes to tracked files - the backend zip is built from the last commit (HEAD), so those edits are NOT included. Commit first if you want them shipped.');
}

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
const backendZip = path.join(outDir, `oddspro-app_${stamp}.zip`);
const frontendZip = path.join(outDir, `oddspro-web_${stamp}.zip`);

// --- Backend: tracked files at HEAD, excluding the web/ frontend source ------
console.log('[package-deploy] packaging backend (oddspro-app)...');
const arch = spawnSync('git', ['archive', '--format=zip', '-o', backendZip, 'HEAD', '--', ':(exclude)web'],
    { cwd: REPO_ROOT, encoding: 'utf8' });
if (arch.status !== 0) die(`git archive failed: ${arch.stderr || arch.error?.message}`);

// --- Frontend: the built web/dist CONTENTS at the zip root -------------------
console.log('[package-deploy] packaging frontend (web/dist -> public_html)...');
zipDirContents(distDir, frontendZip);

// --- DB dump (opt-in): same stamp as the zips = one matching artifact set ----
let dbDump = null;
if (wantDbExport) {
    console.log('[package-deploy] exporting database (--export-db)...');
    const { exportDb } = await import('./db-export.js');
    dbDump = path.join(outDir, `oddspro-db_${stamp}.sql.gz`);
    try {
        await exportDb({ outPath: dbDump });
    } catch (e) {
        die(`db export failed - no version tag was created: ${e.message}`);
    }
}

// --- Version tag: LAST, only after every artifact succeeded (idempotent) -----
const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
const webPkgPath = path.join(REPO_ROOT, 'web', 'package.json');
if (existsSync(webPkgPath)) {
    const webVersion = JSON.parse(readFileSync(webPkgPath, 'utf8')).version;
    if (webVersion !== version) {
        console.warn(`[package-deploy] WARNING: web/package.json is ${webVersion} but the root is ${version} - the two are kept in lockstep by convention.`);
    }
}
const tag = `v${version}`;
const head = git(['rev-parse', 'HEAD']);
if (head.status !== 0) die(`git rev-parse HEAD failed: ${head.stderr}`);
const existing = git(['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]);
if (existing.status === 0) {
    if (existing.stdout !== head.stdout) {
        console.warn(`[package-deploy] WARNING: ${tag} already tagged at ${existing.stdout.slice(0, 7)} which is not HEAD - the codebase changed but the version was not bumped; bump package.json (root+web) if this is a new release.`);
    } else {
        console.log(`[package-deploy] tag ${tag} already exists at HEAD - nothing to tag.`);
    }
} else {
    const mk = git(['tag', '-a', tag, '-m', `oddspro ${tag}`]);
    if (mk.status !== 0) die(`git tag ${tag} failed: ${mk.stderr}`);
    const push = git(['push', 'origin', tag]);
    if (push.status !== 0) {
        die(`tag ${tag} was created locally but the push failed (${push.stderr}) - push it manually: git push origin ${tag}`);
    }
    console.log(`[package-deploy] tagged ${tag} at HEAD and pushed to origin.`);
}

// git archive appends via -o (no leftover); Compress-Archive uses -Force. Report.
const kb = p => `${(statSync(p).size / 1024).toFixed(1)} KB`;
console.log('');
console.log(`[package-deploy] wrote:`);
console.log(`  ${backendZip}  (${kb(backendZip)})  -> extract into the Node app Application Root (oddspro-app), then Run NPM Install + Restart`);
console.log(`  ${frontendZip}  (${kb(frontendZip)})  -> extract into public_html`);
if (dbDump) console.log(`  ${dbDump}  (${kb(dbDump)})  -> import via phpMyAdmin (gzip is imported natively)`);
console.log(`[package-deploy] upload via cPanel File Manager (Upload -> Extract). See docs/DEPLOYMENT.md.`);

// Zip the CONTENTS of a directory (entries at the archive root), cross-platform.
function zipDirContents(srcDir, outZip) {
    if (process.platform === 'win32') {
        // Compress-Archive -Force overwrites any existing archive.
        const esc = s => s.replace(/'/g, "''");
        const cmd = `Compress-Archive -Path '${esc(srcDir)}\\*' -DestinationPath '${esc(outZip)}' -Force`;
        const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8' });
        if (r.status !== 0) die(`Compress-Archive failed: ${r.stderr || r.error?.message}`);
    } else {
        // `zip` appends to an existing archive - remove a stale one first.
        if (existsSync(outZip)) rmSync(outZip);
        const r = spawnSync('zip', ['-r', '-q', path.resolve(outZip), '.'], { cwd: srcDir, encoding: 'utf8' });
        if (r.status !== 0) die(`zip failed (is 'zip' installed?): ${r.stderr || r.error?.message}`);
    }
}
