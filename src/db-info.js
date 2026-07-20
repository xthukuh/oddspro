// M10: read-only DB observability for the admin Database section - thin knex
// orchestration, same split as every other <thing>-rules.js + src/<thing>.js
// pair (delegate anything computable to pure rules, keep this file a loader).
// This is new territory for the codebase: nothing else queries
// information_schema or knex_migrations, so both reads go through db.raw().
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { db } from './db/connection.js';
import { migrationStatus } from './db/migrate-rules.js';
import { config } from './config.js';

// Matches knexfile.js's `migrations.directory: './src/db/migrations'` - both
// resolve relative to the process cwd (the repo root), the same cwd-relative
// convention the rest of the codebase uses for on-disk paths (auto-refresh.js
// -> 'logs', export.js -> 'tmp', server.js -> 'web/dist').
const MIGRATIONS_DIR = path.join('src', 'db', 'migrations');

// GET /api/admin/db/overview - server version, per-table sizes, migration
// status, knex pool gauges. Modelled on performanceSummary() (src/hotpicks.js)
// - one loader, delegates the migration-status computation to Task 1's pure
// migrationStatus().
export async function dbOverview() {
    const [[verRow]] = await db.raw('SELECT VERSION() AS version');

    // TABLE_ROWS is an INNODB ENGINE ESTIMATE, not an exact count (it can be
    // stale until the next ANALYZE TABLE) - the field is named rows_estimate
    // throughout so the UI can never imply a precision the value doesn't have.
    // TABLE_TYPE = 'BASE TABLE' excludes views (none exist today, but a future
    // one would otherwise show up with garbage NULL size/row figures here).
    const [tableRows] = await db.raw(
        `SELECT TABLE_NAME AS name, TABLE_ROWS AS rows_estimate, DATA_LENGTH AS data_bytes,
                INDEX_LENGTH AS index_bytes, (DATA_LENGTH + INDEX_LENGTH) AS total_bytes
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY total_bytes DESC`
    );
    const tables = tableRows.map(r => ({
        name: r.name,
        rows_estimate: Number(r.rows_estimate) || 0,
        data_bytes: Number(r.data_bytes) || 0,
        index_bytes: Number(r.index_bytes) || 0,
        total_bytes: Number(r.total_bytes) || 0,
    }));
    const totals = tables.reduce((acc, t) => {
        acc.data_bytes += t.data_bytes;
        acc.index_bytes += t.index_bytes;
        acc.total_bytes += t.total_bytes;
        return acc;
    }, { tables: tables.length, data_bytes: 0, index_bytes: 0, total_bytes: 0 });

    // Applied names ordered by insertion (batch order); migrationStatus sorts
    // its own copy for `head`, so row order here doesn't need to be perfect.
    const appliedRows = await db('knex_migrations').select('name').orderBy('id');
    const appliedNames = appliedRows.map(r => r.name);
    const diskFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.js'));
    const migrations = migrationStatus(appliedNames, diskFiles);

    return {
        database: config.DB_DATABASE,
        server_version: verRow?.version ?? null,
        tables,
        totals,
        migrations,
        // Pool internals are not a stable public knex contract - guard every
        // gauge with optional chaining so a future knex version that renames
        // or drops one of these degrades to null instead of throwing.
        pool: {
            used: db.client.pool?.numUsed?.() ?? null,
            free: db.client.pool?.numFree?.() ?? null,
            pending_acquires: db.client.pool?.numPendingAcquires?.() ?? null,
        },
    };
}

// GET /api/admin/db/health - SELECT 1 latency + SHOW GLOBAL STATUS uptime/
// connections. Never throws: a health endpoint that 500s tells the admin less
// than one that reports the failure, so any error resolves to {ok:false,
// error, checked_at} instead of propagating.
export async function dbHealth() {
    const checked_at = new Date().toISOString();
    try {
        const t0 = Date.now();
        await db.raw('SELECT 1');
        const latency_ms = Date.now() - t0;

        const [statusRows] = await db.raw(
            "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected')"
        );
        const stat = Object.fromEntries(statusRows.map(r => [r.Variable_name, r.Value]));

        return {
            ok: true,
            latency_ms,
            uptime_s: stat.Uptime != null ? Number(stat.Uptime) : null,
            threads_connected: stat.Threads_connected != null ? Number(stat.Threads_connected) : null,
            checked_at,
        };
    } catch (e) {
        return { ok: false, error: e?.message ?? String(e), checked_at };
    }
}
