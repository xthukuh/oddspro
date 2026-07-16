import test from 'node:test';
import assert from 'node:assert/strict';

import { makeJsonCache } from '../src/http-cache.js';

// makeJsonCache orchestration (node built-ins + pure cache-rules only - runs
// offline). A5: warm(key, loader) pre-computes a slot after a data_version
// bump so the first USER request never pays the cold compute (the
// /api/columns catalog costs ~2s cold).

// Minimal express req/res stand-ins for writeResponse.
const fakeReq = () => ({ get: () => undefined, acceptsEncodings: () => false });
const fakeRes = () => {
    const res = {
        headers: {}, statusCode: 200, body: null,
        set(k, v) { res.headers[k] = v; return res; },
        status(c) { res.statusCode = c; return res; },
        type() { return res; },
        end() { return res; },
        send(b) { res.body = b; return res; },
    };
    return res;
};

test('warm precomputes a slot; a following send serves it without recomputing', async () => {
    let computes = 0;
    const cache = makeJsonCache({ version: () => 7 });
    await cache.warm('/api/columns', () => { computes++; return { cols: [1, 2, 3] }; });
    assert.equal(computes, 1);
    const res = fakeRes();
    await cache.send(fakeReq(), res, '/api/columns', () => { computes++; return { cols: 'MUST NOT RECOMPUTE' }; });
    assert.equal(computes, 1, 'send reused the warmed entry');
    assert.deepEqual(JSON.parse(res.body), { cols: [1, 2, 3] });
});

test('warm respects the version: a bumped version re-warms, a same-version warm is a no-op', async () => {
    let ver = 1, computes = 0;
    const cache = makeJsonCache({ version: () => ver });
    await cache.warm('k', () => ++computes);
    await cache.warm('k', () => ++computes);
    assert.equal(computes, 1, 'same version: no recompute');
    ver = 2;
    await cache.warm('k', () => ++computes);
    assert.equal(computes, 2, 'new version: recomputed');
});

test('a failed warm drops the slot so the next request retries', async () => {
    const cache = makeJsonCache({ version: () => 1 });
    await assert.rejects(cache.warm('k', () => { throw new Error('db down'); }));
    const res = fakeRes();
    await cache.send(fakeReq(), res, 'k', () => ({ ok: true }));
    assert.deepEqual(JSON.parse(res.body), { ok: true }, 'slot was not poisoned');
});
