// HTTP/server response-cache rules (src/db/cache-rules.js). Pure, offline -
// cache keys, LRU recency/eviction math, freshness (data_version + TTL) and
// If-None-Match entity-tag comparison for the /api/records + /api/columns
// server-side memo (see src/http-cache.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queryCacheKey, lruGet, lruSet, entryFresh, etagMatches } from '../src/db/cache-rules.js';

test('queryCacheKey is stable across param order and drops empty params', () => {
    const a = queryCacheKey('/api/records', { date: '2026-07-15', providers: 'betika', per_page: 'all' });
    const b = queryCacheKey('/api/records', { per_page: 'all', providers: 'betika', date: '2026-07-15' });
    assert.equal(a, b);
    // null/'' params don't fork the key ({} and {x:null} hit the same slot)
    assert.equal(queryCacheKey('/api/columns', {}), queryCacheKey('/api/columns', { x: null, y: '' }));
    // a differing param value DOES fork it
    assert.notEqual(a, queryCacheKey('/api/records', { date: '2026-07-16', providers: 'betika', per_page: 'all' }));
});

test('lruGet refreshes recency; lruSet evicts the least recently used', () => {
    const m = new Map();
    lruSet(m, 'a', 1, 2);
    lruSet(m, 'b', 2, 2);
    assert.equal(lruGet(m, 'a'), 1);      // touch a -> b is now LRU
    lruSet(m, 'c', 3, 2);                 // over cap -> evicts b
    assert.equal(m.has('b'), false);
    assert.equal(m.has('a'), true);
    assert.equal(m.has('c'), true);
    assert.equal(lruGet(m, 'missing'), undefined);
});

test('entryFresh needs the same data_version AND a young age', () => {
    const entry = { version: 4, at: 1_000 };
    assert.equal(entryFresh(entry, 4, 2_000, 60_000), true);
    assert.equal(entryFresh(entry, 5, 2_000, 60_000), false);  // data refreshed since
    assert.equal(entryFresh(entry, 4, 62_000, 60_000), false); // TTL belt (out-of-band writers)
    assert.equal(entryFresh(null, 4, 2_000, 60_000), false);
});

test('etagMatches weak-compares and handles multi-tag headers', () => {
    assert.equal(etagMatches('W/"abc"', 'W/"abc"'), true);
    assert.equal(etagMatches('"abc"', 'W/"abc"'), true);       // weak comparison
    assert.equal(etagMatches('W/"abc", W/"def"', 'W/"def"'), true);
    assert.equal(etagMatches('W/"abc"', 'W/"zzz"'), false);
    assert.equal(etagMatches(undefined, 'W/"abc"'), false);
    assert.equal(etagMatches('W/"abc"', null), false);
});
