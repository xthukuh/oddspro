import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveToPosition } from '../web/src/reorder.js';

const keys = arr => arr.map(it => it.key);
const list = ['a', 'b', 'c', 'd'].map(k => ({ key: k }));

test('moveToPosition moves an item down to a later 1-based position', () => {
    assert.deepEqual(keys(moveToPosition(list, 'a', 3)), ['b', 'c', 'a', 'd']);
});

test('moveToPosition moves an item up to an earlier 1-based position', () => {
    assert.deepEqual(keys(moveToPosition(list, 'd', 1)), ['d', 'a', 'b', 'c']);
});

test('moveToPosition to the last position lands the item last', () => {
    assert.deepEqual(keys(moveToPosition(list, 'b', 4)), ['a', 'c', 'd', 'b']);
});

test('moveToPosition clamps positions outside [1, length]', () => {
    assert.deepEqual(keys(moveToPosition(list, 'c', 0)), ['c', 'a', 'b', 'd']); // 0 -> 1
    assert.deepEqual(keys(moveToPosition(list, 'a', 99)), ['b', 'c', 'd', 'a']); // 99 -> length
});

test('moveToPosition rounds a fractional position', () => {
    assert.deepEqual(keys(moveToPosition(list, 'a', 2.9)), ['b', 'c', 'a', 'd']); // 2.9 -> 3
});

test('moveToPosition returns the SAME array reference on a no-op', () => {
    assert.equal(moveToPosition(list, 'a', 1), list); // already first
    assert.equal(moveToPosition(list, 'zzz', 2), list); // unknown key
});

test('moveToPosition does not mutate the input array', () => {
    const before = keys(list);
    moveToPosition(list, 'a', 4);
    assert.deepEqual(keys(list), before);
});
