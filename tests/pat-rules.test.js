import test from 'node:test';
import assert from 'node:assert/strict';
import { mintPat, isPatToken, hashPatToken, patRouteAllowed } from '../src/pat-rules.js';

test('mintPat: opat_ prefix, base64url body, sha256 hash, 12-char display prefix', () => {
    const p = mintPat();
    assert.match(p.token, /^opat_[A-Za-z0-9_-]{43}$/);      // 32 bytes base64url = 43 chars
    assert.match(p.hash, /^[0-9a-f]{64}$/);
    assert.equal(p.prefix, p.token.slice(0, 12));
    assert.equal(hashPatToken(p.token), p.hash);            // deterministic
    assert.notEqual(mintPat().token, p.token);              // random
});

test('isPatToken discriminates bearer kinds', () => {
    assert.equal(isPatToken('opat_abc'), true);
    assert.equal(isPatToken('sess-token'), false);
    assert.equal(isPatToken(null), false);
    assert.equal(isPatToken(''), false);
});

test('patRouteAllowed: read-only, never admin or auth', () => {
    assert.equal(patRouteAllowed('GET', '/api/records'), true);
    assert.equal(patRouteAllowed('GET', '/api/view'), true);
    assert.equal(patRouteAllowed('GET', '/api/daily-slip/timeline'), true);
    assert.equal(patRouteAllowed('POST', '/api/refresh'), false);           // read-only
    assert.equal(patRouteAllowed('PUT', '/api/prefs'), false);
    assert.equal(patRouteAllowed('DELETE', '/api/admin/pats/1'), false);
    assert.equal(patRouteAllowed('GET', '/api/admin/settings'), false);     // never admin
    assert.equal(patRouteAllowed('GET', '/api/admin'), false);
    assert.equal(patRouteAllowed('GET', '/api/auth/me'), false);            // never auth
    assert.equal(patRouteAllowed('get', '/api/records'), true);             // method case-insensitive
});
