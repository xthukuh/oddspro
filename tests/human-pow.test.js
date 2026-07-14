// Stateless proof-of-work human gate (src/human-pow.js). The server issues an
// HMAC-signed challenge, the client finds a nonce clearing the difficulty, and
// the server re-verifies signature + work + freshness, then mints a check-once
// token. These tests exercise the whole round-trip plus every rejection path -
// no browser, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    sha256Hex, leadingZeroBits, issueChallenge, verifyChallenge,
    signHumanToken, verifyHumanToken, bearerMatches,
} from '../src/human-pow.js';

const SECRET = 'test-secret-key';

// Mirror the client's brute-force so tests can produce a valid solution.
function solve(challenge, bits) {
    for (let n = 0; n < 5_000_000; n++) {
        if (leadingZeroBits(sha256Hex(`${challenge}:${n}`)) >= bits) return String(n);
    }
    throw new Error('no solution found');
}

test('leadingZeroBits counts zero bits across nibble boundaries', () => {
    assert.equal(leadingZeroBits('00ff'), 8);
    assert.equal(leadingZeroBits('0fff'), 4);
    assert.equal(leadingZeroBits('08ff'), 4);   // 0000 1000 -> 4
    assert.equal(leadingZeroBits('1abc'), 3);   // 0001 -> 3
    assert.equal(leadingZeroBits('ffff'), 0);
    assert.equal(leadingZeroBits('0000'), 16);
});

test('issueChallenge -> solve -> verifyChallenge round-trips', () => {
    const ch = issueChallenge(SECRET, { bits: 10, ttlMs: 60_000, nonce: 'abc123' });
    assert.equal(ch.challenge, 'abc123');
    assert.equal(ch.bits, 10);
    const nonce = solve(ch.challenge, ch.bits);
    const res = verifyChallenge(SECRET, { ...ch, nonce });
    assert.deepEqual(res, { ok: true, reason: 'ok' });
});

test('verifyChallenge rejects a tampered difficulty (breaks the signature)', () => {
    const ch = issueChallenge(SECRET, { bits: 10, ttlMs: 60_000, nonce: 'abc123' });
    const nonce = solve(ch.challenge, 4); // easy nonce, but claim lower bits
    const res = verifyChallenge(SECRET, { ...ch, bits: 4, nonce });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'bad-signature');
});

test('verifyChallenge rejects a forged/wrong-secret signature', () => {
    const ch = issueChallenge(SECRET, { bits: 8, ttlMs: 60_000, nonce: 'zz' });
    const nonce = solve(ch.challenge, ch.bits);
    assert.equal(verifyChallenge('other-secret', { ...ch, nonce }).reason, 'bad-signature');
});

test('verifyChallenge rejects an expired challenge', () => {
    const now = 1_000_000;
    const ch = issueChallenge(SECRET, { bits: 6, ttlMs: 1000, now, nonce: 'exp' });
    const nonce = solve(ch.challenge, ch.bits);
    const res = verifyChallenge(SECRET, { ...ch, nonce }, { now: now + 2000 });
    assert.equal(res.reason, 'expired');
});

test('verifyChallenge rejects insufficient work', () => {
    const ch = issueChallenge(SECRET, { bits: 24, ttlMs: 60_000, nonce: 'hard' });
    const res = verifyChallenge(SECRET, { ...ch, nonce: '0' }); // nonce 0 won't clear 24 bits
    assert.equal(res.reason, 'insufficient-work');
});

test('verifyChallenge rejects malformed submissions', () => {
    assert.equal(verifyChallenge(SECRET, null).reason, 'malformed');
    assert.equal(verifyChallenge(SECRET, { challenge: 'a', bits: 8, exp: 1 }).reason, 'malformed'); // no sig/nonce
});

test('signHumanToken -> verifyHumanToken round-trips and carries the expiry', () => {
    const now = 5_000_000;
    const token = signHumanToken(SECRET, { ttlMs: 7 * 86_400_000, now });
    const res = verifyHumanToken(SECRET, token, { now: now + 1000 });
    assert.equal(res.ok, true);
    assert.equal(res.exp, now + 7 * 86_400_000);
});

test('verifyHumanToken rejects expired, tampered, and wrong-secret tokens', () => {
    const now = 5_000_000;
    const token = signHumanToken(SECRET, { ttlMs: 1000, now });
    assert.equal(verifyHumanToken(SECRET, token, { now: now + 2000 }).reason, 'expired');
    assert.equal(verifyHumanToken(SECRET, token + 'x', { now }).reason, 'bad-signature');
    assert.equal(verifyHumanToken('other', token, { now }).reason, 'bad-signature');
    assert.equal(verifyHumanToken(SECRET, 'garbage', { now }).reason, 'malformed');
});

test('bearerMatches recognizes a registered machine bearer (constant-time)', () => {
    const secrets = ['api-token-1', 'admin-token-2'];
    assert.equal(bearerMatches('Bearer api-token-1', secrets), true);
    assert.equal(bearerMatches('Bearer admin-token-2', secrets), true);
    assert.equal(bearerMatches('Bearer wrong', secrets), false);
    assert.equal(bearerMatches('Bearer api-token-1x', secrets), false);   // length-extended
    assert.equal(bearerMatches('bearer api-token-1', secrets), false);    // scheme is case-exact like the existing gates
    assert.equal(bearerMatches('Basic api-token-1', secrets), false);     // wrong scheme
    assert.equal(bearerMatches('api-token-1', secrets), false);           // no scheme
    assert.equal(bearerMatches('', secrets), false);
    assert.equal(bearerMatches(null, secrets), false);
    assert.equal(bearerMatches(undefined, secrets), false);
});

test('bearerMatches ignores unset/empty secrets (never matches a blank)', () => {
    assert.equal(bearerMatches('Bearer ', ['']), false);        // empty bearer vs empty secret
    assert.equal(bearerMatches('Bearer x', [undefined, null, '']), false);
    assert.equal(bearerMatches('Bearer x', []), false);
    assert.equal(bearerMatches('Bearer x', [undefined, 'x']), true); // unset slots are skipped, real ones match
});
