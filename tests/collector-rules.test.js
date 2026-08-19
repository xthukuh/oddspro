import test from 'node:test';
import assert from 'node:assert/strict';
import { listPageOutcome, listPageDone } from '../src/db/collector-rules.js';

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
