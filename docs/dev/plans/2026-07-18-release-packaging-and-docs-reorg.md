# Release Packaging (--export-db + version tag) & Docs Reorg — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Spec:** `docs/superpowers/specs/2026-07-18-release-packaging-and-docs-reorg-design.md` (approved 2026-07-18).
> **NOTE:** this plan file and its spec MOVE to `docs/dev/plans/` / `docs/dev/specs/` during Task 3 —
> after Task 3, continue ticking checkboxes at `docs/dev/plans/2026-07-18-release-packaging-and-docs-reorg.md`.

**Goal:** `npm run package:deploy` gains `--export-db` + a main-only idempotent version tag; `docs/` splits into project docs vs `docs/dev/` pipeline docs; stale knowledge gets a currency pass; a harness-agnostic agent toolset library lands as `AGENTS.md` + `docs/agents/toolset.md`.

**Architecture:** Part 1 refactors `scripts/db-export.js` into an importable `exportDb()` plus a byte-compatible CLI wrapper, and extends `scripts/package-deploy.js` (branch guard → artifacts → lazy DB dump → idempotent tag, each step gating the next). Parts 2–4 are docs-only: `git mv` moves + one-commit reference sweep, then new knowledge files whose full text is inlined in this plan.

**Tech Stack:** Plain Node.js ES modules (no new deps), git, bash (Git Bash on Windows) for the move/sweep.

## Global Constraints

- **Releases are built from `main` only; version tags exist only on `main`** — the script refuses off-main (NO auto-switching branches, rejected in design review).
- **No behavior change** to what the two zips contain, to `db-export.js`'s standalone CLI (still writes `backups/`), or to any runtime/server code. `--export-db` is boolean — full dump only.
- Plain packaging must stay dependency-free: `db-export.js` (which loads `src/config.js`/dotenv) is imported **lazily**, only when `--export-db` is passed.
- All doc moves via `git mv`; the reorg (moves + every reference update + `docs/README.md`) is **ONE commit** — no intermediate commit may have dangling links.
- `docs/agents/toolset.md` is **VERIFIED-only** — every command/procedure was actually run in a session; aspirational content is banned. Maintenance: append-only dated entries; supersede with a dated note, never silently rewrite.
- 4-space indent, single quotes, semicolons, ES modules (repo convention). Conventional Commits.
- Suite must stay **723/723** (`npm test`, offline, <2 s) after every task — no test files change in this work.
- `release/` and `backups/` are gitignored (verified 2026-07-18: `.gitignore` lines 60–61) — DB dumps must never land in git.
- `docs/visuals/` stays where it is (its one reference uses a repo-root path that stays valid).
- Root `README.md` gets a currency pass, not a rewrite; research doc contents are moved, never edited (link fixes only).
- Work happens directly on `main` (project practice since the dev branch was deleted); commit after each task; push at the end.

---

### Task 1: Extract `exportDb()` from the db-export CLI

**Files:**
- Modify: `scripts/db-export.js` (full replacement below)

**Interfaces:**
- Consumes: nothing new (existing `src/config.js` for DB creds — unchanged import).
- Produces: `export async function exportDb({ outPath, container = null })` → resolves `{ path: string, bytes: number }`, **throws** `Error` (current error texts) instead of `process.exit`. Container resolution: explicit arg > `DB_DOCKER_CONTAINER` env > auto-detect; `mariadb-dump` probed before `mysqldump`. Importing the module never runs the CLI.

- [x] **Step 1: Replace `scripts/db-export.js` with the refactored version**

```js
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
```

- [x] **Step 2: Verify importing the module runs no CLI**

Run (repo root):
```sh
node --input-type=module -e "const m = await import('./scripts/db-export.js'); console.log(typeof m.exportDb)"
```
Expected: prints exactly `function` — no `[db-export]` lines, no dump started, no file written.

- [x] **Step 3: Verify the standalone CLI is unchanged (Docker up)**

Check the DB container is running (`docker ps` shows the mariadb container on 3306; if Docker is down, flag to the user and pause — DB issues are user-resolved by global rule). Then:
```sh
node scripts/db-export.js
```
Expected: same output shape as before — `auto-detected container`, `using mariadb-dump in container ... for database ...`, `wrote D:\...\backups\oddspro_<ts>.sql.gz (N KB)`, phpMyAdmin hint. The dump file may be kept (it is a genuine backup in the folder meant for them; `backups/` is gitignored).

- [x] **Step 4: Run the suite + commit**

```sh
npm test        # expect 723 pass / 0 fail (read the output tail for the summary)
git add scripts/db-export.js
git commit -m "refactor(scripts): extract importable exportDb() from db-export CLI"
```

---

### Task 2: `package-deploy.js` — branch guard, `--export-db`, idempotent version tag

**Files:**
- Modify: `scripts/package-deploy.js` (full replacement below)

**Interfaces:**
- Consumes: `exportDb({ outPath })` from Task 1 (lazy `await import('./db-export.js')`, only when `--export-db` is passed).
- Produces: the release CLI contract — `npm run package:deploy [-- --export-db] [-- --out-dir <dir>]`. Execution order (each step gates the next): sanity → **branch guard (must be exactly `main`)** → dirty-tree warning → backend+frontend zips (shared `<ts>` stamp) → optional DB dump `oddspro-db_<ts>.sql.gz` (same stamp) → **idempotent annotated tag `v<package.json version>` at HEAD, pushed** (exists → skip; exists≠HEAD → loud version-not-bumped warning; push failure → die but keep the local tag).

- [x] **Step 1: Replace `scripts/package-deploy.js`**

```js
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
```

- [x] **Step 2: Verify the branch guard refuses a feature branch**

```sh
git checkout -b tmp-branch-guard-check
npm run package:deploy
```
Expected: exit 1 with `ERROR: releases are built from the main branch (currently on "tmp-branch-guard-check") - run: git checkout main`, and **no new files** in `release/` (compare `ls release/` before/after). Then:
```sh
git checkout main && git branch -D tmp-branch-guard-check
```

- [x] **Step 3: Verify the no-flag run on `main` (two zips + tag skip warning)**

```sh
npm run package:deploy
```
Expected: both zips written to `release/` with a fresh shared stamp, then the tag step logs the WARNING `v1.2.0 already tagged at f7f1f9d which is not HEAD - the codebase changed but the version was not bumped...` and creates nothing. Confirm no tag moved: `git tag -l` still shows only `v1.2.0`, and `git rev-parse v1.2.0^{commit}` still starts `f7f1f9d`.

- [x] **Step 4: Verify `--export-db` (Docker up)**

```sh
npm run package:deploy -- --export-db
```
Expected: third artifact `release/oddspro-db_<ts>.sql.gz` with the SAME stamp as that run's zips, size printed in the report; same v1.2.0 warning; still no new tag. (If Docker is down, flag to the user rather than working around it.)

- [x] **Step 5: Clean up verification artifacts**

Delete ONLY the zip/dump files created in Steps 3–4 (identify by their fresh stamps). Do NOT touch the original v1.2.0 release files (`oddspro-app_20260717_*.zip`, `oddspro-web_20260717_*.zip`, `DEPLOY-CHECKLIST-v1.2.0.md`).

- [x] **Step 6: Run the suite + commit**

```sh
npm test        # expect 723 pass
git add scripts/package-deploy.js
git commit -m "feat(release): package:deploy --export-db + main-only idempotent version tag"
```

Note: the tag-CREATION path is not exercisable without a version bump — it ships code-reviewed and fires on the next real release (bumping versions is the user's release-time decision).

---

### Task 3: Docs reorganization (one atomic commit)

**Files:**
- Move (git mv): 43 markdown files per the mapping below
- Create: `docs/README.md` (full text below)
- Modify: `CLAUDE.md`, `README.md`, `scripts/*.js` (comment lines), `docs/**/*.md` (path references)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the final docs layout every later task references — `docs/` (project) vs `docs/dev/` (pipeline: `specs/`, `plans/`, `checklists/`), `docs/guides/`, `docs/research/`. Tasks 4–5 write into this layout.

- [x] **Step 1: Make sure the tree is clean and this plan file is committed**

```sh
git status --porcelain
```
If this plan file is untracked, commit it first (`git add docs/superpowers/plans/2026-07-18-release-packaging-and-docs-reorg.md && git commit -m "docs(plan): release packaging + docs reorg implementation plan"`) — `git mv` needs it tracked.

- [x] **Step 2: Create the tree and move everything (Bash tool — POSIX)**

```bash
mkdir -p docs/dev/specs docs/dev/plans docs/dev/checklists docs/guides docs/research
git mv docs/safety-net-protocol.md docs/sms-bonga-integration.md docs/guides/
git mv docs/sure-win-analysis.md docs/fair-comparison-and-false-positives.md \
       docs/data-independence.md docs/data-integrity-and-signal-audit.md \
       docs/precursor-patterns.md docs/emergence-patterns-findings.md \
       docs/emergence-patterns-m4-backlog.md docs/m4.2b-booster-validation-and-value-edge.md \
       docs/ai-edge-sentinel.md docs/beat-the-book-roadmap.md \
       docs/prediction-scoping.md docs/spa-performance-audit-2026-07-16.md docs/research/
git mv implementation-plan.md docs/v1.1.0-implementation-plan.md docs/dev/
git mv docs/superpowers/specs/*.md docs/dev/specs/
git mv docs/superpowers/plans/*.md docs/dev/plans/
git mv docs/v1.0.1-ui-tweaks-checklist.md docs/v1.0.2-ui-pass-checklist.md \
       docs/perf-pass-2026-07-17-checklist.md docs/dev/checklists/
rmdir docs/superpowers/specs docs/superpowers/plans docs/superpowers 2>/dev/null; true
```
`docs/DEPLOYMENT.md`, `docs/memory-bank.md` (referenced from `src/` comments) and `docs/visuals/` stay put. Verify: `git status` shows only renames; `ls docs` shows `DEPLOYMENT.md memory-bank.md dev guides research visuals`.

- [x] **Step 3: Write `docs/README.md`** (Write tool, exact content):

```markdown
# docs/ — documentation index

Two worlds: this root = PROJECT documentation (what the system is and how to run it);
`dev/` = the DEVELOPMENT pipeline (how it is being built: specs, plans, checklists, the
phase tracker). Architecture itself lives in the repo-root `CLAUDE.md` (authoritative,
agent-dense); agent operational playbooks in `agents/toolset.md` (entry point: repo-root
`AGENTS.md`).

## Project documentation (here)

- `DEPLOYMENT.md` — the manual cPanel deploy guide (no SSH; zips via `npm run package:deploy`).
- `memory-bank.md` — goals/state history, numbered resolved issues (hard-won lessons), and the
  AI policy-regime switch log. The historical/code-level knowledge base; dated DARK-switch
  notes go here.
- `agents/` — the agent toolset knowledge library (`toolset.md`): verified operational
  playbooks, what-to-use-when, operational issue KB. Entry point: repo-root `AGENTS.md`.
- `guides/` — operator playbooks: `safety-net-protocol.md` (the betting protocol behind the
  Safe toggles), `sms-bonga-integration.md` (SMS provider wire format + live-verify checklist).
- `research/` — analysis findings and studies (the honest ledger of what works and what was
  refuted): sure-win analysis, fair comparison / false positives, data independence, precursor
  patterns, emergence-pattern findings + M4 backlog, M4.2b booster validation, AI edge
  sentinel, beat-the-book roadmap, prediction scoping, SPA performance audit.
- `visuals/` — image assets referenced by docs.

## Development pipeline (`dev/`)

- `dev/implementation-plan.md` — the phase-by-phase progress tracker.
- `dev/v1.1.0-implementation-plan.md` — the v1.1.0 accounts release plan.
- `dev/specs/` — design specs (`YYYY-MM-DD-<name>-design.md`).
- `dev/plans/` — implementation plans (`YYYY-MM-DD-<name>.md`).
- `dev/checklists/` — progress/QA checklists for releases and passes.

## Where does a NEW doc go?

| Kind | Location |
|---|---|
| Design spec | `docs/dev/specs/YYYY-MM-DD-<name>-design.md` |
| Implementation plan | `docs/dev/plans/YYYY-MM-DD-<name>.md` |
| Progress checklist | `docs/dev/checklists/<name>-checklist.md` |
| Research finding / study | `docs/research/<name>.md` |
| Guide / protocol | `docs/guides/<name>.md` |
| Operational agent knowledge | `docs/agents/toolset.md` (dated append) |
| Resolved code-level issue | `docs/memory-bank.md` §Resolved issues |

This layout overrides the superpowers-skill default location (`docs/superpowers/...`) —
the skills honor project preference.
```

- [x] **Step 4: Reference sweep — ordered path replaces (Bash tool)**

Order matters (specific before generic). The two 2026-07-18 release-packaging files are EXCLUDED — their old-path mentions document this migration itself (sanctioned historical prose):

```bash
FILES=$(ls CLAUDE.md README.md scripts/*.js docs/*.md docs/dev/*.md docs/dev/specs/*.md \
           docs/dev/plans/*.md docs/dev/checklists/*.md docs/guides/*.md docs/research/*.md \
       | grep -v "2026-07-18-release-packaging")
sed -i \
  -e 's|docs/superpowers/specs/|docs/dev/specs/|g' \
  -e 's|docs/superpowers/plans/|docs/dev/plans/|g' \
  -e 's|docs/superpowers/|docs/dev/|g' \
  -e 's|docs/v1.1.0-implementation-plan.md|docs/dev/v1.1.0-implementation-plan.md|g' \
  -e 's|docs/v1.0.1-ui-tweaks-checklist.md|docs/dev/checklists/v1.0.1-ui-tweaks-checklist.md|g' \
  -e 's|docs/v1.0.2-ui-pass-checklist.md|docs/dev/checklists/v1.0.2-ui-pass-checklist.md|g' \
  -e 's|docs/perf-pass-2026-07-17-checklist.md|docs/dev/checklists/perf-pass-2026-07-17-checklist.md|g' \
  -e 's|docs/safety-net-protocol.md|docs/guides/safety-net-protocol.md|g' \
  -e 's|docs/sms-bonga-integration.md|docs/guides/sms-bonga-integration.md|g' \
  -e 's|docs/sure-win-analysis.md|docs/research/sure-win-analysis.md|g' \
  -e 's|docs/fair-comparison-and-false-positives.md|docs/research/fair-comparison-and-false-positives.md|g' \
  -e 's|docs/data-independence.md|docs/research/data-independence.md|g' \
  -e 's|docs/data-integrity-and-signal-audit.md|docs/research/data-integrity-and-signal-audit.md|g' \
  -e 's|docs/precursor-patterns.md|docs/research/precursor-patterns.md|g' \
  -e 's|docs/emergence-patterns-findings.md|docs/research/emergence-patterns-findings.md|g' \
  -e 's|docs/emergence-patterns-m4-backlog.md|docs/research/emergence-patterns-m4-backlog.md|g' \
  -e 's|docs/m4.2b-booster-validation-and-value-edge.md|docs/research/m4.2b-booster-validation-and-value-edge.md|g' \
  -e 's|docs/ai-edge-sentinel.md|docs/research/ai-edge-sentinel.md|g' \
  -e 's|docs/beat-the-book-roadmap.md|docs/research/beat-the-book-roadmap.md|g' \
  -e 's|docs/prediction-scoping.md|docs/research/prediction-scoping.md|g' \
  -e 's|docs/spa-performance-audit-2026-07-16.md|docs/research/spa-performance-audit-2026-07-16.md|g' \
  $FILES
```
Then `git diff --stat` — every touched file should show a SMALL +/- count; a file showing every line changed means line endings got mangled (revert that file and redo its edits with the Edit tool).

- [x] **Step 5: Fix the remaining bare `implementation-plan.md` mentions (root file → `docs/dev/`)**

```bash
grep -rn "implementation-plan.md" CLAUDE.md README.md docs scripts \
  | grep -v "v1.1.0-implementation-plan\|dev/implementation-plan\|2026-07-18-release-packaging"
```
Expected hits (~3): `README.md` ("phase-by-phase progress in \`implementation-plan.md\`"), `CLAUDE.md` ("Source spec and progress tracking live in \`implementation-plan.md\`"), `docs/memory-bank.md` ("progress: \`implementation-plan.md\`"). Edit each to `docs/dev/implementation-plan.md` (Edit tool). Re-run the grep — expect zero hits.

- [x] **Step 6: Verify — dangling-reference sweep + suite + history**

```bash
grep -rn "docs/superpowers\|docs/safety-net-protocol.md\|docs/sms-bonga-integration.md\|docs/sure-win-analysis.md\|docs/fair-comparison-and-false-positives.md\|docs/data-independence.md\|docs/data-integrity-and-signal-audit.md\|docs/precursor-patterns.md\|docs/emergence-patterns\|docs/m4.2b-booster\|docs/ai-edge-sentinel.md\|docs/beat-the-book-roadmap.md\|docs/prediction-scoping.md\|docs/spa-performance-audit\|docs/v1.0.1-ui-tweaks\|docs/v1.0.2-ui-pass\|docs/perf-pass-2026-07-17\|docs/v1.1.0-implementation" \
  CLAUDE.md README.md src scripts web/src docs | grep -v "2026-07-18-release-packaging"
```
Expected: **zero hits**. Then:
```sh
npm test                                                # 723 pass
git log --follow --oneline docs/research/sure-win-analysis.md | tail -3   # history preserved back past the move
```

- [x] **Step 7: Commit (ONE commit: moves + docs/README.md + all reference updates)**

```sh
git add -A
git commit -m "docs: reorganize docs/ into project vs dev-pipeline layout (git mv + reference sweep + index)"
```
**From here on, tick checkboxes in `docs/dev/plans/2026-07-18-release-packaging-and-docs-reorg.md` (this file's new home).**

---

### Task 4: Agent toolset knowledge library (`AGENTS.md` + `docs/agents/toolset.md`)

**Files:**
- Create: `AGENTS.md` (repo root)
- Create: `docs/agents/toolset.md`

**Interfaces:**
- Consumes: the Task 3 layout (paths like `docs/dev/specs/`, `docs/research/`).
- Produces: the two library files Task 5's CLAUDE.md pointer references. Content below is final — drafted from the incumbent session's verified memory (staged in the `oddspro-toolset-nuggets` auto-memory); VERIFIED-only.

- [x] **Step 1: Write `AGENTS.md`** (exact content):

```markdown
# AGENTS.md — agent entry point (any harness: Claude, Codex, Gemini, …)

oddspro = MySQL warehouse for Kenyan bookmaker odds (BetPawa/Betika) + API-Football canonical
data, a predictions layer (tips / hot picks / AI adjudication), and a React web table. Node 20+
ES modules, knex/mysql2, zod. Dev box: Windows 11, PowerShell 5.1 default shell, DB in Docker.

**Read order:** 1) `CLAUDE.md` — architecture, commands, invariants (authoritative, dense).
2) `docs/agents/toolset.md` — VERIFIED operational playbooks (test/serve/E2E/DB/release),
what-to-use-when, operational issue KB. 3) `docs/memory-bank.md` — state history, numbered
resolved issues, the AI regime-switch log. New docs go per `docs/README.md` (spec →
`docs/dev/specs/`, plan → `docs/dev/plans/`, checklist → `docs/dev/checklists/`, research →
`docs/research/`, guide → `docs/guides/`).

**HARD INVARIANTS (do not break; detail in CLAUDE.md):**
- Frozen ledger: prediction/prematch rows freeze at kickoff and settle exactly once — NEVER
  rewrite settled or past-kickoff rows. Measure new rules via the replay scripts, never by
  editing history.
- Fetch-once: never delete or refetch immutable API data (stats/lineups/events/history flags);
  `matches.metadata` is insert-only; root `x-*-output.xx.json` snapshots are frozen fixtures.
- Migrations are forward-only; never edit an applied migration.
- All DB access through the single knex instance (`src/db/connection.js`), never raw mysql2;
  DB-writing batches at concurrency 1; run exactly ONE `npm run serve` (a second writer
  process = InnoDB gap-lock deadlocks).
- Odds market identity = `type_name`, never `type_id` (Betika reuses ids across markets).
- AI adjudicators may veto, never promote. AI-call refactors must be regime-neutral (prompt
  bytes + model tags byte-identical) or bump the tag in the same commit. DARK switches
  (`AI_INJECTION_PREAMBLE`, `AI_CONSENSUS_*`) need an explicit user go + a dated
  `docs/memory-bank.md` entry BEFORE flipping.
- Never move a live generation knob (e.g. `TIP_MIN_PRICE`, `SAFE_*`) mid-experiment without a
  dated note — it partitions the measurement ledger (the 2026-07-10 lesson).
- Never touch `DEFAULT_SAFE` without a fresh `scripts/analyze-safe-tips.js` run.
- Releases are built from `main` only; version tags exist only on `main`
  (`npm run package:deploy` enforces both).
- Secrets live in `.env` only (never git). Guest gating is server-authoritative. Sessions
  store only hashes; never rotate `PIN_PEPPER` casually.
- User-gated ops (live cPanel deploys, DB blob reclaim, billing/top-ups, PAT rotation) belong
  to the USER — surface them once, never track/nag/execute.

**Maintenance protocol (this file + `docs/agents/toolset.md`):** append-only dated entries;
VERIFIED-only (a recipe must have actually been run in a session — aspirational content is
banned); never delete a working recipe without a replacement; supersede with a dated note,
not a silent rewrite.
```

- [x] **Step 2: Write `docs/agents/toolset.md`** (exact content):

```markdown
# Agent Toolset Library — verified operational knowledge

> Harness-agnostic ops reference for ANY agent working this repo. Read AFTER `CLAUDE.md`
> (architecture) — this file is HOW to operate the toolchain, not what the system is.
> RULES: VERIFIED-only (every command/procedure here was actually run in a session;
> aspirational content is banned); append-only dated entries; supersede with a dated note,
> never silently rewrite; never delete a working recipe without a replacement. Code-level
> lessons live in `docs/memory-bank.md` §Resolved issues — cross-reference by number (#N),
> don't duplicate.

## 1. Environment map

- Windows 11 dev box; default shell **PowerShell 5.1** (`powershell.exe`) — see §2 traps.
  Git Bash is available and preferred for POSIX one-liners (`sed`, globs, `git mv` batches).
- Node 20+ ES modules; 4-space indent (workspace rule), single quotes, semicolons; no linter.
- DB: **MariaDB in Docker**, host port 3306; the dump tool inside the container is
  `mariadb-dump` (NOT `mysqldump`). `.env` uses Laravel-style names (`DB_DATABASE`,
  `DB_USERNAME`, …). DB connection failure = HALT and ask the user (global rule).
- Ports: **:3001** = `npm run serve` (API + built web); **:5173** = `cd web && npm run dev`
  (proxies `/api` → :3001); vite silently binds **:5174** when :5173 is orphan-held — always
  read the printed URL (§3.3).
- API-Football plan ~150k req/day — quota is not a practical constraint (the guard stays).
  Gemini HTTP 429 `RESOURCE_EXHAUSTED` = OUT OF CREDITS, not rate limiting — stop and
  escalate to the user for a top-up; never work around it (adjudicate/facts/anchored tasks
  are Gemini-hardcoded).
- Live site `oddspro.ke`: shared cPanel, NO SSH; deploys are manual zip uploads
  (`docs/DEPLOYMENT.md`). Merged-to-main ≠ live.

## 2. PowerShell 5.1 traps (each verified the hard way)

- No `&&`/`||` chaining (parser error). Chain with `;` or `if ($?) { … }`.
- `Out-File` / `Set-Content -Encoding utf8` writes a **BOM** — corrupted 4 markdown files
  on 2026-07-17 (the git diff showed an "invisible" first-line change). BOM-less write:
  `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`.
  Prefer the harness Write/Edit tools for file content; use PS only for orchestration.
- Bulk regex edits over checklists: anchor per line — `(?m)^(\s*)- \[ \] ` — a narrow
  `- [ ] **` pattern misses non-bold checkboxes, and prose mentions of "`- [ ]`" inside
  backticks must NOT match (the line anchor prevents it).
- `ConvertFrom-Json` returns PSCustomObject (no `-AsHashtable` in 5.1).
- A final empty `Select-String` in a chain exits 255 — noise, not failure.
- Port probe: `Get-NetTCPConnection -State Listen -LocalPort 3001,5173,5174`
  (add `-ErrorAction SilentlyContinue` when none may be listening).

## 3. Playbooks

### 3.1 Test loop
- `npm test` — offline node:test, no DB / live APIs, < 2 s. **723 passing @ 2026-07-18.**
  The suite count is quoted in `CLAUDE.md` — update it in the same commit that adds tests.
- Harness note: > 30 KB of output gets persisted to a tool-results file — read the TAIL for
  the pass/fail summary instead of re-running.
- Tests import pure zero-import `src/db/*-rules.js` modules — new decision logic goes in a
  pure module first; that purity is what keeps the suite offline.

### 3.2 Serve lifecycle
- `npm run serve` = API :3001 + in-process schedulers (auto-refresh light/full, AI worker
  60 s tick, geo backfill).
- **Stale-serve trap:** the process holds OLD code after backend edits — restart before
  judging behavior. A web "500 Internal Server Error" usually means the API is down/stale,
  not a code bug (memory-bank #17).
- Run exactly ONE serve. A manual `npm run start` sweep while serve's scheduler runs
  gap-lock-deadlocks on the same odds rows — stop serve first or set
  `AUTO_REFRESH_ENABLED=0` (memory-bank #3/#22).
- `./.HALT` file = reliable stop (boot refusal exit 1 + a running serve exits within ~30 s);
  delete it to allow boot again. Local dev: `AUTO_REFRESH_ENABLED=0` keeps the scheduler quiet.

### 3.3 Frontend dev + orphan ports
- `cd web && npm run dev` → :5173. **Read the printed URL** — an orphaned previous dev server
  makes vite silently bind :5174 and you will E2E-test the WRONG build.
- Kill a dev server by PORT OWNER, tree-wide (npm wrappers on Windows leave node children):
  PS `(Get-NetTCPConnection -LocalPort 5173).OwningProcess` then
  `taskkill /PID <pid> /T /F` (Git Bash spelling: `taskkill //PID <pid> //T //F`).
  Then RE-PROBE ports; expect only :3001 (the user's serve) to remain.
- `npm run build:web` → `web/dist`. A NEW component file with a syntax error still "builds"
  until something imports it — the importing change is the real compile check (memory-bank #19).

### 3.4 Browser E2E (chrome-devtools MCP)
- REUSE the existing blank tab: `list_pages` first, then `navigate_page` that same tab to the
  app. `new_page` orphans a tab the user must close by hand (the last page cannot be closed).
- **Huge-snapshot workaround (verified):** `take_snapshot` on the loaded data table overflows
  the tool token limit — pass `filePath` (scratchpad), grep the saved file for uids/labels,
  then click by uid.
- Console check: `list_console_messages` filtered to error/warn. Network check:
  `list_network_requests` with a resourceTypes filter (used to prove the help-modal iframe
  never loads until expanded).
- Cleanup ritual: navigate the tab back to `about:blank`; stop background shells; kill
  survivors by port PID with the tree flag; re-probe ports. "Clean" = the machine looks like
  it did before the task, minus the intended changes.
- Verify visual redesigns by DRIVING them (both themes, tablet + phone widths) — the offline
  suite cannot see layout (memory-bank #19).

### 3.5 DB ops
- Ad-hoc SQL: `docker exec <container> mariadb -u<user> -p<pass> <db> -e "…"` (find the
  container via `docker ps` — the mysql/mariadb image exposing 3306).
- Dump: `node scripts/db-export.js [--container <name>]` → `backups/oddspro_<ts>.sql.gz`
  (`mariadb-dump` preferred; no CREATE DATABASE — meant for phpMyAdmin import into an
  existing, differently-named DB).
- Migrations: `npm run migrate` (forward-only). Remote host without SSH: `MIGRATE_ON_BOOT=1`
  self-migrates on restart (fail-fast).
- `backups/` and `release/` are gitignored — dumps must never land in git.

### 3.6 Release packaging (rule since 2026-07-18)
- `npm run package:deploy [-- --export-db] [-- --out-dir <dir>]` — **MAIN-ONLY** (refuses on
  any other branch; deliberately NO auto-checkout). Builds `release/oddspro-app_<ts>.zip` +
  `oddspro-web_<ts>.zip` (+ `oddspro-db_<ts>.sql.gz` with the flag, same stamp), THEN
  idempotently tags `v<package.json version>` at HEAD and pushes the tag. Existing tag not at
  HEAD → loud "version not bumped" warning, nothing created. Artifacts before tag; tag before
  push; a failed push keeps the local tag (push manually: `git push origin v<version>`).
- A release = the USER bumps root + web `package.json` versions, then package:deploy on `main`.
- Doc/file moves in git: always `git mv` (history survives `git log --follow`).

### 3.7 Pipeline + AI worker ops
- Full sweep `npm run start [-- days]`; per-action `node src/index.js <action> [date]`; all
  idempotent. The sweep bills NO AI — verdict columns are worker-owned (`src/ai-worker.js`,
  60 s serve tick; CLI drain `node src/index.js aireview` for cron-only hosts).
- `TIP_AI_DAILY_CAP` = BILLED verdicts per EAT day; the counter is in-memory PER PROCESS
  (serve holds it across ticks; each CLI run starts fresh; a restart resets — worst case one
  extra cap that day).
- Enrichment (`node src/index.js enrich`) is full-sweep-only by cost design — never wire it
  into the web refresh path.
- AI verdicts can never be backfilled: a grounded call on a played fixture retrieves the
  final score from the web — collection is strictly pre-kickoff, forward-only.

## 4. What-to-use-when (analysis scripts — all read-only unless noted)

| Question | Tool | Notes |
|---|---|---|
| Re-tune Safe-pool gates? | `scripts/analyze-safe-tips.js` | LODO grid; MANDATORY before touching `DEFAULT_SAFE`; weekly cadence |
| Hot-pick gate precision / O-U line sweep? | `scripts/backtest-hotpicks.js [--line]` | 10k+ fixture replay |
| Sure-sort priors / new-family anchors? | `scripts/backtest-sure-tips.js` | warehouse temporal-OOS; feeds `WAREHOUSE_WLO` |
| Live ranking bake-off / sure cross-val? | `scripts/analyze-sure-live.js` | settled-ledger based |
| AI health per model tag? | `scripts/ai-scorecard.js` | hit-rates, veto value, price drift, Brier, coverage |
| Pre-registered pattern hypotheses? | `scripts/mine-patterns.js` | tip-ledger mine; prints a POLICY-REGIME WARNING on mid-window knob moves |
| Warehouse precursor candidates? | `scripts/mine-precursors.js` | the 2026-07-14 Tier-A/B mine, ~5 min |
| Warehouse baselines / odds menu? | `scripts/recon-warehouse.js` | recon |
| Daily value-edge instrument? | `scripts/edge-sentinel.js` | standing M4.3 probe: anchoring effect, AI-market dissent, dissent calibration |
| Flat-stake ROI / buckets? | `node src/index.js performance` | also `GET /api/performance` |
| Wipe/reseed users (changed pepper)? | `node scripts/reset-users.js [--yes]` | DESTRUCTIVE; dry-run without `--yes` |

**Settled negatives — do NOT re-litigate without NEW data:** runner-up tip swap (+108/−128);
H5 golden longshots (2/153 at ≥10x); X2 "+EV" (selection artifact, refuted); O/U line
expansion (no line beats 2.5's ~73% bar); PR-1 ladder (real lift but unbettable, −5.9% at
real prices); anchored-AI probabilities as a ranking signal (sycophancy, ≈ +16pp pull toward
the shown bet). Sources: `docs/research/`.

## 5. Operational issues KB (dated; code-level lessons → memory-bank §Resolved issues)

- 2026-07-17 — **PS 5.1 BOM corruption:** bulk md edits via `Out-File -Encoding utf8`
  prepended BOMs to 4 files; fix = BOM-less `WriteAllText` or the harness Edit tools (§2).
- 2026-07-17 — **Huge-snapshot overflow:** `take_snapshot` on the loaded table exceeds tool
  token limits; `filePath` + grep workaround (§3.4).
- recurring — **Vite orphan port:** E2E ran against :5174 while an orphan held :5173; always
  read the printed URL; kill by port-owner PID tree (§3.3).
- recurring — **Stale serve:** post-edit behavior judged against an old :3001 process;
  restart serve after every backend change (§3.2).
- 2026-07-16 — **Unindexed catalog scan:** `/api/columns` full-scanned the 2.4M-row
  `odds_markets` (> 180 s; the settings modal "wouldn't open"); fix = covering index
  (migration batch 13). Caching cannot save an unindexed query.
- Cross-refs: second-writer deadlocks → memory-bank #3/#22; web 500 = API down → #17;
  `cmd | tee log` masks exit codes (verify long runs by reading the output tail) → #14.

## 6. Doc & knowledge topology

- `CLAUDE.md` (root) — architecture + commands + invariants; authoritative for any harness.
- `AGENTS.md` (root) — cross-harness entry point + hard invariants; points here.
- `docs/` — PROJECT docs: `DEPLOYMENT.md`, `memory-bank.md` (historical/code-level KB + the
  AI regime-switch log — dated DARK-switch notes go THERE), `guides/`, `research/`, `visuals/`.
- `docs/dev/` — DEVELOPMENT pipeline: `implementation-plan.md`, `specs/`, `plans/`,
  `checklists/`. NEW docs go per the `docs/README.md` table.
- Separation of duties: user-gated ops (live cPanel deploys, DB blob reclaim, billing,
  PAT rotation) are surfaced to the user once — never tracked as agent work.

## 7. Update log

- 2026-07-18 — library created (spec:
  `docs/dev/specs/2026-07-18-release-packaging-and-docs-reorg-design.md`); initial content
  exported from the incumbent agent's verified session memory.
```

- [x] **Step 3: Review both files against the VERIFIED-only rule**

Re-read each recipe: every command must be one actually run in a session (sources: the `oddspro-toolset-nuggets` staged memory, `cleanup-after-verification` memory, memory-bank §Environment facts / §Resolved issues, CLAUDE.md Commands). Delete anything you cannot trace to a real session run.

- [x] **Step 4: Commit**

```sh
git add AGENTS.md docs/agents/toolset.md
git commit -m "docs(agents): add cross-harness agent entry (AGENTS.md) + verified toolset library"
```

---

### Task 5: Stale-knowledge audit (CLAUDE.md, README.md, memory-bank)

**Files:**
- Modify: `CLAUDE.md` (Commands block + Conventions section)
- Modify: `README.md` (currency pass)
- Modify: `docs/memory-bank.md` (dated Goals & state entry)

**Interfaces:**
- Consumes: Task 3 layout + Task 4 files (the pointer references them).
- Produces: nothing downstream — final documentation state.

- [x] **Step 1: CLAUDE.md — Commands block additions**

In the Commands ```sh block, insert AFTER the `cd web && npm run dev` line (before the blank line preceding `npm test`):

```
npm run package:deploy [-- --export-db] [-- --out-dir <dir>]
                                    # build the two cPanel upload zips into release/ (backend = HEAD via
                                    # git archive, frontend = web/dist); --export-db adds a gzipped DB dump
                                    # (same <ts> stamp). MAIN-ONLY: refuses to run off `main` (releases are
                                    # built from main; version tags exist only on main), then idempotently
                                    # tags v<package.json version> at HEAD + pushes the tag - an existing
                                    # tag is skipped (loud warning when it isn't at HEAD: bump the version)
node scripts/db-export.js [--container <name>]
                                    # standalone gzipped Docker-DB dump -> backups/ (phpMyAdmin-ready; also
                                    # exports exportDb() consumed by package:deploy --export-db)
node scripts/edge-sentinel.js       # standing M4.3 instrument (read-only, ~seconds): anchoring effect,
                                    # AI-market dissent, dissent calibration over fixture_ai_insights
```

- [x] **Step 2: CLAUDE.md — Conventions additions (docs layout + agent-library pointer)**

Append two bullets at the end of the `## Conventions` section:

```markdown
- Docs layout (2026-07-18): root `docs/` holds PROJECT documentation (`docs/README.md` is the index: `DEPLOYMENT.md`, `memory-bank.md`, `guides/`, `research/`, `agents/`, `visuals/`); `docs/dev/` holds the DEVELOPMENT pipeline (`implementation-plan.md`, `specs/`, `plans/`, `checklists/`). NEW docs: spec → `docs/dev/specs/`, plan → `docs/dev/plans/`, checklist → `docs/dev/checklists/`, research finding → `docs/research/`, guide → `docs/guides/` (this OVERRIDES the superpowers-skill default `docs/superpowers/...` location). Releases: built from `main` only via `npm run package:deploy`; version tags exist only on `main`.
- Agent operations: consult `AGENTS.md` + `docs/agents/toolset.md` (verified command playbooks, what-to-use-when, ops issue KB) BEFORE inventing operational procedures; after solving a novel operational problem, append a dated verified entry there.
```

- [x] **Step 3: README.md currency pass (light touch)**

Four edits (Edit tool):
1. Commands block — after the `cd web && npm run dev` line, add:
```
npm run package:deploy [-- --export-db]  # build the cPanel deploy zips (+ optional gzipped DB dump) into
                                    # release/ — main-only; idempotently tags v<version> after success
```
2. Commands block — after the `node src/index.js hotpicks` line, add:
```
node src/index.js aireview          # drain pending AI hot/tip verdicts once (serve runs this every 60s)
```
3. Live/deployment paragraph — replace `the app is live at **[oddspro.ke](https://oddspro.ke)** (v1.0.1, deployed
2026-07-12).` with: `the app is live at **[oddspro.ke](https://oddspro.ke)** (the 2026-07-12 build; the repo is at **v1.2.0** — tagged, deploy package built, awaiting the manual upload).`
4. "How it works" closing line — extend to: `Only correlated records are visualized. Architecture details live in `CLAUDE.md`; phase-by-phase progress in `docs/dev/implementation-plan.md`; hard-won lessons in `docs/memory-bank.md`; the full docs index is `docs/README.md`.`
5. Web UI tips bullet — replace `a **Tip** column (the safest bettable outcome per fixture, with a plain-language justification popover)` with `a **Tip** column (the best-supported market per fixture across seven families — 1X2, double chance, O/U, BTTS, draw-no-bet, team totals, odd/even — with a plain-language justification popover)`.

- [x] **Step 4: memory-bank dated state entry**

Insert this bullet at the END of the `## Goals & state (2026-07-03)` section (immediately before `## Resolved issues`):

```markdown
- **2026-07-18: state checkpoint + docs/release conventions.** Current through: v1.0.2 analytics/admin, v1.0.3 `sure` default sort (win-probability, NOT +EV — flat-stake EV ≈ −3%), v1.1.0 phone+PIN accounts/tiers, **v1.2.0 tagged (`f7f1f9d`, suite 707)** with the deploy package built (live deploy = user-gated manual upload; live still runs the 2026-07-12 build); post-tag: filters+slips cross-device sync, collapsible Help + betting glossary, sure-bets slip filter, the 2026-07-17 perf pass (insert-only `matches.metadata`, catalog-gated pivot), Detours A/B (worker-owned AI verdicts + the guarded `callStructured` harness). Honest analytics verdicts stand: M2 all-markets (display/filter only), M3 any-market tips (honestly-labelled; every market −EV at real prices), M4.1 enrichment (collection only, off by default), M4.2 mining (zero edges, zero boosters; PR-1 unbettable; H5 refuted; the policy-regime lesson). **NEW conventions:** docs reorganized — project docs at `docs/` root (`guides/`, `research/`, `agents/` + `docs/README.md` index), dev pipeline under `docs/dev/` (specs/plans/checklists; new docs go there); agent ops library `AGENTS.md` + `docs/agents/toolset.md` (verified-only, append-only); **releases are built from `main` only** via `npm run package:deploy [-- --export-db]`, which idempotently tags `v<package.json version>` at HEAD (suite 723/723 @ 2026-07-18).
```

- [x] **Step 5: Verify + commit**

```sh
npm test        # 723 pass
git add CLAUDE.md README.md docs/memory-bank.md
git commit -m "docs: staleness audit - commands/docs-layout/agent-library pointers, README + memory-bank currency"
```

---

### Task 6: Final verification, push, Claude-memory refresh

**Files:**
- Modify (outside repo): `C:\Users\User\.claude\projects\D--Apps-lab-oddspro\memory\MEMORY.md`, `resume-point.md`, `oddspro-toolset-nuggets.md`

**Interfaces:** none — closing bookkeeping.

- [x] **Step 1: Full-sweep re-verification**

```sh
npm test        # 723 pass
git log --oneline -8    # expect the 5 task commits on main
```
Re-run the Task 3 Step 6 dangling-reference grep once more — still zero hits.

- [x] **Step 2: Push**

```sh
git push origin main
```

- [x] **Step 3: Refresh Claude memory (Write tool, memory dir)**

1. `MEMORY.md` — replace the `oddspro project state` line's hook text with a 2026-07-18 headline (v1.2.0 tagged on main, live deploy user-pending; post-tag features incl. release packaging + docs reorg + agent library; suite 723/723; detail history inside the file).
2. `resume-point.md` — rewrite: main @ new sha pushed; SHIPPED summary; the docs **path mapping** (docs/superpowers/{specs,plans} → docs/dev/{specs,plans}; root implementation-plan.md → docs/dev/; checklists → docs/dev/checklists/; research → docs/research/; guides → docs/guides/; new AGENTS.md + docs/agents/toolset.md + docs/README.md) so future recalls don't chase dead paths; NEXT = nothing queued (live deploy stays user-gated per [[separation-of-duties]]); new-docs rule (specs/plans go under docs/dev/, overriding the superpowers default).
3. `oddspro-toolset-nuggets.md` — append: `2026-07-18: SHIPPED — content landed in docs/agents/toolset.md + AGENTS.md; this file remains as provenance; future verified nuggets go straight to the library (dated append).`

- [x] **Step 4: Report**

Summarize to the user: what shipped per part, the verification evidence (suite count, guard refusal output, tag-warning output, zero-dangling-grep), and the standing note that the tag-creation path fires on the next real version bump.
