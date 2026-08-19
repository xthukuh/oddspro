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
//
// Every downloaded dump (pull's per-table dumps, backup's schema pass and
// per-table/chunk data dumps) is verified complete before it's trusted for
// anything - `gzip -t` alone is NOT a completeness check (verified live: a
// shared host killing the remote connection mid-dump still lets gzip close
// its own output cleanly). See the "dump completeness" section below.
// `backup` additionally splits big tables into bounded PK-range chunks so
// no single remote query runs long enough to hit whatever killed the old
// one-shot dump.

import { readFileSync, mkdirSync, statSync, createWriteStream, createReadStream, existsSync, unlinkSync, writeFileSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createGzip, createGunzip } from 'node:zlib';
import path from 'node:path';
import { db, closeDb } from '../src/db/connection.js';
import { config } from '../src/config.js';
import {
    remoteConfig, sshInput, sshStreamUpload, sshStreamDownload, fmtMB,
} from './lib/remote.js';
import {
    planPull, dumpArgs, importPreamble, windowDeleteSql, statusRows, compareStatus,
    dumpLooksComplete, OWN_DUMP_MARKER, BACKUP_CHUNK_SIZE, planIdChunks,
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

// ---- dump completeness (Round 1 fix, 2026-08-19) ---------------------------
// Verified live: a shared cPanel host kills a long-running remote
// mariadb-dump connection mid-stream, but gzip closes ITS OWN output
// cleanly regardless - `gzip -t` passes on a truncated file. It checks the
// gzip FRAME, never that mariadb-dump actually finished. Every downloaded
// dump is now verified against `dumpLooksComplete` (sync-rules.js) before
// it's trusted for anything.

const MAX_DUMP_ATTEMPTS = 3;
const TAIL_BYTES = 2048;

// Stream-decompress `filePath` end to end, keeping only the last `tailBytes`
// of decompressed text - the file can be gigabytes, this must never hold it
// all in memory (there is no way to seek inside a gzip stream, so reaching
// the true tail means reading through the whole thing).
function readGzipTail(filePath, tailBytes = TAIL_BYTES) {
    return new Promise((resolve, reject) => {
        const src = createReadStream(filePath);
        const gunzip = createGunzip();
        let tail = Buffer.alloc(0);
        gunzip.on('data', chunk => {
            tail = Buffer.concat([tail, chunk]);
            if (tail.length > tailBytes) tail = tail.subarray(tail.length - tailBytes);
        });
        gunzip.on('end', () => resolve(tail.toString('utf8')));
        gunzip.on('error', reject);
        src.on('error', reject);
        src.pipe(gunzip);
    });
}

// A gunzip error here means the gzip FRAME itself is truncated (worse than
// a truncated SQL body inside a valid frame) - either way, not complete.
async function verifyDumpComplete(filePath) {
    try {
        return dumpLooksComplete(await readGzipTail(filePath));
    } catch {
        return false;
    }
}

// set -o pipefail wrapping so a killed mariadb-dump propagates its non-zero
// exit through the whole `... | gzip -9` pipe instead of gzip's own clean
// exit silently reporting success (verified live - see docs/agents/
// toolset.md's 2026-08-19 entry for the reproduction). Applying this
// requires re-quoting the ALREADY-single-quoted dumpCmd as one argument to
// `bash -c`; shQuote is a generic POSIX single-quote escaper, safe to apply
// recursively to a string that itself contains single-quoted sub-pieces.
function wrapPipefail(scriptBody) {
    return `bash -c ${shQuote(`set -o pipefail; ${scriptBody}`)}`;
}

// Download `remoteCmd`'s output to `outPath`, verifying the completeness
// trailer and retrying (fresh attempt, partial file discarded) up to
// MAX_DUMP_ATTEMPTS times. Throws (never silently proceeds) if every
// attempt comes back incomplete - the caller's whole operation aborts;
// nothing downstream (import, chunk concatenation) ever sees a partial file.
async function downloadVerified(cfg, remoteCmd, outPath, label) {
    let lastReason = 'unknown';
    for (let attempt = 1; attempt <= MAX_DUMP_ATTEMPTS; attempt++) {
        try {
            await sshStreamDownload(cfg, remoteCmd, outPath, `${label} (try ${attempt}/${MAX_DUMP_ATTEMPTS})`);
        } catch (e) {
            lastReason = maskCmd(e.message, cfg);
            console.error(`[db-sync] dump transfer failed: ${label}, attempt ${attempt}/${MAX_DUMP_ATTEMPTS}: ${lastReason}`);
            if (existsSync(outPath)) unlinkSync(outPath);
            continue;
        }
        if (await verifyDumpComplete(outPath)) return;
        lastReason = 'no completion trailer in the last 2 KB - connection was likely killed mid-dump';
        console.error(`[db-sync] INCOMPLETE dump: ${label}, attempt ${attempt}/${MAX_DUMP_ATTEMPTS} (${lastReason})`);
        if (existsSync(outPath)) unlinkSync(outPath);
    }
    throw new Error(`dump never completed after ${MAX_DUMP_ATTEMPTS} attempts: ${label} (${lastReason})`);
}

// Append srcPath's raw bytes onto destPath and delete srcPath - used to
// assemble one final gz file out of several independently-downloaded gzip
// members. Concatenated gzip members are valid gzip (RFC 1952 §2.2): `cat
// a.gz b.gz | gunzip` decompresses as the concatenation of both payloads,
// which is exactly the linear CREATE-TABLE-then-INSERT shape a normal
// single-shot mariadb-dump produces - restoring the result is unchanged
// (`gzip -dc file.sql.gz | mysql ...`).
function appendAndDelete(srcPath, destPath) {
    return new Promise((resolve, reject) => {
        const rs = createReadStream(srcPath);
        const ws = createWriteStream(destPath, { flags: 'a' });
        rs.on('error', reject);
        ws.on('error', reject);
        ws.on('close', () => { unlinkSync(srcPath); resolve(); });
        rs.pipe(ws);
    });
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

// Pull dumps keep --compact (small/fast, matches the pre-Round-1 shape) -
// --compact suppresses mariadb-dump's own `-- Dump completed on` trailer,
// so an explicit marker is appended ONLY when mariadb-dump itself exits 0
// (the `&&`), and the whole thing runs under pipefail so a killed dump's
// non-zero exit survives the `| gzip -9` instead of being swallowed by
// gzip's own clean exit. Parameterized on (where, full) rather than taking
// the whole plan entry so the bisection fallback (below) can build a piece
// with a NARROWER where and full FORCED false (never --add-drop-table past
// the first attempt - see pullTableData's comment).
function buildRemoteDumpCmdFor(cfg, table, where, full) {
    const args = dumpArgs({ db: cfg.DB_NAME, table, where, full });
    const dumpCmd = `${cfg.MYSQL_ENV} mariadb-dump -u ${cfg.DB_USER} ${args.map(shQuote).join(' ')}`;
    return wrapPipefail(`(${dumpCmd} && echo ${shQuote(OWN_DUMP_MARKER)}) | gzip -9`);
}

function buildRemoteDumpCmd(cfg, p) {
    return buildRemoteDumpCmdFor(cfg, p.table, p.where, p.mode === 'full');
}

// Download one table's pull dump, falling back to id-bisected pieces if the
// normal single-shot dump keeps failing completeness verification - live-
// verified necessary: odds_markets's windowed dump (no chunking at all in
// the pre-Round-1 design) died at row ~2,146,369 on all 3 flat retries, and
// the earlier, unfixed pull had in fact silently imported a truncated table
// (confirmed: local's windowed COUNT(*) came up ~3M short of remote's for
// the identical window predicate - see the Round 1 report). All pieces are
// appended into ONE local gz file (localGz) exactly like backup's
// concatenation approach, so the caller's downstream import is unchanged.
//
// Full-mode tables use --add-drop-table to carry schema AND data in one
// call; that can't be safely handed to bisection as-is (a SECOND piece
// with --add-drop-table would drop the table again and destroy the FIRST
// piece's just-imported rows). So on a full-mode failure, a schema-only
// pass runs once first (`--add-drop-table` + `--where=1=0` - the DROP/
// CREATE is unconditional, the `1=0` filter just yields zero INSERT rows),
// then every data piece uses `full:false` (--no-create-info) from then on,
// window-mode tables never needed --add-drop-table in the first place so
// they skip straight to bisected --no-create-info pieces.
async function pullTableData(cfg, p, chunkDir, stamp, localGz) {
    writeFileSync(localGz, Buffer.alloc(0));
    const acc = { plannedTotal: 0, chunkCount: 0, fileIdx: 0 };
    const full = p.mode === 'full';

    acc.fileIdx++;
    const firstTmp = path.join(chunkDir, `${p.table}_${acc.fileIdx}_${stamp}.sql.gz`);
    try {
        await downloadVerified(cfg, buildRemoteDumpCmdFor(cfg, p.table, p.where, full), firstTmp, `dump ${p.table}`);
        await appendAndDelete(firstTmp, localGz);
        acc.chunkCount++;
        return;
    } catch (e) {
        console.error(`[db-sync] ${p.table}: single-shot dump still incomplete after retries - falling back to id-bisected pieces...`);
    }

    if (full) {
        acc.fileIdx++;
        const schemaTmp = path.join(chunkDir, `${p.table}_${acc.fileIdx}_${stamp}.sql.gz`);
        await downloadVerified(cfg, buildRemoteDumpCmdFor(cfg, p.table, '1=0', true), schemaTmp, `dump ${p.table} schema`);
        await appendAndDelete(schemaTmp, localGz);
    }

    await downloadWithBisection({
        cfg, dbName: cfg.DB_NAME,
        buildCmd: where => buildRemoteDumpCmdFor(cfg, p.table, where, false),
        table: p.table, baseWhere: p.where, minId: undefined, maxId: undefined,
        plannedRows: 0, chunkDir, stamp, outPath: localGz, acc, label: `dump ${p.table}`,
    });
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
        const localGz = path.join('backups', 'sync', `${p.table}_${stamp}.sql.gz`);
        // Verified (retried, trailer-checked, id-bisected on persistent
        // failure) before anything local is touched - an incomplete dump
        // throws here, aborting the whole pull BEFORE the windowed delete
        // or import for this table ever runs.
        await pullTableData(cfg, p, path.join('backups', 'sync'), stamp, localGz);
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

// ---- backup (Round 1: chunked + completeness-verified, 2026-08-19) --------
// A single mariadb-dump invocation covering a whole DB is exactly the shape
// the host was found killing (verified live: a killed connection truncated
// a whole-DB dump mid-INSERT inside `matches`, zero `odds_markets` rows,
// while `gzip -t` still passed). Fix: dump schema once (--no-data, fast,
// whole DB), then per table with a numeric `id` primary key and more than
// BACKUP_CHUNK_SIZE rows, dump data in bounded PK-range chunks - every
// individual remote query now stays short enough to finish before whatever
// killed the old one-shot dump. Everything (schema + every chunk) is
// downloaded to its own temp file, verified via the completeness trailer,
// retried up to MAX_DUMP_ATTEMPTS on failure, then appended onto ONE output
// gz file (valid gzip concatenation - `gzip -dc` restores it as one
// continuous stream, same as a normal dump). No --compact (keeps
// mariadb-dump's own native trailer, the whole point of not needing our own
// echo marker for this command).

const NUMERIC_ID_TYPES = new Set(['int', 'bigint', 'mediumint', 'smallint', 'tinyint']);

function sqlLit(s) {
    return `'${String(s).replace(/'/g, "''")}'`;
}

function listRemoteTables(cfg, dbName) {
    const rows = remoteQueryRaw(cfg, dbName,
        `SELECT TABLE_NAME FROM information_schema.tables WHERE table_schema = ${sqlLit(dbName)} AND table_type = 'BASE TABLE' ORDER BY TABLE_NAME;`);
    return rows.map(r => r[0]).filter(Boolean);
}

// Profile EVERY table in the DB in a small, FIXED number of round trips
// (not one-plus-per-table) - each `ssh` invocation pays real connection
// setup latency with no multiplexing, so a naive per-table loop (PK check +
// count + min/max, 3 round trips x N tables) was measured live taking
// minutes just to PLAN a 25-table backup, before a single byte of data
// moved. Batches: (1) PK shape for all tables in one information_schema
// query, (2) an exact row count for every table via one UNION ALL query,
// (3) MIN/MAX(id) via one more UNION ALL, but ONLY for tables that turned
// out to have a single numeric `id` primary key (the chunking candidates) -
// COUNT/MIN/MAX are cheap to compute server-side even on a multi-million-
// row table (they return a few numbers, not bulk data), so batching them
// doesn't reintroduce the "long remote query" problem this whole fix is
// about - that risk is specific to DATA transfer, not aggregate reads.
function profileRemoteDatabase(cfg, dbName, tables) {
    if (!tables.length) return [];
    const inList = tables.map(sqlLit).join(', ');

    const pkRows = remoteQueryRaw(cfg, dbName,
        `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE FROM information_schema.columns`
        + ` WHERE table_schema = ${sqlLit(dbName)} AND column_key = 'PRI' AND table_name IN (${inList});`);
    const pkByTable = new Map();
    for (const [t, col, type] of pkRows) {
        if (!pkByTable.has(t)) pkByTable.set(t, []);
        pkByTable.get(t).push({ col, type });
    }
    const isNumericIdPk = t => {
        const pk = pkByTable.get(t) || [];
        return pk.length === 1 && pk[0].col === 'id' && NUMERIC_ID_TYPES.has(pk[0].type);
    };

    const countSql = tables.map(t => `SELECT ${sqlLit(t)} AS tbl, COUNT(*) AS n FROM \`${t}\``).join(' UNION ALL ');
    const countRows = remoteQueryRaw(cfg, dbName, `${countSql};`);
    const countByTable = new Map(countRows.map(([t, n]) => [t, Number(n) || 0]));

    const idCandidates = tables.filter(isNumericIdPk);
    const minMaxByTable = new Map();
    if (idCandidates.length) {
        const mmSql = idCandidates.map(t => `SELECT ${sqlLit(t)} AS tbl, MIN(\`id\`) AS mn, MAX(\`id\`) AS mx FROM \`${t}\``).join(' UNION ALL ');
        const mmRows = remoteQueryRaw(cfg, dbName, `${mmSql};`);
        for (const [t, mn, mx] of mmRows) minMaxByTable.set(t, { minId: mn != null ? Number(mn) : null, maxId: mx != null ? Number(mx) : null });
    }

    return tables.map(t => {
        const mm = minMaxByTable.get(t) || { minId: null, maxId: null };
        return { table: t, count: countByTable.get(t) || 0, isNumericIdPk: isNumericIdPk(t), minId: mm.minId, maxId: mm.maxId };
    });
}

function schemaOnlyDumpCmd(cfg, dbName) {
    const args = ['--single-transaction', '--quick', '--no-tablespaces', '--default-character-set=utf8mb4',
        '--no-data', '--routines', '--triggers', '--events', dbName];
    const dumpCmd = `${cfg.MYSQL_ENV} mariadb-dump -u ${cfg.DB_USER} ${args.map(shQuote).join(' ')}`;
    return wrapPipefail(`${dumpCmd} | gzip -9`);
}

function tableDataDumpCmd(cfg, dbName, table, where) {
    const args = ['--single-transaction', '--quick', '--no-tablespaces', '--default-character-set=utf8mb4', '--no-create-info'];
    if (where) args.push(`--where=${where}`);
    args.push(dbName, table);
    const dumpCmd = `${cfg.MYSQL_ENV} mariadb-dump -u ${cfg.DB_USER} ${args.map(shQuote).join(' ')}`;
    return wrapPipefail(`${dumpCmd} | gzip -9`);
}

// Each planned chunk carries its numeric id bounds (from/to, to EXCLUSIVE)
// alongside the WHERE clause to actually dump with - the bounds are what
// make the adaptive bisection fallback below possible even for a table that
// was never initially chunked (see downloadRangeRecursive's comment: a
// modest row count can still be too many BYTES to survive one connection
// when rows carry large blobs, and BACKUP_CHUNK_SIZE alone can't see that
// coming). from/to are null only for a table with no numeric id PK at all -
// such a table can never be bisected, a persistent failure on it is
// genuinely unrecoverable by this script.
function planTableChunks(profile) {
    if (profile.isNumericIdPk && profile.count > BACKUP_CHUNK_SIZE) {
        return planIdChunks({ minId: profile.minId, maxId: profile.maxId, chunkSize: BACKUP_CHUNK_SIZE })
            .map(c => ({ from: c.from, to: c.to, where: `id >= ${c.from} AND id < ${c.to}` }));
    }
    return [{
        from: profile.isNumericIdPk ? profile.minId : null,
        to: profile.isNumericIdPk && profile.maxId != null ? profile.maxId + 1 : null,
        where: null, // whole table, no WHERE - matches the original single-call shape
    }];
}

// Chunking by ID RANGE (not row count) can produce far more chunks than
// "rows / CHUNK_SIZE" suggests when a table's id sequence has grown well
// past its current row count (odds_markets churns via delete+insert on
// every odds refresh - src/db/odds-diff.js - so its id space is much
// sparser than its row count). Live-measured: a 4.9M-row table produced 509
// id-range chunks. The completeness check needs an exact planned row count
// PER CHUNK, but querying that one chunk at a time would be 509 more round
// trips just for pre-flight counting - batched here into UNION ALL groups
// (COUNT is cheap even summed across a batch; this is aggregate reads, not
// the bulk data transfer this whole fix is about).
function batchedChunkCounts(cfg, dbName, table, wheres, batchSize = 100) {
    const counts = new Array(wheres.length).fill(0);
    for (let start = 0; start < wheres.length; start += batchSize) {
        const batch = wheres.slice(start, start + batchSize);
        const sql = batch.map((w, i) => `SELECT ${start + i} AS idx, COUNT(*) AS n FROM \`${table}\` WHERE ${w}`).join(' UNION ALL ');
        const rows = remoteQueryRaw(cfg, dbName, `${sql};`);
        for (const [idxStr, n] of rows) counts[Number(idxStr)] = Number(n) || 0;
    }
    return counts;
}

// Download one range's data via buildCmd(where); on a completeness failure
// that survives all of downloadVerified's retries, BISECT the id range and
// recurse into each half instead of giving up - live-verified this is
// necessary for BOTH callers, not theoretical:
//   - backup: `matches` in oddsprok_prod is only 26,670 rows (nowhere near
//     BACKUP_CHUNK_SIZE) but carries a ~39 KB metadata blob per row, and
//     every one of 3 flat retries of the WHOLE table died at the same
//     ~20-30 MB / ~25-30 s mark.
//   - pull: `odds_markets`'s normal WINDOWED dump (no chunking at all in
//     the pre-Round-1 design) died the identical way at row ~2,146,369 -
//     the earlier, unfixed pull almost certainly imported a silently
//     truncated table (confirmed live: local's windowed row count came up
//     ~3M short of remote's for the exact same window predicate).
// Row count alone can't predict byte volume; bisection adapts to whatever
// the actual limit turns out to be without having to know it in advance.
// `baseWhere` is an optional predicate every id-range clause gets ANDed
// onto (backup passes null - id ranges ARE the whole predicate; pull passes
// its table's normal window/full WHERE, which the SQL-level id bisection is
// layered on top of ANDed together, so the two constraints compose
// correctly - fixtures/kickoff windows etc. stay honored even mid-bisect).
// Bottoms out (rethrows) when the range can't be split further (a single
// id, or no numeric id PK to bisect on at all) - a genuine, unrecoverable
// failure, reported as such rather than silently accepted.
function andWhere(base, clause) {
    return base ? `(${base}) AND (${clause})` : clause;
}

async function downloadWithBisection({ cfg, dbName, buildCmd, table, baseWhere, minId, maxId, plannedRows, chunkDir, stamp, outPath, acc, label }) {
    acc.fileIdx++;
    const tmpPath = path.join(chunkDir, `${table}_${acc.fileIdx}_${stamp}.sql.gz`);
    try {
        await downloadVerified(cfg, buildCmd(baseWhere), tmpPath, label);
    } catch (e) {
        // minId/maxId undefined (not null) means "not yet looked up" - the
        // caller didn't already know the table's id bounds (pull's per-
        // table calls: no point paying a MIN/MAX round trip on the common,
        // successful path just in case a bisection fallback is never
        // needed). Discovered lazily, ONLY on an actual failure, over the
        // table's WHOLE id range (unscoped by any window) - safe even when
        // baseWhere narrows further, since AND-ing an outer id range never
        // excludes a row the inner window predicate would otherwise keep.
        if (minId === undefined || maxId === undefined) {
            const mm = remoteQueryRaw(cfg, dbName, `SELECT MIN(\`id\`), MAX(\`id\`) FROM \`${table}\`;`);
            minId = mm[0]?.[0] != null ? Number(mm[0][0]) : null;
            maxId = mm[0]?.[1] != null ? Number(mm[0][1]) + 1 : null;
        }
        if (minId == null || maxId == null || maxId - minId <= 1) throw e;
        const mid = minId + Math.floor((maxId - minId) / 2);
        console.error(`[db-sync] ${label} still incomplete after retries - bisecting id range [${minId},${maxId}) at ${mid} and retrying each half...`);
        const leftIdClause = `id >= ${minId} AND id < ${mid}`;
        const rightIdClause = `id >= ${mid} AND id < ${maxId}`;
        // ANDing onto the already-narrowed baseWhere (not a separately
        // tracked "root" predicate) is deliberate: at deeper bisection
        // levels the clause grows a redundant-but-harmless extra `id >= ..
        // AND id < ..` term each level - correct, just verbose, and
        // bisection is a rare fallback so the extra SQL text costs nothing
        // that matters.
        const leftWhere = andWhere(baseWhere, leftIdClause);
        const rightWhere = andWhere(baseWhere, rightIdClause);
        const leftCount = Number((remoteQueryRaw(cfg, dbName, `SELECT COUNT(*) FROM \`${table}\` WHERE ${leftWhere};`)[0] || [0])[0]) || 0;
        const rightCount = Number((remoteQueryRaw(cfg, dbName, `SELECT COUNT(*) FROM \`${table}\` WHERE ${rightWhere};`)[0] || [0])[0]) || 0;
        await downloadWithBisection({ cfg, dbName, buildCmd, table, baseWhere: leftWhere, minId, maxId: mid, plannedRows: leftCount, chunkDir, stamp, outPath, acc, label: `${table} id[${minId},${mid})` });
        await downloadWithBisection({ cfg, dbName, buildCmd, table, baseWhere: rightWhere, minId: mid, maxId, plannedRows: rightCount, chunkDir, stamp, outPath, acc, label: `${table} id[${mid},${maxId})` });
        return;
    }
    acc.plannedTotal += plannedRows;
    acc.chunkCount++;
    await appendAndDelete(tmpPath, outPath);
}

async function cmdBackup(flags) {
    const cfg = getCfg();
    const name = flags['remote-db'];
    if (!name) die('backup requires --remote-db <name>.');
    if (!/^[A-Za-z0-9_]+$/.test(name)) die(`--remote-db "${name}" must be letters/digits/underscore only.`);

    console.log(`[db-sync] backup ${cfg.SSH_TARGET}:${name} - enumerating tables...`);
    const tables = listRemoteTables(cfg, name);
    if (!tables.length) die(`no base tables found in remote DB "${name}" (typo, or it genuinely has none).`);

    console.log(`[db-sync] profiling ${tables.length} table(s) (row counts + PK shape, batched)...`);
    const profiles = profileRemoteDatabase(cfg, name, tables);
    const plan = profiles.map(p => ({ ...p, chunkWheres: planTableChunks(p) }));

    const totalChunks = plan.reduce((n, p) => n + p.chunkWheres.length, 0);
    console.log(`[db-sync] plan: schema pass + ${totalChunks} data chunk(s) across ${plan.length} table(s):`);
    for (const p of plan) {
        const chunkNote = p.chunkWheres.length > 1 ? `  ${p.chunkWheres.length} chunks (id-ranged, ${BACKUP_CHUNK_SIZE}/chunk)` : '';
        console.log(`  ${p.table.padEnd(28)}${String(p.count).padStart(10)} rows${chunkNote}`);
    }

    if (flags['dry-run']) {
        console.log('\n[db-sync] dry-run - nothing downloaded (table list/counts above ARE real read-only remote queries; no data transferred).');
        return;
    }

    mkdirSync('backups', { recursive: true });
    const chunkDir = path.join('backups', '.chunks');
    mkdirSync(chunkDir, { recursive: true });
    const stamp = tsStamp();
    const outPath = path.join('backups', `remote_${name}_${stamp}.sql.gz`);
    // A partial file left under its final name (mid-write, on a fatal
    // abort) could be mistaken for a real backup - anything that touches
    // outPath from here happens inside the try below, whose catch renames
    // it to an unmistakable .partial suffix before rethrowing.
    writeFileSync(outPath, Buffer.alloc(0));

    let bytes, secs, completeness;
    try {
        const t0 = Date.now();
        console.log('\n[db-sync] schema pass (--no-data, whole DB, once)...');
        const schemaTmp = path.join(chunkDir, `schema_${stamp}.sql.gz`);
        await downloadVerified(cfg, schemaOnlyDumpCmd(cfg, name), schemaTmp, 'schema');
        await appendAndDelete(schemaTmp, outPath);
        console.log(`[db-sync] schema pass OK (${fmtMB(statSync(outPath).size)} so far).`);

        completeness = [];
        for (const p of plan) {
            const tStart = Date.now();
            // One batched pass computes every ORIGINAL chunk's planned row
            // count up front (a handful of round trips even at hundreds of
            // chunks - see batchedChunkCounts). A chunk that later needs
            // bisecting recomputes its own two halves' counts on the spot
            // (downloadWithBisection) - rare, since it only happens after
            // repeated failures.
            const wheres = p.chunkWheres.map(c => c.where);
            const plannedRowsPerChunk = wheres.length === 1 && wheres[0] === null
                ? [p.count]
                : batchedChunkCounts(cfg, name, p.table, wheres);

            const acc = { plannedTotal: 0, chunkCount: 0, fileIdx: 0 };
            let idx = 0;
            for (const chunk of p.chunkWheres) {
                idx++;
                if (p.chunkWheres.length > 1 && idx % 25 === 0) {
                    console.log(`[db-sync]   ${p.table}: ${idx}/${p.chunkWheres.length} planned chunks reached...`);
                }
                const label = p.chunkWheres.length > 1 ? `${p.table} chunk ${idx}/${p.chunkWheres.length}` : p.table;
                await downloadWithBisection({
                    cfg, dbName: name, buildCmd: where => tableDataDumpCmd(cfg, name, p.table, where),
                    table: p.table, baseWhere: chunk.where, minId: chunk.from, maxId: chunk.to,
                    plannedRows: plannedRowsPerChunk[idx - 1], chunkDir, stamp, outPath, acc, label,
                });
            }
            const finalRows = Number((remoteQueryRaw(cfg, name, `SELECT COUNT(*) FROM \`${p.table}\`;`)[0] || [0])[0]) || 0;
            const secsT = (Date.now() - tStart) / 1000;
            const match = acc.plannedTotal === finalRows;
            completeness.push({ table: p.table, chunks: acc.chunkCount, plannedTotal: acc.plannedTotal, finalRows, match });
            const bisectNote = acc.chunkCount !== p.chunkWheres.length ? ` (bisected from ${p.chunkWheres.length} planned)` : '';
            console.log(`[db-sync] ${p.table}: ${acc.plannedTotal} rows, ${acc.chunkCount} chunk(s)${bisectNote}, ${secsT.toFixed(1)}s, ${fmtMB(statSync(outPath).size)} cumulative`
                + (match ? '' : `  MISMATCH (final COUNT(*) = ${finalRows})`));
        }

        bytes = statSync(outPath).size;
        secs = (Date.now() - t0) / 1000;
    } catch (e) {
        const partialPath = `${outPath}.partial`;
        try { renameSync(outPath, partialPath); } catch { /* best effort */ }
        die(`backup aborted: ${e.message}\n  Partial data (if any) kept at ${partialPath} for forensics - it is NOT a usable backup.`);
    }

    console.log('\n[db-sync] completeness check (planned chunk-sum vs a final remote COUNT(*), per table):');
    console.log(`  ${'table'.padEnd(28)}${'chunks'.padStart(7)}${'planned'.padStart(10)}${'final'.padStart(10)}  match`);
    let anyMismatch = false;
    for (const c of completeness) {
        if (!c.match) anyMismatch = true;
        console.log(`  ${c.table.padEnd(28)}${String(c.chunks).padStart(7)}${String(c.plannedTotal).padStart(10)}${String(c.finalRows).padStart(10)}  ${c.match ? 'OK' : 'MISMATCH'}`);
    }

    console.log(`\n[db-sync] backup done: ${outPath} (${fmtMB(bytes)}, ${secs.toFixed(1)}s).`);
    if (anyMismatch) die('one or more tables failed the completeness check (see above) - this backup is NOT trustworthy, investigate before relying on it.');
    console.log('[db-sync] all tables verified complete.');
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
