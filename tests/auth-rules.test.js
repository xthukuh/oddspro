// Auth crypto + rules (src/auth-rules.js). node:crypto-backed, offline. Phase 1
// covers PIN hashing (scrypt + salt + pepper, self-describing hash string);
// Phase 3 extends with sessions/lockout/OTP/schemas.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    hashPin, verifyPin, SCRYPT_PARAMS,
    newSessionToken, hashToken, hashOtpCode,
    registerFailedAttempt, isLocked, registerOtpAttempt,
    signupSchema, loginSchema, verifyOtpSchema, changePhoneSchema, profileSchema,
} from '../src/auth-rules.js';

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

// --- Session tokens ---------------------------------------------------------
test('newSessionToken makes an opaque token + its sha256, hashToken is stable', () => {
    let n = 0;
    const rng = () => Buffer.from(String(n++).padEnd(32, 'x'));
    const { token, tokenHash } = newSessionToken(rng);
    assert.equal(typeof token, 'string');
    assert.ok(token.length > 20);
    assert.equal(tokenHash, hashToken(token));           // hash matches
    assert.match(tokenHash, /^[0-9a-f]{64}$/);           // sha256 hex
    assert.notEqual(newSessionToken(rng).token, token);  // fresh each call
});

// --- OTP code hashing -------------------------------------------------------
test('hashOtpCode is deterministic and peppered', () => {
    assert.equal(hashOtpCode('123456', 'pep'), hashOtpCode('123456', 'pep'));
    assert.notEqual(hashOtpCode('123456', 'pep'), hashOtpCode('123456', 'other'));
    assert.notEqual(hashOtpCode('123456', 'pep'), hashOtpCode('654321', 'pep'));
    assert.match(hashOtpCode('123456', ''), /^[0-9a-f]{64}$/);
});

// --- PIN lockout math -------------------------------------------------------
test('registerFailedAttempt locks at the max', () => {
    const now = 1_000_000;
    assert.deepEqual(registerFailedAttempt(0, now, { max: 3, lockoutMs: 900_000 }), { attempts: 1, lockedUntil: null });
    assert.deepEqual(registerFailedAttempt(1, now, { max: 3, lockoutMs: 900_000 }), { attempts: 2, lockedUntil: null });
    assert.deepEqual(registerFailedAttempt(2, now, { max: 3, lockoutMs: 900_000 }), { attempts: 3, lockedUntil: now + 900_000 });
});

test('isLocked reports remaining lock time and clears when expired', () => {
    const now = 5_000_000;
    assert.deepEqual(isLocked(null, now), { locked: false, retryAfterSeconds: 0 });
    assert.deepEqual(isLocked(now - 1, now), { locked: false, retryAfterSeconds: 0 }); // expired
    const r = isLocked(now + 30_000, now);
    assert.equal(r.locked, true);
    assert.equal(r.retryAfterSeconds, 30);
    assert.equal(isLocked(new Date(now + 10_000), now).retryAfterSeconds, 10); // Date-typed
});

test('registerOtpAttempt exhausts at the max', () => {
    assert.deepEqual(registerOtpAttempt(0, { max: 5 }), { attempts: 1, exhausted: false });
    assert.deepEqual(registerOtpAttempt(4, { max: 5 }), { attempts: 5, exhausted: true });
});

// --- Request schemas --------------------------------------------------------
const validSignup = {
    name: 'Jane Doe', phone: '+254799944004', phone_region: 'KE', phone_code: '254',
    pin: '1234', pin_confirm: '1234',
};
test('signupSchema accepts a valid body and rejects bad ones', () => {
    assert.equal(signupSchema.safeParse(validSignup).success, true);
    assert.equal(signupSchema.safeParse({ ...validSignup, pin_confirm: '9999' }).success, false); // mismatch
    assert.equal(signupSchema.safeParse({ ...validSignup, pin: '12' }).success, false);           // short PIN
    assert.equal(signupSchema.safeParse({ ...validSignup, phone: '0799944004' }).success, false); // not E.164
    assert.equal(signupSchema.safeParse({ ...validSignup, name: '' }).success, false);
});

test('login / verify-otp / change-phone / profile schemas', () => {
    assert.equal(loginSchema.safeParse({ phone: '+254799944004', pin: '1234' }).success, true);
    assert.equal(loginSchema.safeParse({ phone: '+254799944004', pin: 'abcd' }).success, false);
    assert.equal(verifyOtpSchema.safeParse({ code: '123456' }).success, true);
    assert.equal(verifyOtpSchema.safeParse({ code: 'ab' }).success, false);
    assert.equal(changePhoneSchema.safeParse({ phone: '+254711111111', phone_region: 'KE', phone_code: '254' }).success, true);
    // profile: changing the PIN requires the current PIN
    assert.equal(profileSchema.safeParse({ name: 'New Name' }).success, true);
    assert.equal(profileSchema.safeParse({ pin: '5678', current_pin: '1234' }).success, true);
    assert.equal(profileSchema.safeParse({ pin: '5678' }).success, false); // no current_pin
});
