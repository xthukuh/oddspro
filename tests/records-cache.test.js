// Pure client-side records cache (web/src/recordsCache.js): the query-identity
// key and the bounded LRU behind instant date navigation. Offline, no DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    recordsCacheKey, makeLruCache,
    packRecordsCache, unpackRecordsCache, prioritizeEntries, PERSIST_FORMAT, PERSIST_KEY,
} from '../web/src/recordsCache.js';

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

test('makeLruCache entries() snapshots insertion order without touching recency', () => {
    const c = makeLruCache(3);
    c.set('a', 1); c.set('b', 2);
    assert.deepEqual(c.entries(), [{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
    c.set('x', 3); // 'a' must still be the eviction candidate after entries()
    c.set('y', 4);
    assert.equal(c.has('a'), false);
});

// ---- localStorage persistence pack/unpack (the seed behind instant first
// paint on a brand-new visit; DOM glue in recordsPersist.js).

const entry = (key, at, size = 10) => ({ key, at, value: { rows: 'x'.repeat(size) } });

test('pack/unpack round-trips newest entries, oldest-first on the way out', () => {
    const packed = packRecordsCache(
        [entry('new', 3000), entry('mid', 2000), entry('old', 1000)],
        { nowMs: 3000 });
    assert.equal(packed.v, PERSIST_FORMAT);
    const out = unpackRecordsCache(packed, { nowMs: 3000 });
    assert.deepEqual(out.map(e => e.key), ['old', 'mid', 'new']);
    assert.deepEqual(out[2].value, { rows: 'xxxxxxxxxx' });
});

test('packRecordsCache enforces the entry cap and the char budget', () => {
    const capped = packRecordsCache(
        [entry('a', 4), entry('b', 3), entry('c', 2), entry('d', 1)],
        { nowMs: 5, maxEntries: 2 });
    assert.deepEqual(capped.entries.map(e => e.k), ['a', 'b']);
    // An oversized body is SKIPPED so a giant 'all' view cannot crowd out
    // today's - the smaller later entry still makes it in.
    const budgeted = packRecordsCache(
        [entry('huge', 2, 500), entry('small', 1, 10)],
        { nowMs: 5, maxChars: 100 });
    assert.deepEqual(budgeted.entries.map(e => e.k), ['small']);
});

test('unpackRecordsCache drops entries past maxAgeMs', () => {
    const packed = packRecordsCache([entry('fresh', 900), entry('stale', 100)], { nowMs: 1000 });
    const out = unpackRecordsCache(packed, { nowMs: 1000, maxAgeMs: 500 });
    assert.deepEqual(out.map(e => e.key), ['fresh']);
});

test('unpackRecordsCache is total on malformed/foreign envelopes', () => {
    assert.deepEqual(unpackRecordsCache(null, { nowMs: 1 }), []);
    assert.deepEqual(unpackRecordsCache({ v: 999, entries: [entry('a', 1)] }, { nowMs: 1 }), []);
    assert.deepEqual(unpackRecordsCache({ v: PERSIST_FORMAT, entries: 'nope' }, { nowMs: 1 }), []);
    assert.deepEqual(
        unpackRecordsCache({ v: PERSIST_FORMAT, entries: [null, { k: 1 }, { k: 'ok' }] }, { nowMs: 1 }),
        []); // no value / bad key / bad stamp all pruned
});

test('prioritizeEntries fronts the viewed day so the budget cannot drop it', () => {
    const list = [entry('prefetched-neighbour', 3), entry('viewed-today', 2), entry('other', 1)];
    assert.deepEqual(
        prioritizeEntries(list, 'viewed-today').map(e => e.key),
        ['viewed-today', 'prefetched-neighbour', 'other']);
    // Budget regression: neighbour + today both ~equal size, budget fits ONE -
    // the viewed day must be the survivor.
    const packed = packRecordsCache(
        prioritizeEntries([entry('neighbour', 3, 60), entry('today', 2, 60)], 'today'),
        { nowMs: 5, maxChars: 100 });
    assert.deepEqual(packed.entries.map(e => e.k), ['today']);
});

test('prioritizeEntries is total: no/unknown primary is a no-op', () => {
    const list = [entry('a', 2), entry('b', 1)];
    assert.deepEqual(prioritizeEntries(list, null), list);
    assert.deepEqual(prioritizeEntries(list, 'missing').map(e => e.key), ['a', 'b']);
    assert.deepEqual(prioritizeEntries(undefined, 'x'), []);
});

test('PERSIST_KEY stays in the oddspro.* namespace the exclusion lists cover', () => {
    assert.equal(PERSIST_KEY, 'oddspro.recordsCache');
});
