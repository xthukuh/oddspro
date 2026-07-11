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
