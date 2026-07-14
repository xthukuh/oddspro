// Auth crypto + rules (src/auth-rules.js). node:crypto-backed, offline. Phase 1
// covers PIN hashing (scrypt + salt + pepper, self-describing hash string);
// Phase 3 extends with sessions/lockout/OTP/schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPin, verifyPin, SCRYPT_PARAMS } from '../src/auth-rules.js';

// Deterministic fake scrypt for fast, injected tests: xor the salt bytes into a
// keylen buffer seeded by the password. Not cryptographic - just stable + salt-
// and password-sensitive so round-trip/mismatch logic is exercised offline.
function fakeScrypt(pw, salt, keylen) {
    const out = Buffer.alloc(keylen);
    const src = Buffer.from(String(pw));
    for (let i = 0; i < keylen; i++) out[i] = (src[i % src.length] ?? 0) ^ salt[i % salt.length] ^ i;
    return out;
}
const opts = salt => ({ salt: Buffer.from(salt), scrypt: fakeScrypt });

test('hashPin emits the self-describing scrypt$N$r$p$salt$dk format', () => {
    const h = hashPin('1234', opts('0123456789abcdef'));
    const parts = h.split('$');
    assert.equal(parts.length, 6);
    assert.equal(parts[0], 'scrypt');
    assert.equal(Number(parts[1]), SCRYPT_PARAMS.N);
    assert.equal(Number(parts[2]), SCRYPT_PARAMS.r);
    assert.equal(Number(parts[3]), SCRYPT_PARAMS.p);
    assert.ok(parts[4].length && parts[5].length); // salt + dk base64
});

test('verifyPin round-trips the correct PIN', () => {
    const h = hashPin('1234', opts('saltsaltsaltsalt'));
    assert.equal(verifyPin('1234', h, { scrypt: fakeScrypt }), true);
});

test('verifyPin rejects a wrong PIN', () => {
    const h = hashPin('1234', opts('saltsaltsaltsalt'));
    assert.equal(verifyPin('0000', h, { scrypt: fakeScrypt }), false);
    assert.equal(verifyPin('12345', h, { scrypt: fakeScrypt }), false);
});

test('the pepper is required to verify (a different pepper fails)', () => {
    const h = hashPin('1234', { ...opts('saltsaltsaltsalt'), pepper: 'server-pepper' });
    assert.equal(verifyPin('1234', h, { scrypt: fakeScrypt, pepper: 'server-pepper' }), true);
    assert.equal(verifyPin('1234', h, { scrypt: fakeScrypt, pepper: 'wrong' }), false);
    assert.equal(verifyPin('1234', h, { scrypt: fakeScrypt }), false); // no pepper
});

test('a random salt makes two hashes of the same PIN differ', () => {
    // Real randomBytes salt (no injected salt) - the encoded strings must differ.
    const a = hashPin('1234', { scrypt: fakeScrypt });
    const b = hashPin('1234', { scrypt: fakeScrypt });
    assert.notEqual(a, b);
    assert.equal(verifyPin('1234', a, { scrypt: fakeScrypt }), true);
    assert.equal(verifyPin('1234', b, { scrypt: fakeScrypt }), true);
});

test('verifyPin returns false on malformed input', () => {
    assert.equal(verifyPin('1234', null, { scrypt: fakeScrypt }), false);
    assert.equal(verifyPin('1234', 'not-a-hash', { scrypt: fakeScrypt }), false);
    assert.equal(verifyPin('1234', 'scrypt$16384$8$1$$', { scrypt: fakeScrypt }), false);
    assert.equal(verifyPin('1234', 'bcrypt$1$2$3$4$5', { scrypt: fakeScrypt }), false);
});

// Real node:crypto scrypt end-to-end (no injection) - proves the default path.
test('real scrypt hashes and verifies', () => {
    const h = hashPin('4821', { pepper: 'p' });
    assert.match(h, /^scrypt\$16384\$8\$1\$/);
    assert.equal(verifyPin('4821', h, { pepper: 'p' }), true);
    assert.equal(verifyPin('4820', h, { pepper: 'p' }), false);
});
