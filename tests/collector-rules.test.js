import test from 'node:test';
import assert from 'node:assert/strict';
import { listPageOutcome, listPageDone, dataPageOutcome } from '../src/db/collector-rules.js';

// Shapes probed against the live BetPawa API on 2026-08-19.
const withResults = n => ({ responses: [{ responses: Array.from({ length: n }, (_, i) => ({ id: i })) }] });
const noResults = { responses: [{}] };

test('a page carrying events is ok, with its items', () => {
    const o = listPageOutcome(withResults(100));
    assert.equal(o.status, 'ok');
    assert.equal(o.items.length, 100);
});

test('an explicitly empty inner array is ok, not empty-by-omission', () => {
    // Distinct from the {} shape: the API DID answer with a list, it is just
    // zero-length. Both end pagination, but only one is an omission.
    const o = listPageOutcome({ responses: [{ responses: [] }] });
    assert.equal(o.status, 'ok');
    assert.deepEqual(o.items, []);
});

test('the omitted-key shape is the API saying "no results", NOT malformed', () => {
    // This is the regression under test: BetPawa omits `responses` instead of
    // returning [], so every night after the last kickoff - and on any day whose
    // event count is an exact multiple of the page size - the old check reported
    // a malformed body and failed the odds step.
    const o = listPageOutcome(noResults);
    assert.equal(o.status, 'empty');
    assert.deepEqual(o.items, []);
});

test('a genuinely unreadable body stays malformed - the durability fix holds', () => {
    for (const bad of [
        null, undefined, '', 'not json', 42, [],
        {},                                  // no envelope at all
        { responses: null },
        { responses: [] },                   // envelope present but empty
        { responses: 'nope' },
        { responses: [null] },
        { responses: ['string'] },
        { responses: [[]] },                 // array where an object belongs
        { responses: [{ responses: 'nope' }] },
        { responses: [{ responses: null }] },
        { responses: [{ other: 1 }] },       // keys present but no `responses`
    ]) {
        const o = listPageOutcome(bad);
        assert.equal(o.status, 'malformed', `expected malformed for ${JSON.stringify(bad)}`);
        assert.deepEqual(o.items, []);
    }
});

test('listPageDone: an API-reported empty page always ends pagination', () => {
    assert.equal(listPageDone(listPageOutcome(noResults), 100), true);
});

test('listPageDone: a full page continues, a short page ends', () => {
    assert.equal(listPageDone(listPageOutcome(withResults(100)), 100), false);
    assert.equal(listPageDone(listPageOutcome(withResults(76)), 100), true);
    assert.equal(listPageDone(listPageOutcome(withResults(0)), 100), true);
});

test('the exact-multiple case that used to false-alarm now terminates cleanly', () => {
    // 200 events at take=100: two full pages, then the API answers {} and the
    // pager must stop rather than treat it as a broken response.
    const pages = [withResults(100), withResults(100), noResults];
    const seen = [];
    for (const p of pages) {
        const o = listPageOutcome(p);
        assert.notEqual(o.status, 'malformed');
        seen.push(...o.items);
        if (listPageDone(o, 100)) break;
    }
    assert.equal(seen.length, 200);
});

// --- Betika's envelope ------------------------------------------------------
// Probed live 2026-08-19: a page past the end returns HTTP 200 with a REAL
// empty `data: []`, so there is no empty-vs-omitted ambiguity here. The hazard
// is the reverse one: the pager used to coerce ANY unreadable body to an empty
// page, and since it terminates on `len < limit`, a degraded 200 on page 3 of
// 10 returned the first two pages as the complete day.

test('a Betika page with matches is ok', () => {
    const o = dataPageOutcome({ data: [{ match_id: 1 }, { match_id: 2 }], meta: {} });
    assert.equal(o.status, 'ok');
    assert.equal(o.items.length, 2);
});

test('a genuinely empty Betika page is ok and simply ends the walk', () => {
    const o = dataPageOutcome({ data: [], meta: {}, time_elapsed_secs: 0.1 });
    assert.equal(o.status, 'ok');
    assert.deepEqual(o.items, []);
});

test('a body with no data array is malformed, NOT an empty page', () => {
    // This is the regression: each of these used to read as "day complete".
    for (const bad of [
        null, undefined, '', 'gateway timeout', 42, [],
        {}, { data: null }, { data: 'nope' }, { data: {} },
        { error: 'upstream failure' }, { meta: {} },
    ]) {
        const o = dataPageOutcome(bad);
        assert.equal(o.status, 'malformed', `expected malformed for ${JSON.stringify(bad)}`);
        assert.deepEqual(o.items, []);
    }
});

test('dataPageOutcome honours a custom key', () => {
    assert.equal(dataPageOutcome({ rows: [1] }, 'rows').status, 'ok');
    assert.equal(dataPageOutcome({ rows: [1] }, 'data').status, 'malformed');
});

test('a truncated Betika walk can no longer look complete', () => {
    // pages: full, full, then a degraded body. The third must be malformed so
    // the pager retries/throws instead of returning 100 matches as the day.
    const pages = [{ data: new Array(50).fill({}) }, { data: new Array(50).fill({}) }, { error: 'boom' }];
    const collected = [];
    let malformed = false;
    for (const p of pages) {
        const o = dataPageOutcome(p);
        if (o.status === 'malformed') { malformed = true; break; }
        collected.push(...o.items);
        if (o.items.length < 50) break;
    }
    assert.equal(malformed, true, 'the degraded page must be detected');
    assert.equal(collected.length, 100, 'and the partial buffer must NOT be returned as a complete day');
});
