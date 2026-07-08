// Builds the two upload archives for the manual cPanel deploy (see
// docs/DEPLOYMENT.md), so a deploy is "run this, upload two zips":
//   1. oddspro-app_<ts>.zip  - the BACKEND app tree (tracked files minus web/),
//      extracted into the Node app's Application Root (e.g. oddspro-app).
//   2. oddspro-web_<ts>.zip   - the built FRONTEND (web/dist contents at the
//      zip root), extracted into public_html.
// Usage: node scripts/package-deploy.js [--out-dir <dir>]
//
// Dependency-free: the backend zip is `git archive` (tracked files at HEAD, so
// node_modules/.env/web-dist are excluded for free); the frontend zip is the
// real web/dist built earlier by `npm run build:web`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

function die(msg) {
    console.error(`[package-deploy] ERROR: ${msg}`);
    process.exit(1);
}

const REPO_ROOT = process.cwd();
const args = process.argv.slice(2);
const oi = args.indexOf('--out-dir');
const outDir = path.resolve(REPO_ROOT, oi >= 0 && args[oi + 1] ? args[oi + 1] : 'release');

// Sanity: run from the repo root.
const pkgPath = path.join(REPO_ROOT, 'package.json');
if (!existsSync(pkgPath)) die('no package.json in cwd - run from the repo root (node scripts/package-deploy.js).');

// The frontend must be built first (with the intended VITE_* vars in .env).
const distDir = path.join(REPO_ROOT, 'web', 'dist');
if (!existsSync(path.join(distDir, 'index.html'))) {
    die('web/dist/index.html missing - build the frontend first:\n    npm run build:web');
}

// The backend zip comes from HEAD; warn if tracked files have uncommitted edits
// so the user isn't surprised by a stale backend archive.
const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO_ROOT, encoding: 'utf8' });
if (dirty.status === 0 && dirty.stdout.trim()) {
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

// git archive appends via -o (no leftover); Compress-Archive uses -Force. Report.
const kb = p => `${(statSync(p).size / 1024).toFixed(1)} KB`;
console.log('');
console.log(`[package-deploy] wrote:`);
console.log(`  ${backendZip}  (${kb(backendZip)})  -> extract into the Node app Application Root (oddspro-app), then Run NPM Install + Restart`);
console.log(`  ${frontendZip}  (${kb(frontendZip)})  -> extract into public_html`);
console.log(`[package-deploy] upload both via cPanel File Manager (Upload -> Extract). See docs/DEPLOYMENT.md.`);

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
