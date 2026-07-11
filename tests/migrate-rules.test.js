// Boot-migration guard rules (src/db/migrate-rules.js). The server can self-run
// knex migrate:latest on startup when MIGRATE_ON_BOOT is set - useful on a
// shell-less host (cPanel) where a restart is the only way to apply a migration.
// The guard must stay OFF unless explicitly enabled (a wrong-true would migrate
// a developer's DB on every local `npm run serve`), and the result summary must
// never throw (it only produces a log line).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMigrateOnBoot, describeMigrationResult } from '../src/db/migrate-rules.js';

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
