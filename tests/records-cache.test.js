// Pure client-side records cache (web/src/recordsCache.js): the query-identity
// key and the bounded LRU behind instant date navigation. Offline, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordsCacheKey, makeLruCache } from '../web/src/recordsCache.js';

const base = { date: '2026-08-17', filtersKey: '[]', completed: true, providers: ['betpawa'], token: '' };

test('recordsCacheKey is stable for the same inputs', () => {
    assert.equal(recordsCacheKey(base), recordsCacheKey({ ...base }));
});

test('recordsCacheKey separates dates', () => {
    assert.notEqual(recordsCacheKey(base), recordsCacheKey({ ...base, date: '2026-08-18' }));
});

test('recordsCacheKey separates sessions so a guest body cannot be served to a user', () => {
    assert.notEqual(recordsCacheKey(base), recordsCacheKey({ ...base, token: 'abc' }));
});

test('recordsCacheKey separates filters, completed and providers', () => {
    assert.notEqual(recordsCacheKey(base), recordsCacheKey({ ...base, filtersKey: '[{"k":1}]' }));
    assert.notEqual(recordsCacheKey(base), recordsCacheKey({ ...base, completed: false }));
    assert.notEqual(recordsCacheKey(base), recordsCacheKey({ ...base, providers: ['betika'] }));
});

test('recordsCacheKey does not depend on provider order', () => {
    assert.equal(
        recordsCacheKey({ ...base, providers: ['betpawa', 'betika'] }),
        recordsCacheKey({ ...base, providers: ['betika', 'betpawa'] }),
    );
});

test('recordsCacheKey is total against missing fields', () => {
    assert.equal(typeof recordsCacheKey({}), 'string');
    assert.equal(typeof recordsCacheKey(null), 'string');
    assert.equal(typeof recordsCacheKey({ ...base, providers: null }), 'string');
});

test('makeLruCache stores and reads back', () => {
    const c = makeLruCache(3);
    c.set('a', 1);
    assert.equal(c.get('a'), 1);
    assert.equal(c.has('a'), true);
    assert.equal(c.has('b'), false);
    assert.equal(c.get('b'), undefined);
    assert.equal(c.size(), 1);
});

test('makeLruCache evicts the oldest entry past the cap', () => {
    const c = makeLruCache(2);
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.equal(c.size(), 2);
    assert.equal(c.has('a'), false);
    assert.equal(c.has('b'), true);
    assert.equal(c.has('c'), true);
});

test('makeLruCache treats a read as recent use', () => {
    const c = makeLruCache(2);
    c.set('a', 1); c.set('b', 2);
    c.get('a');           // 'a' is now the most recent, so 'b' is next out
    c.set('c', 3);
    assert.equal(c.has('a'), true);
    assert.equal(c.has('b'), false);
});

test('makeLruCache overwrites in place without growing', () => {
    const c = makeLruCache(2);
    c.set('a', 1); c.set('a', 2);
    assert.equal(c.size(), 1);
    assert.equal(c.get('a'), 2);
});

test('makeLruCache supports delete and clear', () => {
    const c = makeLruCache(3);
    c.set('a', 1); c.set('b', 2);
    c.delete('a');
    assert.equal(c.has('a'), false);
    c.clear();
    assert.equal(c.size(), 0);
});

test('makeLruCache tolerates a silly cap', () => {
    const c = makeLruCache(0);
    c.set('a', 1);
    assert.equal(c.size() <= 1, true);
});
