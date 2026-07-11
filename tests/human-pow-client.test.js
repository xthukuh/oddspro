// The browser PoW solver (web/src/humanPow.js) must agree with the server
// (src/human-pow.js), which is the correctness authority. If the client SHA-256
// ever drifts from node:crypto, the gate silently stops accepting solutions -
// so this test pins client == node crypto and does a full client-solve ->
// server-verify round-trip, entirely offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex as clientSha, leadingZeroBits as clientLZB, solveChallenge } from '../web/src/humanPow.js';
import { issueChallenge, verifyChallenge, leadingZeroBits as serverLZB } from '../src/human-pow.js';

const nodeSha = s => crypto.createHash('sha256').update(s).digest('hex');

test('client sha256Hex byte-matches node:crypto (incl. unicode + empty)', () => {
    for (const s of ['', 'a', 'abc', 'challenge:12345', 'the quick brown fox', '⚽️ oddspro café ñ', 'x'.repeat(200)]) {
        assert.equal(clientSha(s), nodeSha(s), `mismatch for ${JSON.stringify(s)}`);
    }
});

test('client and server leadingZeroBits agree', () => {
    for (const h of ['00ff', '0fff', '1abc', 'ffff', '0000', clientSha('abc')]) {
        assert.equal(clientLZB(h), serverLZB(h), `mismatch for ${h}`);
    }
});

test('a client-solved challenge passes the server verifier (round-trip)', async () => {
    const ch = issueChallenge('shared-secret', { bits: 12, ttlMs: 60_000, nonce: 'roundtrip' });
    const nonce = await solveChallenge(ch); // browser does the work
    const res = verifyChallenge('shared-secret', { ...ch, nonce });
    assert.equal(res.ok, true);
    // and the solution genuinely clears the difficulty
    assert.ok(clientLZB(clientSha(`${ch.challenge}:${nonce}`)) >= ch.bits);
});
