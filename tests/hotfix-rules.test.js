// Pure hotfix planning/generation rules (scripts/lib/hotfix-rules.js). Zero
// imports, no fs/network - covers argument parsing, path safety, the
// generated POSIX apply script, its output protocol, and the stamp/command
// builders scripts/hotfix-remote.js assembles them with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseHotfixArgs, validateRelativePath, utcStamp, buildRemoteApplyCommand,
    buildApplyScript, parseApplyOutput, formatRollbackLine,
} from '../scripts/lib/hotfix-rules.js';

// ---- parseHotfixArgs --------------------------------------------------------

test('parseHotfixArgs collects positional files', () => {
    const r = parseHotfixArgs(['src/utils.js', 'src/db/records.js']);
    assert.deepEqual(r.files, ['src/utils.js', 'src/db/records.js']);
    assert.equal(r.FROM, null);
    assert.equal(r.RESTART, false);
    assert.equal(r.DRY, false);
});

test('parseHotfixArgs reads --from, --restart, --dry-run in any position', () => {
    const r = parseHotfixArgs(['--restart', 'src/utils.js', '--from', 'tmp/x', '--dry-run']);
    assert.deepEqual(r.files, ['src/utils.js']);
    assert.equal(r.FROM, 'tmp/x');
    assert.equal(r.RESTART, true);
    assert.equal(r.DRY, true);
});

test('parseHotfixArgs throws on an unknown flag', () => {
    assert.throws(() => parseHotfixArgs(['src/utils.js', '--bogus']), /unknown flag: --bogus/);
});

test('parseHotfixArgs throws when --from has no value', () => {
    assert.throws(() => parseHotfixArgs(['src/utils.js', '--from']), /--from requires/);
});

test('parseHotfixArgs returns no files for an empty argv', () => {
    const r = parseHotfixArgs([]);
    assert.deepEqual(r.files, []);
});

// ---- validateRelativePath ---------------------------------------------------

test('validateRelativePath accepts a plain repo-relative path', () => {
    assert.equal(validateRelativePath('src/utils.js'), 'src/utils.js');
});

test('validateRelativePath normalizes backslashes (Windows callers)', () => {
    assert.equal(validateRelativePath('src\\db\\records.js'), 'src/db/records.js');
});

test('validateRelativePath refuses an absolute POSIX path', () => {
    assert.throws(() => validateRelativePath('/etc/passwd'), /outside the repo/);
});

test('validateRelativePath refuses a drive-letter absolute path', () => {
    assert.throws(() => validateRelativePath('C:\\Windows\\system32'), /outside the repo/);
});

test('validateRelativePath refuses a `..` escape', () => {
    assert.throws(() => validateRelativePath('../outside.js'), /outside the repo/);
    assert.throws(() => validateRelativePath('src/../../outside.js'), /outside the repo/);
});

test('validateRelativePath refuses an empty or trailing-slash segment', () => {
    assert.throws(() => validateRelativePath('src//utils.js'), /outside the repo/);
    assert.throws(() => validateRelativePath('src/utils.js/'), /outside the repo/);
});

test('validateRelativePath refuses a character outside the safe allow-list', () => {
    assert.throws(() => validateRelativePath("src/utils.js'; rm -rf ~"), /character outside/);
    assert.throws(() => validateRelativePath('src/utils .js'), /character outside/);
    assert.throws(() => validateRelativePath('src/$(whoami).js'), /character outside/);
});

test('validateRelativePath refuses any .env* path, case-insensitively', () => {
    assert.throws(() => validateRelativePath('.env'), /refusing \.env/);
    assert.throws(() => validateRelativePath('.env.production'), /refusing \.env/);
    assert.throws(() => validateRelativePath('config/.ENV'), /refusing \.env/);
});

test('validateRelativePath refuses an empty string', () => {
    assert.throws(() => validateRelativePath(''), /empty path/);
});

// ---- utcStamp ----------------------------------------------------------------

test('utcStamp formats a given date as YYYYMMDD_HHMMSS in UTC', () => {
    const d = new Date(Date.UTC(2026, 9, 10, 1, 2, 3)); // month is 0-based: October
    assert.equal(utcStamp(d), '20261010_010203');
});

test('utcStamp zero-pads every field', () => {
    const d = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
    assert.equal(utcStamp(d), '20260102_030405');
});

// ---- buildRemoteApplyCommand -------------------------------------------------

test('buildRemoteApplyCommand uses ~ (never a hardcoded home prefix) and chains with &&', () => {
    const cmd = buildRemoteApplyCommand('20261010_010203');
    assert.equal(cmd, 'mkdir -p ~/tmp/hotfix-20261010_010203 && tar -xzf - -C ~/tmp/hotfix-20261010_010203 '
        + '&& sh ~/tmp/hotfix-20261010_010203/apply.sh');
    assert.ok(!cmd.includes('/home'));
});

test('buildRemoteApplyCommand rejects a malformed stamp', () => {
    assert.throws(() => buildRemoteApplyCommand('not-a-stamp'), /malformed stamp/);
});

// ---- buildApplyScript ---------------------------------------------------------

const STAMP = '20261010_010203';
const APP_DIR = '/home/oddsprok/oddspro-app-v1.4.0';
const NODE_BIN = '/home/oddsprok/.nvm/versions/node/v24.18.0/bin';

test('buildApplyScript embeds the stamp, app dir and node bin exactly once each', () => {
    const script = buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: ['src/utils.js'] });
    assert.ok(script.startsWith('#!/bin/sh'));
    assert.ok(script.includes(`STAMP='${STAMP}'`));
    assert.ok(script.includes(`APP_DIR='${APP_DIR}'`));
    assert.ok(script.includes(`NODE_BIN='${NODE_BIN}'`));
});

test('buildApplyScript emits one install_one call per file, in order', () => {
    const files = ['src/utils.js', 'src/db/records.js', 'web/dist/index.html'];
    const script = buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files });
    const positions = files.map(f => script.indexOf(`install_one '${f}'`));
    for (const p of positions) assert.ok(p >= 0, 'every file must get an install_one call');
    assert.ok(positions[0] < positions[1] && positions[1] < positions[2], 'calls must stay in the given order');
});

test('buildApplyScript runs node --check only for .js/.mjs/.cjs (case-insensitive extension)', () => {
    const script = buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: ['x.js'] });
    assert.ok(script.includes('*.js|*.mjs|*.cjs)'));
});

test('buildApplyScript includes the restart block only when restart is true', () => {
    const withRestart = buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: ['x.js'], restart: true });
    const without = buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: ['x.js'], restart: false });
    assert.ok(withRestart.includes('tmp/restart.txt'));
    assert.ok(!without.includes('tmp/restart.txt'));
});

test('buildApplyScript rolls back on failure and exits non-zero (static shape check)', () => {
    const script = buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: ['a.js', 'b.js'] });
    // Each install_one call is guarded: failure triggers rollback_all then exit 1.
    const guardCount = (script.match(/rollback_all\n\s*exit 1/g) || []).length;
    assert.equal(guardCount, 2);
    assert.ok(/rollback_all\(\) \{/.test(script));
});

test('buildApplyScript rejects an empty file list', () => {
    assert.throws(() => buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: [] }), /non-empty array/);
});

test('buildApplyScript rejects a malformed stamp', () => {
    assert.throws(() => buildApplyScript({ stamp: 'bad', appDir: APP_DIR, nodeBin: NODE_BIN, files: ['a.js'] }), /malformed stamp/);
});

test('buildApplyScript re-validates every file (never trusts a caller skip)', () => {
    assert.throws(
        () => buildApplyScript({ stamp: STAMP, appDir: APP_DIR, nodeBin: NODE_BIN, files: ['../escape.js'] }),
        /outside the repo/,
    );
});

test('buildApplyScript refuses an appDir/nodeBin containing a single quote', () => {
    assert.throws(
        () => buildApplyScript({ stamp: STAMP, appDir: "/home/a'b", nodeBin: NODE_BIN, files: ['a.js'] }),
        /appDir contains a single quote/,
    );
});

// ---- parseApplyOutput ----------------------------------------------------------

test('parseApplyOutput reads a clean successful run', () => {
    const stdout = [
        'BACKUP src/utils.js yes',
        'CHECK src/utils.js ok',
        'MD5 src/utils.js d41d8cd98f00b204e9800998ecf8427e',
        'RESULT ok',
        'RESTART touched',
    ].join('\n');
    const r = parseApplyOutput(stdout);
    assert.equal(r.ok, true);
    assert.equal(r.aborted, null);
    assert.equal(r.restarted, true);
    assert.deepEqual(r.files['src/utils.js'], {
        backedUp: true, checked: true, md5: 'd41d8cd98f00b204e9800998ecf8427e', failed: false, failReason: null,
    });
});

test('parseApplyOutput reads a brand-new file (no backup)', () => {
    const r = parseApplyOutput('BACKUP src/new.js no\nMD5 src/new.js d41d8cd98f00b204e9800998ecf8427e\nRESULT ok\n');
    assert.equal(r.files['src/new.js'].backedUp, false);
    assert.equal(r.ok, true);
});

test('parseApplyOutput reads an aborted run with rollback details', () => {
    const stdout = [
        'BACKUP a.js yes',
        'MD5 a.js d41d8cd98f00b204e9800998ecf8427e',
        'BACKUP b.js no',
        'FAIL b.js checkfail',
        'ABORT b.js',
        'ROLLBACK begin',
        'ROLLBACK restored a.js',
        'ROLLBACK removed b.js',
        'ROLLBACK done',
    ].join('\n');
    const r = parseApplyOutput(stdout);
    assert.equal(r.ok, false);
    assert.equal(r.aborted, 'b.js');
    assert.deepEqual(r.rolledBack, ['a.js']);
    assert.deepEqual(r.removed, ['b.js']);
    assert.equal(r.files['b.js'].failed, true);
    assert.equal(r.files['b.js'].failReason, 'checkfail');
});

test('parseApplyOutput tolerates unknown/blank lines (e.g. node --check stderr)', () => {
    const stdout = 'some unrelated stderr noise\n\nBACKUP a.js yes\nRESULT ok\n';
    const r = parseApplyOutput(stdout);
    assert.equal(r.ok, true);
    assert.equal(r.files['a.js'].backedUp, true);
});

test('parseApplyOutput treats missing RESULT ok as not-ok even with no ABORT line', () => {
    const r = parseApplyOutput('BACKUP a.js yes\n'); // e.g. the connection dropped mid-run
    assert.equal(r.ok, false);
});

// ---- formatRollbackLine ---------------------------------------------------------

test('formatRollbackLine prints the cp+touch command when a backup existed', () => {
    const line = formatRollbackLine({
        sshTarget: 'oddspro', appDir: APP_DIR, file: 'src/utils.js', stamp: STAMP, hadBackup: true,
    });
    assert.equal(
        line,
        `  ssh oddspro 'cp ${APP_DIR}/src/utils.js.orig-${STAMP} ${APP_DIR}/src/utils.js && touch ${APP_DIR}/tmp/restart.txt'`,
    );
});

test('formatRollbackLine explains there is nothing to roll back for a brand-new file', () => {
    const line = formatRollbackLine({
        sshTarget: 'oddspro', appDir: APP_DIR, file: 'src/new.js', stamp: STAMP, hadBackup: false,
    });
    assert.match(line, /nothing to roll back to/);
    assert.match(line, /remove .*src\/new\.js to undo/);
});
