// Boot-migration guard rules (src/db/migrate-rules.js). The server can self-run
// knex migrate:latest on startup when MIGRATE_ON_BOOT is set - useful on a
// shell-less host (cPanel) where a restart is the only way to apply a migration.
// The guard must stay OFF unless explicitly enabled (a wrong-true would migrate
// a developer's DB on every local `npm run serve`), and the result summary must
// never throw (it only produces a log line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMigrateOnBoot, describeMigrationResult, migrationStatus } from '../src/db/migrate-rules.js';

// shouldMigrateOnBoot: only explicit truthy strings / boolean true enable it.
test('shouldMigrateOnBoot enables on explicit truthy strings', () => {
    for (const v of ['1', 'true', 'yes', 'TRUE', 'Yes', ' 1 ', ' true ']) {
        assert.equal(shouldMigrateOnBoot(v), true, `expected ${JSON.stringify(v)} to enable`);
    }
});

test('shouldMigrateOnBoot enables on boolean true only', () => {
    assert.equal(shouldMigrateOnBoot(true), true);
    assert.equal(shouldMigrateOnBoot(false), false);
});

test('shouldMigrateOnBoot stays OFF for falsy/unset/unknown values (default no-op)', () => {
    for (const v of ['0', 'false', 'no', '', 'off', 'enabled', 'null', 'undefined']) {
        assert.equal(shouldMigrateOnBoot(v), false, `expected ${JSON.stringify(v)} to stay off`);
    }
});

test('shouldMigrateOnBoot stays OFF for non-string, non-boolean inputs', () => {
    for (const v of [undefined, null, 0, 1, {}, [], NaN]) {
        assert.equal(shouldMigrateOnBoot(v), false, `expected ${JSON.stringify(v) ?? String(v)} to stay off`);
    }
});

// describeMigrationResult: summarize knex's [batchNo, log] result.
test('describeMigrationResult reports "up to date" when nothing ran', () => {
    assert.equal(
        describeMigrationResult([12, []]),
        'schema already up to date (no migrations to run)',
    );
});

test('describeMigrationResult lists the applied migrations and batch', () => {
    assert.equal(
        describeMigrationResult([9, ['20260709_add_elapsed.js', '20260711_add_ai_review.js']]),
        'ran 2 migration(s) in batch 9: 20260709_add_elapsed.js, 20260711_add_ai_review.js',
    );
});

test('describeMigrationResult tolerates a malformed/absent result without throwing', () => {
    assert.equal(describeMigrationResult(undefined), 'schema already up to date (no migrations to run)');
    assert.equal(describeMigrationResult(null), 'schema already up to date (no migrations to run)');
    assert.equal(describeMigrationResult([5, null]), 'schema already up to date (no migrations to run)');
});

// migrationStatus: M10 admin DB-overview - head/pending/up_to_date from a DB
// read (applied names) + a directory listing (disk files).
test('migrationStatus reports up_to_date with a null head when nothing has ever run', () => {
    assert.deepEqual(migrationStatus([], []), { head: null, applied: [], pending: [], up_to_date: true });
});

test('migrationStatus picks the lexicographically-newest applied name as head', () => {
    // Migration filenames are timestamp-prefixed, so sort order == chronological
    // order - head must not just be the last array element if the caller handed
    // them out of order.
    const applied = ['20260709000001_a.js', '20260601000001_b.js', '20260715000001_c.js'];
    const r = migrationStatus(applied, applied);
    assert.equal(r.head, '20260715000001_c.js');
    assert.deepEqual(r.applied, applied);
    assert.deepEqual(r.pending, []);
    assert.equal(r.up_to_date, true);
});

test('migrationStatus lists disk files not yet applied as pending, sorted', () => {
    const applied = ['20260601000001_a.js'];
    const disk = ['20260601000001_a.js', '20260715000001_c.js', '20260709000001_b.js'];
    const r = migrationStatus(applied, disk);
    assert.equal(r.head, '20260601000001_a.js');
    assert.deepEqual(r.pending, ['20260709000001_b.js', '20260715000001_c.js']);
    assert.equal(r.up_to_date, false);
});

test('migrationStatus is total against garbage input (never throws)', () => {
    assert.deepEqual(migrationStatus(undefined, undefined), { head: null, applied: [], pending: [], up_to_date: true });
    assert.deepEqual(migrationStatus(null, null), { head: null, applied: [], pending: [], up_to_date: true });
    assert.deepEqual(migrationStatus('nope', 42), { head: null, applied: [], pending: [], up_to_date: true });
    assert.deepEqual(migrationStatus({}, {}), { head: null, applied: [], pending: [], up_to_date: true });
    // Junk entries inside otherwise-valid arrays are filtered rather than
    // crashing the DB-overview page.
    const r = migrationStatus([null, 5, '20260601000001_a.js', undefined], ['20260601000001_a.js', {}]);
    assert.deepEqual(r.applied, ['20260601000001_a.js']);
    assert.deepEqual(r.pending, []);
    assert.equal(r.head, '20260601000001_a.js');
});
