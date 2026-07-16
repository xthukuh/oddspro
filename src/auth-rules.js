// Pure auth crypto + rules (node:crypto + zod, offline-testable). Lives at the
// src/ root next to crypto-utils.js - the convention for crypto-bearing pure
// modules (the zero-import src/db/*-rules.js files are for zod-only math; this
// one needs node:crypto). Shared by the users migration (seeded-admin PIN), the
// auth service (src/auth.js), and its offline tests. No config/DB imports.
//
// v1.1.0 Phase 1 provides PIN hashing; Phase 3 adds session-token minting,
// OTP-code hashing, PIN-lockout + OTP-attempt math, and the request schemas.
import crypto from 'node:crypto';
import { z } from 'zod';
import { isValidE164, _ms } from './db/sms-rules.js'; // pure, offline - no coupling to config/DB
import { sha256Hex } from './crypto-utils.js'; // pure crypto sibling (C1: one sha256 helper)

// scrypt cost parameters. BAKED into every hash string (scrypt$N$r$p$salt$dk),
// so they can be raised later WITHOUT a migration - verifyPin reads them back
// out of the stored hash and re-derives with the same cost. 16384/8/1 needs
// ~16 MB, comfortably under node's 32 MB scrypt maxmem default (we pass 64 MB
// so a future bump has headroom).
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const _encodeHash = ({ N, r, p }, salt, dk) =>
    `scrypt$${N}$${r}$${p}$${Buffer.from(salt).toString('base64')}$${dk.toString('base64')}`;

// Split a stored hash back into cost params + salt + expected key, or null on
// any malformed input (shared by the sync and async verifiers).
function _decodeHash(encoded) {
    if (typeof encoded !== 'string') return null;
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
    const [, N, r, p, saltB64, dkB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(dkB64, 'base64');
    if (!salt.length || !expected.length) return null;
    return { N: Number(N), r: Number(r), p: Number(p), salt, expected };
}

// Promisified crypto.scrypt: the KDF runs on the libuv thread pool instead of
// blocking the single-threaded event loop (E1). Same call shape as scryptSync.
const _scryptAsync = (secret, salt, keylen, opts) => new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, keylen, opts, (err, dk) => (err ? reject(err) : resolve(dk)));
});

// Hash a PIN (or any secret) with scrypt + a random per-hash salt and an
// optional server-wide pepper. Returns a self-describing string:
//   scrypt$<N>$<r>$<p>$<saltBase64>$<derivedKeyBase64>
// `salt`, `scrypt` and `randomBytes` are injectable for deterministic tests.
export function hashPin(pin, {
    pepper = '',
    params = SCRYPT_PARAMS,
    salt = crypto.randomBytes(16),
    scrypt = crypto.scryptSync,
} = {}) {
    const { N, r, p, keylen } = params;
    const dk = Buffer.from(scrypt(String(pin) + pepper, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }));
    return _encodeHash(params, salt, dk);
}

// Verify a PIN against a stored hash. Constant-time on the derived key. Reads
// N/r/p + salt back out of the encoded string so hashes made with older params
// still verify after the cost is raised. Returns false on any malformed input.
export function verifyPin(pin, encoded, { pepper = '', scrypt = crypto.scryptSync } = {}) {
    const d = _decodeHash(encoded);
    if (!d) return false;
    // A corrupted stored hash (non-numeric / invalid cost params) makes scrypt
    // throw - that's still "malformed input", so it must be false, not a 500.
    let dk;
    try {
        dk = Buffer.from(scrypt(String(pin) + pepper, d.salt, d.expected.length, {
            N: d.N, r: d.r, p: d.p, maxmem: SCRYPT_MAXMEM,
        }));
    } catch {
        return false;
    }
    return dk.length === d.expected.length && crypto.timingSafeEqual(dk, d.expected);
}

// Async twins of hashPin/verifyPin for request-path callers (E1): login/signup/
// PIN-change handlers must not stall every other request on a ~16 MB sync KDF.
// Identical hash format both ways - sync- and async-made hashes verify each
// other. The sync pair stays for non-request contexts (the users migration).
export async function hashPinAsync(pin, {
    pepper = '',
    params = SCRYPT_PARAMS,
    salt = crypto.randomBytes(16),
    scrypt = _scryptAsync,
} = {}) {
    const { N, r, p, keylen } = params;
    const dk = Buffer.from(await scrypt(String(pin) + pepper, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }));
    return _encodeHash(params, salt, dk);
}

export async function verifyPinAsync(pin, encoded, { pepper = '', scrypt = _scryptAsync } = {}) {
    const d = _decodeHash(encoded);
    if (!d) return false;
    let dk;
    try {
        dk = Buffer.from(await scrypt(String(pin) + pepper, d.salt, d.expected.length, {
            N: d.N, r: d.r, p: d.p, maxmem: SCRYPT_MAXMEM,
        }));
    } catch {
        return false;
    }
    return dk.length === d.expected.length && crypto.timingSafeEqual(dk, d.expected);
}

// --- Session tokens ---------------------------------------------------------
// Opaque bearer token: a random 32-byte base64url string. Only its sha256 is
// stored (hashToken), so a DB leak yields no usable token. `randomBytes` is
// injectable for tests.
export function newSessionToken(randomBytes = crypto.randomBytes) {
    const token = randomBytes(32).toString('base64url');
    return { token, tokenHash: hashToken(token) };
}
export function hashToken(token) {
    return sha256Hex(token);
}

// --- OTP code hashing -------------------------------------------------------
// Short-lived numeric codes: a peppered sha256 is enough (the TTL + attempt cap
// are the real protections, not hash cost). Never store the plaintext code.
export function hashOtpCode(code, pepper = '') {
    return sha256Hex(String(code) + String(pepper));
}

// --- PIN lockout math (pure) ------------------------------------------------
// After a wrong PIN: increment attempts, and lock once at/over the max.
export function registerFailedAttempt(attempts, nowMs, { max = 5, lockoutMs = 15 * 60_000 } = {}) {
    const next = (attempts || 0) + 1;
    return { attempts: next, lockedUntil: next >= max ? nowMs + lockoutMs : null };
}
export function isLocked(lockedUntil, nowMs) {
    if (lockedUntil == null) return { locked: false, retryAfterSeconds: 0 };
    const until = _ms(lockedUntil);
    if (!Number.isFinite(until) || until <= nowMs) return { locked: false, retryAfterSeconds: 0 };
    return { locked: true, retryAfterSeconds: Math.ceil((until - nowMs) / 1000) };
}

// --- OTP attempt policy (pure) ----------------------------------------------
export function registerOtpAttempt(attempts, { max = 5 } = {}) {
    const next = (attempts || 0) + 1;
    return { attempts: next, exhausted: next >= max };
}

// --- Forced PIN change (pure, H4) --------------------------------------------
// While users.must_change_pin is set (the seeded default-PIN admin), a session
// may only reach: the PIN change itself, logout (always allow leaving), /me
// (the SPA re-discovers the flag from it on reload), and the phone-verify flow
// (PUT profile requires a VERIFIED phone, so blocking verify would dead-end an
// unverified flagged user). Everything else the guards answer 403
// { pin_change_required: true }.
const PIN_CHANGE_EXEMPT = new Set([
    'PUT /api/auth/profile',
    'POST /api/auth/logout',
    'GET /api/auth/me',
    'POST /api/auth/verify-otp',
    'POST /api/auth/resend-otp',
]);
export function mustChangePinBlocks(method, path) {
    return !PIN_CHANGE_EXEMPT.has(`${String(method).toUpperCase()} ${path}`);
}

// --- Request schemas (zod) --------------------------------------------------
const PIN = z.string().regex(/^\d{4}$/, 'PIN must be 4 digits');
const PHONE = z.string().refine(isValidE164, 'Enter a valid phone number');
const REGION = z.string().trim().length(2, 'Invalid region');
const CODE = z.string().trim().min(1).max(8);

export const signupSchema = z.object({
    name: z.string().trim().min(1, 'Name is required').max(120),
    phone: PHONE,
    phone_region: REGION,
    phone_code: CODE,
    pin: PIN,
    pin_confirm: PIN,
}).refine(d => d.pin === d.pin_confirm, { message: 'PINs do not match', path: ['pin_confirm'] });

export const loginSchema = z.object({ phone: PHONE, pin: PIN });
export const verifyOtpSchema = z.object({ code: z.string().trim().regex(/^\d{4,10}$/, 'Enter the code') });
export const changePhoneSchema = z.object({ phone: PHONE, phone_region: REGION, phone_code: CODE });
export const profileSchema = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    pin: PIN.optional(),
    current_pin: PIN.optional(),
}).refine(d => !d.pin || d.current_pin, { message: 'Enter your current PIN to change it', path: ['current_pin'] });
