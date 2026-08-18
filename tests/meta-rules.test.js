// Pure meta-value rules (src/db/meta-rules.js): JSON codec + version bump math
// for the cross-instance `meta` key/value table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetaValue, nextVersion } from '../src/db/meta-rules.js';

test('parseMetaValue decodes JSON', () => {
    assert.deepEqual(parseMetaValue('{"a":1}'), { a: 1 });
    assert.equal(parseMetaValue('"hello"'), 'hello');
    assert.equal(parseMetaValue('42'), 42);
});

test('parseMetaValue is null-safe', () => {
    assert.equal(parseMetaValue(null), null);
    assert.equal(parseMetaValue(undefined), null);
});

test('parseMetaValue returns null on garbage rather than throwing', () => {
    assert.equal(parseMetaValue('{'), null);
    assert.equal(parseMetaValue('not json'), null);
});

test('nextVersion increments a finite number', () => {
    assert.equal(nextVersion(3), 4);
    assert.equal(nextVersion(0), 1);
});

test('nextVersion resets to 1 for anything non-finite', () => {
    assert.equal(nextVersion(null), 1);
    assert.equal(nextVersion(undefined), 1);
    assert.equal(nextVersion(NaN), 1);
});
