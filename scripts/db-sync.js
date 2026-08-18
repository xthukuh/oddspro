// Keeps the local dev warehouse current with the live host, and vice versa.
// Live wins outright on a pull: canonical/derived tables are REPLACE-only
// (remote rows overwrite local, nothing local-only is ever removed by them),
// the matches/odds_markets trio additionally windowed-DELETEs first in
// windowed mode (see scripts/lib/sync-rules.js's module comment for why).
// Every table sync also lands a compressed dump under backups/sync/ - the
// transfer doubles as a backup, kept forever (never auto-deleted).
//
// Usage:
//   node scripts/db-sync.js status [--json]
//   node scripts/db-sync.js pull [--tables a,b] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//                                [--full] [--dry-run] [--yes] [--force]
//   node scripts/db-sync.js push --tables a,b [--since ...] [--until ...] [--dry-run] [--yes]
//   node scripts/db-sync.js backup --remote-db <name> [--dry-run]
//
// pull/push default window (neither --since nor --full given): since =
// today-3d, until = today+8d (EAT) - the routine daily catch-up range that
// also covers upcoming fixtures. status/pull compare `MAX(name) FROM
// knex_migrations` on both sides first and abort on a mismatch unless
// --force (a schema-behind side can silently misinterpret a REPLACE).
//
// The DB password never appears in anything this script prints: dry-run
// previews and any echoed command are run through maskCmd() first. Real
// (non-dry) ssh/import calls still need the real password to authenticate -
// only the PRINTED form is masked.
//
// push is implemented in full but this repo's operating rule is that it is
// only ever invoked with --dry-run - the live host stays read-only for us.

import { readFileSync, mkdirSync, statSync, createWriteStream } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createGzip } from 'node:zlib';
import path from 'node:path';
import { db, closeDb } from '../src/db/connection.js';
import { config } from '../src/config.js';
import {
    remoteConfig, sshInput, sshStreamUpload, sshStreamDownload, fmtMB,
} from './lib/remote.js';
import {
    planPull, dumpArgs, importPreamble, windowDeleteSql, statusRows, compareStatus,
} from './lib/sync-rules.js';
import { importDb } from './db-import.js';
import { resolveContainer, resolveDumpBinary } from './db-export.js';
import { eatDateKey } from '../src/db/auto-rules.js';

class CliError extends Error {}
function die(msg) { throw new CliError(msg); }

// ---- small shared helpers ---------------------------------------------------

function tsStamp() {
    return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
}

// POSIX single-quote wrap - every dumpArgs() token rides through this before
// touching a remote command string built for ssh (the remote shell parses
// the whole cmd, so a --where clause's spaces/parens must survive intact).
function shQuote(s) {
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Never print a real password: replace every occurrence of the configured
// DB_PASS with '***'. Used on every dry-run/preview line - real (non-dry)
// ssh calls still carry the live password, this only guards what's echoed.
function maskCmd(cmd, cfg) {
    return cfg.DB_PASS ? cmd.split(cfg.DB_PASS).join('***') : cmd;
}

// Cached so the top-level catch (below) can mask a leaked password in ANY
// uncaught error, not just the ones this script explicitly wraps - defense
// in depth alongside safeSshInput().
let cachedCfg = null;

function getCfg() {
    const version = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version;
    try {
        cachedCfg = remoteConfig({ version });
        return cachedCfg;
    } catch (e) {
        die(e.message);
    }
}

// sshInput() (and ssh()) embed the full remote command - MYSQL_PWD included -
// verbatim in their thrown Error on a non-zero exit. Every call site in this
// script that builds a command from cfg.MYSQL_ENV goes through this wrapper
// so a connection/auth failure can never print the real password.
function safeSshInput(cfg, cmd, input, opts) {
    try {
        return sshInput(cfg, cmd, input, opts);
    } catch (e) {
        throw new Error(maskCmd(e.message, cfg));
    }
}

// Run `sql` against the remote DB via `mysql -N -B` (no headers, tab-
// separated) over stdin - never `-e "..."` (quoting hazards on a WHERE
// clause carrying quotes/parens). Returns an array of string[] rows; 'NULL'
// literals become JS null. One statement per call (kept simple over batching
// several SELECTs and having to demux which rows came from which).
function remoteQueryRaw(cfg, dbName, sql) {
    const r = safeSshInput(cfg, `${cfg.MYSQL_ENV} mysql -u ${cfg.DB_USER} -N -B ${dbName}`, sql);
    if (!r.stdout) return [];
    return r.stdout.split('\n').map(line => line.split('\t').map(f => (f === 'NULL' ? null : f)));
}

// Remote 'YYYY-MM-DD[ HH:MM:SS]' -> Date, assumed EAT wall-clock (the
// codebase-wide pinned-session convention - src/db/auto-rules.js's
// EAT_OFFSET_MS comment). null passes through.
function parseRemoteDatetime(v) {
    if (v === null || v === undefined) return null;
    return new Date(`${v.replace(' ', 'T')}+03:00`);
}

// mysql2 parses a DATE/DATETIME result using the Node process's OWN local
// timezone as the Date constructor's frame (new Date(y, m, d, ...)) - so the
// object's LOCAL getters (getFullYear/getMonth/getDate) recover the literal
// calendar day MySQL returned, regardless of what timezone this process
// happens to run in. .toISOString() renders in UTC instead, which silently
// loses a day whenever that offset crosses midnight (verified: this exact
// bug shifted every local day bucket back by one against remote's, which
// reads its DATE value as a plain string with no Date round-trip at all).
function fmtDay(v) {
    if (v instanceof Date) {
        const p = n => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
    }
    return v == null ? '-' : String(v);
}

function fmtTs(v) {
    if (v instanceof Date) return v.toISOString();
    return v == null ? 'null' : String(v);
}

// The canonical migration-head SQL, reused verbatim by both the full status
// fetch and pull's lightweight gate check (never a second copy of the text).
const MIGRATION_SQL = statusRows().find(r => r.key === 'migration').sql;

async function migrationHeads(cfg) {
    const [rows] = await db.raw(MIGRATION_SQL);
    const localHead = rows[0]?.name ?? null;
    const remoteRows = remoteQueryRaw(cfg, cfg.DB_NAME, `${MIGRATION_SQL};`);
    const remoteHead = (remoteRows[0] || [])[0] ?? null;
    return { localHead, remoteHead };
}

// ---- status -------------------------------------------------------------------

async function localStatus() {
    const raw = {};
    for (const { key, sql } of statusRows()) {
        const [rows] = await db.raw(sql);
        raw[key] = rows;
    }
    return {
        tables: raw.tables.map(r => ({
            table_name: r.table_name,
            table_rows: Number(r.table_rows) || 0,
            mb: r.mb == null ? null : Number(r.mb),
        })),
        matches_by_day: raw.matches_by_day.map(r => ({
            day: fmtDay(r.day), provider: r.provider, n: Number(r.n) || 0,
            last_updated: r.last_updated instanceof Date ? r.last_updated : null,
        })),
        freshness: {
            matches_updated_at: raw.freshness[0]?.matches_updated_at ?? null,
            fixtures_max_kickoff: raw.freshness[0]?.fixtures_max_kickoff ?? null,
            fixtures_updated_at: raw.freshness[0]?.fixtures_updated_at ?? null,
        },
        migration: { name: raw.migration[0]?.name ?? null },
    };
}

function remoteStatus(cfg, dbName) {
    const raw = {};
    for (const { key, sql } of statusRows()) {
        raw[key] = remoteQueryRaw(cfg, dbName, `${sql};`);
    }
    const [muA, fmk, fua] = raw.freshness[0] || [];
    return {
        tables: raw.tables.map(([table_name, table_rows, mb]) => ({
            table_name, table_rows: Number(table_rows) || 0, mb: mb == null ? null : Number(mb),
        })),
        matches_by_day: raw.matches_by_day.map(([day, provider, n, last_updated]) => ({
            day, provider, n: Number(n) || 0, last_updated: parseRemoteDatetime(last_updated),
        })),
        freshness: {
            matches_updated_at: parseRemoteDatetime(muA),
            fixtures_max_kickoff: parseRemoteDatetime(fmk),
            fixtures_updated_at: parseRemoteDatetime(fua),
        },
        migration: { name: (raw.migration[0] || [])[0] ?? null },
    };
}

// Side-by-side "who has more of this day/provider" - deliberately NOT part of
// compareStatus (that stays scoped to tables/freshness/migration); coverage
// is a display-only join keyed on (day, provider).
function joinMatchesByDay(localRows, remoteRows) {
    const map = new Map();
    for (const r of localRows) map.set(`${r.day}|${r.provider}`, { day: r.day, provider: r.provider, local_n: r.n, remote_n: 0 });
    for (const r of remoteRows) {
        const k = `${r.day}|${r.provider}`;
        const e = map.get(k) || { day: r.day, provider: r.provider, local_n: 0, remote_n: 0 };
        e.remote_n = r.n;
        map.set(k, e);
    }
    return [...map.values()].sort((a, b) => (a.day !== b.day ? (a.day < b.day ? 1 : -1) : a.provider.localeCompare(b.provider)));
}

function printStatus(cfg, local, remote, compare) {
    console.log(`[db-sync] local "${config.DB_DATABASE}"  vs  remote "${cfg.DB_NAME}" @ ${cfg.SSH_TARGET}`);

    console.log('\n=== Row counts / size (SYNC_TABLES) ===');
    const localTables = new Map(local.tables.map(t => [t.table_name, t]));
    const remoteTables = new Map(remote.tables.map(t => [t.table_name, t]));
    console.log(`  ${'table'.padEnd(24)}${'local rows'.padStart(12)}${'remote rows'.padStart(13)}  m  ${'local MB'.padStart(10)}${'remote MB'.padStart(11)}`);
    for (const row of compare.filter(r => r.key.startsWith('tables.'))) {
        const name = row.key.slice(7);
        const lt = localTables.get(name);
        const rt = remoteTables.get(name);
        console.log(`  ${name.padEnd(24)}${String(row.local).padStart(12)}${String(row.remote).padStart(13)}  ${row.marker}  ${String(lt?.mb ?? '-').padStart(10)}${String(rt?.mb ?? '-').padStart(11)}`);
    }

    console.log('\n=== Freshness ===');
    for (const row of compare.filter(r => r.key.startsWith('freshness.'))) {
        console.log(`  ${row.key.slice(10).padEnd(24)} local=${fmtTs(row.local).padEnd(26)} remote=${fmtTs(row.remote).padEnd(26)} ${row.marker}`);
    }

    const mig = compare.find(r => r.key === 'migration');
    console.log('\n=== Migration head ===');
    console.log(`  local=${mig.local}  remote=${mig.remote}  ${mig.marker}`);
    if (mig.marker !== '=') console.log('  NOTE: heads differ - a pull will abort unless --force.');

    console.log('\n=== Match coverage, last 7 days (day / provider) ===');
    const joined = joinMatchesByDay(local.matches_by_day, remote.matches_by_day);
    console.log(`  ${'day'.padEnd(12)}${'provider'.padEnd(10)}${'local n'.padStart(9)}${'remote n'.padStart(10)}`);
    for (const r of joined) {
        console.log(`  ${r.day.padEnd(12)}${r.provider.padEnd(10)}${String(r.local_n).padStart(9)}${String(r.remote_n).padStart(10)}`);
    }
}

async function cmdStatus(flags) {
    const cfg = getCfg();
    const local = await localStatus();
    const remote = remoteStatus(cfg, cfg.DB_NAME);
    const compare = compareStatus(local, remote);
    if (flags.json) {
        console.log(JSON.stringify({ local, remote, compare }, null, 2));
        return;
    }
    printStatus(cfg, local, remote, compare);
}

// ---- pull -----------------------------------------------------------------

function buildRemoteDumpCmd(cfg, p) {
    const args = dumpArgs({ db: cfg.DB_NAME, table: p.table, where: p.where, full: p.mode === 'full' });
    return `${cfg.MYSQL_ENV} mariadb-dump -u ${cfg.DB_USER} ${args.map(shQuote).join(' ')} | gzip -9`;
}

function progressPrinter(label) {
    let lastDraw = 0;
    return ({ bytes, total, seconds }) => {
        const now = Date.now();
        if (now - lastDraw < 250 && bytes !== total) return;
        lastDraw = now;
        const pct = total ? (bytes / total * 100).toFixed(1) : '0.0';
        const rate = bytes / Math.max(seconds, 0.001) / 1048576;
        process.stdout.write(`\r[db-sync] ${label}: ${pct}%  ${(bytes / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB  ${rate.toFixed(1)} MB/s   `);
        if (bytes === total) process.stdout.write('\n');
    };
}

function resolvePullWindow(flags) {
    const full = !!flags.full;
    let since = flags.since || null;
    let until = flags.until || null;
    if (!full) {
        if (!since) since = eatDateKey(Date.now() - 3 * 86400000);
        if (!until) until = eatDateKey(Date.now() + 8 * 86400000);
    }
    return { since, until, full };
}

function printPlan(plan, since, until, full) {
    console.log(`[db-sync] plan (${plan.length} table${plan.length === 1 ? '' : 's'})${full ? ' - FULL' : ` - window ${since} .. ${until}`}:`);
    for (const p of plan) console.log(`  ${p.table.padEnd(24)} ${p.mode}${p.where ? `  WHERE ${p.where}` : ''}`);
}

async function cmdPull(flags) {
    const cfg = getCfg();

    const { localHead, remoteHead } = await migrationHeads(cfg);
    if (localHead !== remoteHead) {
        if (!flags.force) die(`migration head mismatch: local="${localHead}" remote="${remoteHead}". Migrate to match, or pass --force to override.`);
        console.warn(`[db-sync] WARNING: migration head mismatch overridden by --force (local="${localHead}" remote="${remoteHead}").`);
    }

    const { since, until, full } = resolvePullWindow(flags);
    const tables = flags.tables ? flags.tables.split(',').map(s => s.trim()).filter(Boolean) : null;
    let plan;
    try {
        plan = planPull({ tables, since, until, full });
    } catch (e) {
        die(e.message);
    }
    if (!plan.length) die('nothing to pull (empty table list).');
    printPlan(plan, since, until, full);

    const stamp = tsStamp();
    if (flags['dry-run']) {
        console.log('\n[db-sync] dry-run - commands that would run (password masked):');
        for (const p of plan) {
            const dumpCmd = buildRemoteDumpCmd(cfg, p);
            const localGz = path.join('backups', 'sync', `${p.table}_${stamp}.sql.gz`);
            console.log(`\n  [remote] ${maskCmd(dumpCmd, cfg)}`);
            console.log(`    -> ${localGz}`);
            if (p.mode === 'window') {
                const del = windowDeleteSql(p.table, since, until);
                if (del) console.log(`  [local]  ${del}`);
            }
            console.log(`  [local]  import ${localGz} into "${config.DB_DATABASE}" (preamble=true, --replace)`);
        }
        return;
    }

    if (!flags.yes) die('refusing to pull without --yes (this OVERWRITES local rows for the planned tables). Preview first with --dry-run.');

    mkdirSync(path.join('backups', 'sync'), { recursive: true });
    const summaries = [];
    for (const p of plan) {
        console.log(`\n[db-sync] === ${p.table} (${p.mode}) ===`);
        const t0 = Date.now();
        const dumpCmd = buildRemoteDumpCmd(cfg, p);
        const localGz = path.join('backups', 'sync', `${p.table}_${stamp}.sql.gz`);
        await sshStreamDownload(cfg, dumpCmd, localGz, `dump ${p.table}`);
        const gzBytes = statSync(localGz).size;

        const [beforeRows] = await db.raw(`SELECT COUNT(*) AS n FROM \`${p.table}\``);
        const before = Number(beforeRows[0].n) || 0;

        if (p.mode === 'window') {
            const del = windowDeleteSql(p.table, since, until);
            if (del) {
                console.log(`[db-sync] ${p.table}: windowed delete before import...`);
                await db.raw(del);
            }
        }

        await importDb({ inPath: localGz, preamble: true, onProgress: progressPrinter(`import ${p.table}`) });

        const [afterRows] = await db.raw(`SELECT COUNT(*) AS n FROM \`${p.table}\``);
        const after = Number(afterRows[0].n) || 0;
        const secs = (Date.now() - t0) / 1000;
        const delta = after - before;
        console.log(`[db-sync] ${p.table}: rows ${before} -> ${after} (${delta >= 0 ? '+' : ''}${delta})  ${fmtMB(gzBytes)} gz  ${secs.toFixed(1)}s`);
        summaries.push({ table: p.table, mode: p.mode, before, after, gzBytes, secs });
    }

    console.log('\n[db-sync] summary:');
    for (const s of summaries) {
        console.log(`  ${s.table.padEnd(24)} ${s.mode.padEnd(7)} ${String(s.before).padStart(9)} -> ${String(s.after).padEnd(9)}  ${fmtMB(s.gzBytes).padStart(10)}  ${s.secs.toFixed(1)}s`);
    }

    console.log('\n[db-sync] post-pull counts comparison:');
    const local = await localStatus();
    const remote = remoteStatus(cfg, cfg.DB_NAME);
    const compare = compareStatus(local, remote);
    const synced = new Set(plan.map(p => p.table));
    for (const row of compare) {
        if (row.key.startsWith('tables.') && synced.has(row.key.slice(7))) {
            console.log(`  ${row.key.padEnd(30)} local=${row.local}  remote=${row.remote}  ${row.marker}`);
        }
    }
}

// ---- push (implemented in full - repo rule: only ever run with --dry-run) --

function remoteImportCmd(cfg, dbName, { preamble }) {
    const base = `gunzip | ${cfg.MYSQL_ENV} mysql -u ${cfg.DB_USER} ${dbName}`;
    if (!preamble) return base;
    // Preamble text has to reach mysql's stdin AHEAD of the decompressed dump,
    // but sshStreamUpload only streams the local file's bytes - so the remote
    // side stitches them together: printf the preamble, then gunzip the piped
    // file, both feeding one mysql session.
    return `(printf '%s' ${shQuote(importPreamble())}; gunzip) | ${cfg.MYSQL_ENV} mysql -u ${cfg.DB_USER} ${dbName}`;
}

// Dump one local table (docker exec + mariadb-dump/mysqldump), gzipped, to
// outPath - the push-direction twin of buildRemoteDumpCmd, using the exact
// same dumpArgs() so the two directions can never drift.
async function dumpLocalTable({ container, clientBin, table, where, full, outPath }) {
    const args = dumpArgs({ db: config.DB_DATABASE, table, where, full });
    const dump = spawn('docker', ['exec', '-e', `MYSQL_PWD=${config.DB_PASSWORD}`, container, clientBin, `-u${config.DB_USERNAME}`, ...args]);
    const gzip = createGzip();
    const out = createWriteStream(outPath);
    let stderr = '';
    dump.stderr.on('data', d => stderr += d);
    dump.stdout.pipe(gzip).pipe(out);
    const exitCode = await new Promise((resolve, reject) => {
        dump.on('error', e => reject(new Error(`docker exec failed to start: ${e.message}`)));
        dump.on('close', resolve);
    });
    await new Promise(resolve => out.on('close', resolve));
    if (exitCode !== 0) throw new Error(`local dump of ${table} exited ${exitCode}:\n${stderr.trim()}`);
    return statSync(outPath).size;
}

async function cmdPush(flags) {
    const cfg = getCfg();
    if (!flags.tables) die('push requires --tables a,b (explicit list - no default table set, never instance tables).');
    const tables = flags.tables.split(',').map(s => s.trim()).filter(Boolean);
    const { since, until, full } = resolvePullWindow(flags);
    let plan;
    try {
        plan = planPull({ tables, since, until, full });
    } catch (e) {
        die(e.message);
    }
    printPlan(plan, since, until, full);

    const stamp = tsStamp();
    if (flags['dry-run']) {
        console.log('\n[db-sync] dry-run - commands that would run (password masked):');
        for (const p of plan) {
            const localGz = path.join('backups', 'sync', `push_${p.table}_${stamp}.sql.gz`);
            console.log(`\n  [local]  docker exec <mariadb-dump|mysqldump> ${dumpArgs({ db: config.DB_DATABASE, table: p.table, where: p.where, full: p.mode === 'full' }).join(' ')} | gzip -9`);
            console.log(`    -> ${localGz}`);
            if (p.mode === 'window') {
                const del = windowDeleteSql(p.table, since, until);
                if (del) console.log(`  [remote] ${del}`);
            }
            console.log(`  [remote] ${maskCmd(remoteImportCmd(cfg, cfg.DB_NAME, { preamble: true }), cfg)}`);
        }
        console.log('\n[db-sync] dry-run only - nothing was touched (push never runs for real in this repo without a separate explicit go-ahead).');
        return;
    }

    if (!flags.yes) die('refusing to push without --yes (this OVERWRITES remote rows for the planned tables). Preview first with --dry-run.');

    mkdirSync(path.join('backups', 'sync'), { recursive: true });
    const container = resolveContainer(process.env.DB_DOCKER_CONTAINER || null);
    const clientBin = resolveDumpBinary(container);
    for (const p of plan) {
        console.log(`\n[db-sync] === ${p.table} (${p.mode}) ===`);
        const localGz = path.join('backups', 'sync', `push_${p.table}_${stamp}.sql.gz`);
        const bytes = await dumpLocalTable({ container, clientBin, table: p.table, where: p.where, full: p.mode === 'full', outPath: localGz });
        console.log(`[db-sync] dumped local ${p.table}: ${fmtMB(bytes)}`);

        if (p.mode === 'window') {
            const del = windowDeleteSql(p.table, since, until);
            if (del) {
                console.log(`[db-sync] ${p.table}: remote windowed delete before import...`);
                safeSshInput(cfg, `${cfg.MYSQL_ENV} mysql -u ${cfg.DB_USER} ${cfg.DB_NAME}`, del);
            }
        }

        await sshStreamUpload(cfg, localGz, remoteImportCmd(cfg, cfg.DB_NAME, { preamble: true }), `push ${p.table}`);
    }
    console.log('\n[db-sync] push done.');
}

// ---- backup -----------------------------------------------------------------

async function cmdBackup(flags) {
    const cfg = getCfg();
    const name = flags['remote-db'];
    if (!name) die('backup requires --remote-db <name>.');
    if (!/^[A-Za-z0-9_]+$/.test(name)) die(`--remote-db "${name}" must be letters/digits/underscore only.`);

    mkdirSync('backups', { recursive: true });
    const stamp = tsStamp();
    const outPath = path.join('backups', `remote_${name}_${stamp}.sql.gz`);
    const remoteCmd = `${cfg.MYSQL_ENV} mariadb-dump -u ${cfg.DB_USER} --single-transaction --quick --no-tablespaces`
        + ` --default-character-set=utf8mb4 --routines --triggers --events ${shQuote(name)} | gzip -9`;

    console.log(`[db-sync] backup ${cfg.SSH_TARGET}:${name} -> ${outPath}`);
    if (flags['dry-run']) {
        console.log(`  [remote] ${maskCmd(remoteCmd, cfg)}`);
        return;
    }

    const t0 = Date.now();
    await sshStreamDownload(cfg, remoteCmd, outPath, `backup ${name}`);
    const secs = (Date.now() - t0) / 1000;
    const bytes = statSync(outPath).size;

    console.log('[db-sync] verifying gzip integrity (gzip -t)...');
    const check = spawnSync('gzip', ['-t', outPath]);
    if (check.error) die(`could not run "gzip -t": ${check.error.message}`);
    if (check.status !== 0) die(`gzip -t failed on ${outPath}: ${(check.stderr || '').toString().trim()}`);

    console.log(`[db-sync] backup OK: ${outPath} (${fmtMB(bytes)}, ${secs.toFixed(1)}s).`);
}

// ---- entry --------------------------------------------------------------------

function parseArgs(argv) {
    const BOOL = new Set(['full', 'dry-run', 'yes', 'force', 'json']);
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        if (BOOL.has(key)) flags[key] = true;
        else flags[key] = argv[++i];
    }
    return flags;
}

async function main() {
    const command = process.argv[2];
    const flags = parseArgs(process.argv.slice(3));
    switch (command) {
        case 'status': return cmdStatus(flags);
        case 'pull': return cmdPull(flags);
        case 'push': return cmdPush(flags);
        case 'backup': return cmdBackup(flags);
        default:
            console.error('Usage: node scripts/db-sync.js <status|pull|push|backup> [...flags]');
            console.error('  status                          side-by-side local vs live');
            console.error('  pull   [--tables a,b] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--full] [--dry-run] [--yes] [--force]');
            console.error('  push   --tables a,b [--since ...] [--until ...] [--dry-run] [--yes]');
            console.error('  backup --remote-db <name> [--dry-run]');
            process.exitCode = 1;
    }
}

try {
    await main();
} catch (e) {
    let msg = e instanceof CliError ? e.message : (e.stack || e.message);
    if (cachedCfg) msg = maskCmd(msg, cachedCfg);
    console.error(`[db-sync] ERROR: ${msg}`);
    process.exitCode = 1;
} finally {
    await closeDb();
}
