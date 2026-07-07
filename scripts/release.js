// Builds a release snapshot on the `deploy` branch: main's exact tracked tree
// plus a freshly-built web/dist (gitignored on main, force-added here) - the
// server never runs Vite. cPanel's Git Version Control pulls `deploy` only.
// See docs/DEPLOYMENT.md. Usage: node scripts/release.js [--branch <name>]
// [--force] [--no-push]

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, cpSync } from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';

const REPO_ROOT = process.cwd();
const WORKTREE = path.join(REPO_ROOT, '.deploy-worktree');
const DEPLOY_BRANCH = 'deploy';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const sourceBranch = opt('--branch', 'main');
const force = flag('--force');
const noPush = flag('--no-push');

function die(msg) {
    console.error(`[release] ERROR: ${msg}`);
    process.exit(1);
}

// git.exe resolves directly on PATH on every platform - never needs a shell.
// npm is npm.cmd on Windows; resolving the binary name directly (rather than
// shell:true) avoids Node's shell-argument-escaping pitfall entirely (spaces
// in args get silently word-split under shell:true unless hand-quoted).
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Run a git/npm command; captures stdout+stderr by default, streams live when
// `live` is set (test/build - the user wants to see progress).
function run(cmd, cmdArgs, { cwd = REPO_ROOT, live = false, env = process.env } = {}) {
    const res = spawnSync(cmd, cmdArgs, {
        cwd,
        stdio: live ? 'inherit' : 'pipe',
        encoding: 'utf8',
        env,
    });
    if (res.error) die(`${cmd} ${cmdArgs.join(' ')} failed to start: ${res.error.message}`);
    return res;
}

function git(gitArgs, opts) {
    return run('git', gitArgs, opts);
}

function gitOk(gitArgs, opts) {
    const res = git(gitArgs, opts);
    if (res.status !== 0) die(`git ${gitArgs.join(' ')} exited ${res.status}\n${res.stderr || res.stdout}`);
    return res.stdout.trim();
}

// --- 1. Preconditions --------------------------------------------------

const pkgPath = path.join(REPO_ROOT, 'package.json');
if (!existsSync(pkgPath)) die('no package.json in cwd - run this from the repo root (node scripts/release.js).');
const pkgName = JSON.parse(readFileSync(pkgPath, 'utf8')).name;
if (pkgName !== 'oddspro') die(`unexpected package "${pkgName}" in cwd - wrong repo?`);

const currentBranch = gitOk(['rev-parse', '--abbrev-ref', 'HEAD']);
if (currentBranch !== sourceBranch) {
    die(`on branch "${currentBranch}", expected "${sourceBranch}" (override with --branch <name>).`);
}

const dirty = gitOk(['status', '--porcelain', '--untracked-files=no']);
if (dirty) {
    die(`uncommitted changes to tracked files - commit or stash first:\n${dirty}`);
}

console.log(`[release] running tests...`);
if (run(NPM, ['test'], { live: true }).status !== 0) die('npm test failed - aborting, nothing released.');

console.log(`[release] building web frontend...`);
const buildEnv = { ...process.env };
if (config.API_TOKEN) buildEnv.VITE_API_TOKEN = config.API_TOKEN; // keep server/frontend token in sync
if (run(NPM, ['run', 'build:web'], { live: true, env: buildEnv }).status !== 0) die('npm run build:web failed - aborting, nothing released.');
const distPath = path.join(REPO_ROOT, 'web', 'dist');
if (!existsSync(path.join(distPath, 'index.html'))) die('web/dist/index.html missing after build - aborting.');

// --- 2. Worktree lifecycle ----------------------------------------------

const worktrees = gitOk(['worktree', 'list', '--porcelain']);
const worktreeRegistered = worktrees.split('\n\n').some(block =>
    block.split('\n')[0] === `worktree ${WORKTREE.replace(/\\/g, '/')}` ||
    block.split('\n')[0] === `worktree ${WORKTREE}`
);

if (existsSync(WORKTREE) && !worktreeRegistered) {
    die(`${WORKTREE} exists on disk but isn't a registered git worktree - run "git worktree prune" and retry (refusing to touch a directory this script didn't create/verify).`);
}

git(['fetch', 'origin', DEPLOY_BRANCH]); // best-effort; branch may not exist remotely yet
const remoteDeployExists = git(['rev-parse', '--verify', `origin/${DEPLOY_BRANCH}`]).status === 0;

if (!worktreeRegistered) {
    console.log(`[release] creating .deploy-worktree (${remoteDeployExists ? 'tracking origin/deploy' : 'first-ever release, branching from ' + sourceBranch})...`);
    const addArgs = remoteDeployExists
        ? ['worktree', 'add', '-b', DEPLOY_BRANCH, WORKTREE, `origin/${DEPLOY_BRANCH}`]
        : ['worktree', 'add', WORKTREE, '-b', DEPLOY_BRANCH];
    gitOk(addArgs);
} else if (remoteDeployExists) {
    console.log(`[release] syncing existing worktree to origin/deploy...`);
    gitOk(['fetch', 'origin', DEPLOY_BRANCH], { cwd: WORKTREE });
    gitOk(['reset', '--hard', `origin/${DEPLOY_BRANCH}`], { cwd: WORKTREE });
}

// --- 3. Snapshot main's tracked tree + fresh web/dist into the worktree ---

console.log(`[release] snapshotting ${sourceBranch}'s tracked tree...`);
git(['rm', '-r', '--quiet', '--ignore-unmatch', '.'], { cwd: WORKTREE });

// git archive | tar -x, piped programmatically (portable across shells).
const archiveResult = await new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', sourceBranch], { cwd: REPO_ROOT });
    const untar = spawn('tar', ['-x', '-C', WORKTREE], { cwd: REPO_ROOT });
    let archiveErr = '', untarErr = '';
    archive.stderr.on('data', d => archiveErr += d);
    untar.stderr.on('data', d => untarErr += d);
    archive.stdout.pipe(untar.stdin);
    archive.on('error', reject);
    untar.on('error', reject);
    untar.on('close', code => code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${untarErr}`)));
    archive.on('close', code => { if (code !== 0) reject(new Error(`git archive exited ${code}: ${archiveErr}`)); });
});
if (archiveResult instanceof Error) die(archiveResult.message);

cpSync(distPath, path.join(WORKTREE, 'web', 'dist'), { recursive: true });

gitOk(['add', '-A'], { cwd: WORKTREE });
gitOk(['add', '-f', 'web/dist'], { cwd: WORKTREE }); // force past the archived .gitignore's dist/ rule

// --- 4. Commit / push / no-op detection ---------------------------------

const pending = gitOk(['status', '--porcelain'], { cwd: WORKTREE });
if (!pending && !force) {
    console.log('[release] nothing changed since the last release - skipping commit.');
    process.exit(0);
}

const sourceSha = gitOk(['rev-parse', '--short', sourceBranch]);
const message = `release: ${new Date().toISOString()} (source ${sourceSha})`;
if (pending) {
    gitOk(['commit', '-m', message], { cwd: WORKTREE });
} else {
    gitOk(['commit', '--allow-empty', '-m', `${message} [forced, no changes]`], { cwd: WORKTREE });
}

const newSha = gitOk(['rev-parse', '--short', 'HEAD'], { cwd: WORKTREE });
console.log(`[release] committed ${newSha} on ${DEPLOY_BRANCH}.`);

const hasParent = git(['rev-parse', '--verify', 'HEAD~1'], { cwd: WORKTREE }).status === 0;
if (hasParent) {
    console.log(gitOk(['diff', '--stat', 'HEAD~1'], { cwd: WORKTREE }));
}

if (noPush) {
    console.log('[release] --no-push: local rehearsal only, origin untouched.');
} else {
    console.log(`[release] pushing ${DEPLOY_BRANCH}...`);
    gitOk(['push', '-u', 'origin', DEPLOY_BRANCH], { cwd: WORKTREE });
    console.log(`[release] done. Next: cPanel Git Version Control -> "Update from Remote" -> "Deploy HEAD Commit".`);
}
