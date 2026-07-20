// Pure boot-migration helpers (zero imports so tests skip config/.env).
//
// The server can self-apply pending knex migrations on startup when
// MIGRATE_ON_BOOT is set - useful on a shell-less shared host (cPanel), where
// restarting the Node app is the only way to run a new migration (there is no
// terminal to `npm run migrate`). Default OFF: local/dev restarts must never
// surprise-migrate the developer's database.

// Coerce an env flag (string or boolean) to a boolean. Mirrors config.js's
// explicit boolean parse: only '1'/'true'/'yes' (case-insensitive, trimmed) or
// boolean true enable it; '0'/'false'/'no'/''/undefined stay OFF. (z.coerce
// .boolean would wrongly treat the strings '0' and 'false' as true, so the
// codebase parses these flags by hand - this is the single shared source.)
export function shouldMigrateOnBoot(flag) {
    if (typeof flag === 'boolean') return flag;
    if (typeof flag !== 'string') return false;
    return ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
}

// Summarize knex `migrate.latest()`'s `[batchNo, log]` result into one log
// line. `log` is the list of migration filenames applied (empty when the schema
// was already current). Tolerant of a malformed/absent result (never throws -
// it only produces a log message).
export function describeMigrationResult(result) {
    const [batchNo, log] = Array.isArray(result) ? result : [undefined, []];
    const files = Array.isArray(log) ? log : [];
    if (files.length === 0) return 'schema already up to date (no migrations to run)';
    return `ran ${files.length} migration(s) in batch ${batchNo}: ${files.join(', ')}`;
}

// M10: the admin DB-overview's migration status - `head` (the newest applied
// migration, also the export manifest's `schema_head` compatibility guard),
// `pending` (disk files not yet applied), and `up_to_date`. TOTAL - fed from a
// DB read (knex_migrations) and a directory listing, so a bad/empty/missing
// input must resolve to a well-formed empty result rather than throwing.
//
// Migration filenames are timestamp-prefixed, so a lexicographic sort is a
// chronological sort - `head` is computed from a sorted copy rather than
// trusting the caller's row order.
export function migrationStatus(appliedNames, diskFiles) {
    const applied = Array.isArray(appliedNames) ? appliedNames.filter(n => typeof n === 'string' && n) : [];
    const disk = Array.isArray(diskFiles) ? diskFiles.filter(n => typeof n === 'string' && n) : [];
    const appliedSet = new Set(applied);
    const sortedApplied = [...applied].sort();
    const head = sortedApplied.length ? sortedApplied[sortedApplied.length - 1] : null;
    const pending = disk.filter(f => !appliedSet.has(f)).sort();
    return { head, applied, pending, up_to_date: pending.length === 0 };
}
