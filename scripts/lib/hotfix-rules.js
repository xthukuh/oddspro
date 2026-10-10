// Pure planning/generation rules for scripts/hotfix-remote.js. Zero imports,
// no fs/network - offline-testable by the same convention as
// scripts/lib/sync-rules.js and src/db/*-rules.js.
//
// Why this file exists (2026-10 rework): the original hotfix-remote.js made
// ~5 ssh connections PER FILE (probe, backup, mkdir, upload, node --check) -
// on a shared host under load this was observed aborting mid-run, landing a
// half-applied set (docs/agents/toolset.md, 2026-08-29: "push ONE file per
// invocation" workaround). The fix is structural: build ONE tarball (the
// files + a generated POSIX apply script) and send it over ONE ssh call that
// extracts and runs it server-side; the backup/install/verify/rollback loop
// moves INTO that generated script so it costs zero extra round trips no
// matter how many files are in the run. Everything that can be decided
// without touching disk or network - argument parsing, path safety, the
// script text itself - lives here so it can be tested without ssh.

// --- argument parsing --------------------------------------------------------

// Mirrors the original script's hand-rolled parser: positional args are
// files, `--from <dir>` consumes its value, `--restart`/`--dry-run` are bare
// flags, anything else starting with `--` is a typo worth dying on loudly
// rather than silently ignoring.
export function parseHotfixArgs(argv) {
    const files = [];
    let FROM = null;
    let RESTART = false;
    let DRY = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--from') {
            FROM = argv[i + 1] ?? null;
            if (FROM === null) throw new Error('--from requires a directory argument');
            i++;
            continue;
        }
        if (a === '--restart') { RESTART = true; continue; }
        if (a === '--dry-run') { DRY = true; continue; }
        if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        files.push(a);
    }
    return { files, FROM, RESTART, DRY };
}

// --- path safety -------------------------------------------------------------

// Deliberately a SAFE-LIST, not a blocklist: a file name may only contain
// letters, digits, '.', '_', '-' and '/' as a separator. This is what lets
// every generated shell line below embed a file name inside single quotes
// with no escaping - the charset excludes the only character that could ever
// break out of a single-quoted POSIX string. Refusing (rather than trying to
// escape) a name outside this set is the same tradeoff scripts/lib/remote.js
// already makes for remote paths containing a single quote.
const SAFE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

// Normalizes a repo-relative file argument (Windows callers may pass
// backslashes) and throws a descriptive Error on anything that could escape
// the repo root or break the generated shell script: an absolute path (POSIX
// or a drive letter), a `..`/empty/`.`-only segment, a character outside
// SAFE_SEGMENT, or an `.env*` basename (secrets never travel through
// hotfix-remote - checked before any host contact). Returns the normalized
// posix-style relative path on success.
export function validateRelativePath(rawFile) {
    if (typeof rawFile !== 'string' || rawFile.length === 0) {
        throw new Error('refusing an empty path');
    }
    const file = rawFile.replace(/\\/g, '/');
    if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) {
        throw new Error(`refusing path outside the repo: ${rawFile}`);
    }
    const segments = file.split('/');
    for (const seg of segments) {
        if (seg === '' || seg === '.' || seg === '..') {
            throw new Error(`refusing path outside the repo: ${rawFile}`);
        }
        if (!SAFE_SEGMENT.test(seg)) {
            throw new Error(`refusing path with a character outside [A-Za-z0-9_.-]: ${rawFile}`);
        }
    }
    const base = segments[segments.length - 1];
    if (/^\.env/i.test(base)) {
        throw new Error(`refusing .env* path (secrets never travel through hotfix-remote): ${rawFile}`);
    }
    return file;
}

// --- timestamp ---------------------------------------------------------------

function pad(n) { return String(n).padStart(2, '0'); }

// One UTC stamp per run (parameterized on `date` so it is testable without
// mocking the clock). Format is deliberately shell-safe on its own
// (`[0-9_]+`) so it never needs quoting when embedded in a generated command.
export function utcStamp(date = new Date()) {
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
        + `_${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

const STAMP_RE = /^\d{8}_\d{6}$/;

// --- shell-literal helpers -----------------------------------------------------

// Single-quotes `value` for embedding in the generated POSIX script, but
// REFUSES (never escapes) a value containing a single quote - same
// "prove it, don't assert it" tradeoff as the path safe-list above. APP_DIR/
// NODE_BIN come from local, trusted (.env.deploy) config, but this still
// checks rather than assumes.
function shSingle(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`${label} must be a non-empty string`);
    }
    if (value.includes("'")) {
        throw new Error(`${label} contains a single quote (refusing to build a shell script): ${value}`);
    }
    return `'${value}'`;
}

// --- remote apply command -----------------------------------------------------

// The ONE remote command the whole run costs: extract the tarball (piped on
// stdin) into a stamp-scoped staging dir under the remote user's OWN home
// (`~`, never a hardcoded /home or /home2 prefix - the live host's home
// directory moved once already, see docs/engine/02-DATA-PIPELINE.md), then
// run the apply script that landed inside it. `&&` throughout: a failed
// extract (a truncated/corrupted tar stream) never reaches `sh apply.sh`, so
// nothing in APP_DIR is ever touched by a transfer that didn't fully land.
export function buildRemoteApplyCommand(stamp) {
    if (!STAMP_RE.test(stamp)) throw new Error(`buildRemoteApplyCommand: malformed stamp: ${JSON.stringify(stamp)}`);
    const dir = `~/tmp/hotfix-${stamp}`;
    return `mkdir -p ${dir} && tar -xzf - -C ${dir} && sh ${dir}/apply.sh`;
}

// --- apply script generation ---------------------------------------------------

// Builds the POSIX `sh` script that runs ENTIRELY on the remote host, once,
// after the tarball lands - this is where the old per-file ssh round trips
// (probe/backup/mkdir/upload/check) collapse into local shell operations on
// the already-landed staging directory. For each file, in order: back it up
// (`cp -n`, skipped + noted if no remote file exists yet to back up),
// install it from the staging copy, `node --check` a .js/.mjs/.cjs file, and
// print its md5sum. The FIRST failure anywhere aborts the whole run: every
// file installed so far in THIS run is rolled back (a prior backup restored,
// a brand-new file removed) before the script exits non-zero - so a run
// either lands completely or leaves the host exactly as it found it, with no
// extra ssh call needed to achieve that. Output lines are a small
// line-oriented protocol (BACKUP/CHECK/MD5/FAIL/ABORT/ROLLBACK/RESULT/
// RESTART) that parseApplyOutput() below reads back.
export function buildApplyScript({ stamp, appDir, nodeBin, files, restart = false }) {
    if (!STAMP_RE.test(stamp)) throw new Error(`buildApplyScript: malformed stamp: ${JSON.stringify(stamp)}`);
    if (!Array.isArray(files) || files.length === 0) {
        throw new Error('buildApplyScript: files must be a non-empty array');
    }
    for (const f of files) validateRelativePath(f); // re-validate: this function must never trust a caller's skip

    const qAppDir = shSingle(appDir, 'appDir');
    const qNodeBin = shSingle(nodeBin, 'nodeBin');

    const installCalls = files
        .map(f => `if ! install_one '${f}'; then\n    echo "ABORT ${f}"\n    rollback_all\n    exit 1\nfi`)
        .join('\n');

    const restartBlock = restart
        ? '\nmkdir -p "$APP_DIR/tmp" && touch "$APP_DIR/tmp/restart.txt" && echo "RESTART touched"\n'
        : '\n';

    return `#!/bin/sh
# Generated by scripts/hotfix-remote.js - single-use, paths bake in this
# run's STAMP/APP_DIR/file list. Safe to re-read for an audit; re-running it
# by hand reapplies the same files from this run's staging copy.
set -u

STAMP='${stamp}'
APP_DIR=${qAppDir}
NODE_BIN=${qNodeBin}
STAGING="$HOME/tmp/hotfix-$STAMP"
BACKED_UP=''
NEW_FILES=''

rollback_all() {
    echo "ROLLBACK begin"
    for f in $BACKED_UP; do
        cp "$APP_DIR/$f.orig-$STAMP" "$APP_DIR/$f"
        echo "ROLLBACK restored $f"
    done
    for f in $NEW_FILES; do
        rm -f "$APP_DIR/$f"
        echo "ROLLBACK removed $f"
    done
    echo "ROLLBACK done"
}

install_one() {
    file="$1"
    src="$STAGING/$file"
    dest="$APP_DIR/$file"
    destdir=$(dirname "$dest")
    mkdir -p "$destdir" || { echo "FAIL $file mkdir"; return 1; }
    if [ -f "$dest" ]; then
        cp -n "$dest" "$dest.orig-$STAMP" || { echo "FAIL $file backup"; return 1; }
        BACKED_UP="$BACKED_UP $file"
        echo "BACKUP $file yes"
    else
        NEW_FILES="$NEW_FILES $file"
        echo "BACKUP $file no"
    fi
    cp "$src" "$dest" || { echo "FAIL $file install"; return 1; }
    case "$file" in
        *.js|*.mjs|*.cjs)
            if ! "$NODE_BIN/node" --check "$dest" 2>&1; then
                echo "FAIL $file checkfail"
                return 1
            fi
            echo "CHECK $file ok"
            ;;
    esac
    md5sum "$dest" | awk -v f="$file" '{print "MD5", f, $1}'
    return 0
}

${installCalls}

echo "RESULT ok"
${restartBlock}exit 0
`;
}

// --- apply output parsing -----------------------------------------------------

// Reads back the line-oriented protocol buildApplyScript() prints, so the
// node-side caller can report what actually happened on the host without a
// second round trip. Tolerant of extra/unknown lines (e.g. node --check's own
// stderr, captured inline above) - only the tagged lines are interpreted.
export function parseApplyOutput(stdout) {
    const files = {};
    const touch = f => (files[f] ??= { backedUp: null, checked: null, md5: null, failed: false, failReason: null });
    let ok = false;
    let aborted = null;
    const rolledBack = [];
    const removed = [];
    let restarted = false;

    for (const rawLine of String(stdout ?? '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        let m;
        if ((m = /^BACKUP (\S+) (yes|no)$/.exec(line))) {
            touch(m[1]).backedUp = m[2] === 'yes';
        } else if ((m = /^CHECK (\S+) ok$/.exec(line))) {
            touch(m[1]).checked = true;
        } else if ((m = /^MD5 (\S+) \\?([0-9a-f]{32})$/.exec(line))) {
            // GNU md5sum prefixes the whole line with a stray backslash when
            // it decides the filename needs escaping (e.g. embeds a literal
            // backslash) - never true for our own validated file names, but
            // tolerated here rather than turning a host-specific md5sum
            // quirk into a false "no md5" report.
            touch(m[1]).md5 = m[2];
        } else if ((m = /^FAIL (\S+) (\S+)$/.exec(line))) {
            const rec = touch(m[1]);
            rec.failed = true;
            rec.failReason = m[2];
        } else if ((m = /^ABORT (\S+)$/.exec(line))) {
            aborted = m[1];
        } else if ((m = /^ROLLBACK restored (\S+)$/.exec(line))) {
            rolledBack.push(m[1]);
        } else if ((m = /^ROLLBACK removed (\S+)$/.exec(line))) {
            removed.push(m[1]);
        } else if (line === 'RESULT ok') {
            ok = true;
        } else if (line === 'RESTART touched') {
            restarted = true;
        }
    }
    return { ok: ok && !aborted, files, aborted, rolledBack, removed, restarted };
}

// --- manual rollback line -----------------------------------------------------

// The printed-up-front rollback line for ONE file, for the rare case a bad
// fix needs reverting after the fact (the apply script already reverts a
// run that fails DURING itself - this is for a run that succeeded but whose
// fix the operator later wants to undo by hand).
export function formatRollbackLine({ sshTarget, appDir, file, stamp, hadBackup }) {
    const remotePath = `${appDir}/${file}`;
    const backupPath = `${remotePath}.orig-${stamp}`;
    if (!hadBackup) {
        return `  # ${file}: no prior remote version existed - nothing to roll back to (remove ${remotePath} to undo)`;
    }
    return `  ssh ${sshTarget} 'cp ${backupPath} ${remotePath} && touch ${appDir}/tmp/restart.txt'`;
}
