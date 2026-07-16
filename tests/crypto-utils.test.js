// Shared pure crypto helpers (src/crypto-utils.js). Successor to
// tests/human-pow.test.js: the proof-of-work gate was removed 2026-07-16, but
// these two helpers were never PoW-specific and still guard live paths -
// sha256Hex hashes session tokens + OTP codes (src/auth-rules.js), and
// bearerMatches is the machine-bearer/admin gate in src/server.js. The
// bearerMatches cases below are carried over verbatim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sha256Hex, bearerMatches } from '../src/crypto-utils.js';

test('sha256Hex matches node:crypto (incl. unicode + empty)', () => {
    const ref = s => crypto.createHash('sha256').update(s).digest('hex');
    for (const s of ['', 'abc', 'the quick brown fox', 'héllo wörld ⚽', '0'.repeat(1000)]) {
        assert.equal(sha256Hex(s), ref(s));
    }
});

test('sha256Hex stringifies non-string input', () => {
    assert.equal(sha256Hex(123), sha256Hex('123'));
    assert.equal(sha256Hex(null), sha256Hex('null'));
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
