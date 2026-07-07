import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilterList } from '../src/db/filter-csv.js';

test('plain comma-separated items', () => {
    assert.deepEqual(parseFilterList('a,b,c'), ['a', 'b', 'c']);
});

test('the spec example: quoted string + bare number', () => {
    assert.deepEqual(parseFilterList('"O 0.5",2.5'), ['O 0.5', '2.5']);
});

test('quoted item keeps embedded commas', () => {
    assert.deepEqual(parseFilterList('a,"b,c",d'), ['a', 'b,c', 'd']);
});

test('doubled quotes are a literal quote inside a quoted item', () => {
    assert.deepEqual(parseFilterList('"He said ""hi"""'), ['He said "hi"']);
});

test('unquoted items are trimmed; quoted items keep inner spaces', () => {
    assert.deepEqual(parseFilterList('  a , b '), ['a', 'b']);
    assert.deepEqual(parseFilterList('" O 2.5 "'), [' O 2.5 ']);
});

test('empty items (leading/trailing/double commas) are dropped', () => {
    assert.deepEqual(parseFilterList(',a,,b,'), ['a', 'b']);
    assert.deepEqual(parseFilterList(''), []);
    assert.deepEqual(parseFilterList('   '), []);
});

test('null/undefined yield an empty list', () => {
    assert.deepEqual(parseFilterList(null), []);
    assert.deepEqual(parseFilterList(undefined), []);
});
