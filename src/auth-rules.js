// Pure auth crypto + rules (node:crypto + zod, offline-testable). Lives at the
// src/ root next to human-pow.js - the convention for crypto-bearing pure
// modules (the zero-import src/db/*-rules.js files are for zod-only math; this
// one needs node:crypto). Shared by the users migration (seeded-admin PIN), the
// auth service (src/auth.js), and its offline tests. No config/DB imports.
//
// v1.1.0 Phase 1 provides PIN hashing (below); Phase 3 extends this module with
// session-token minting, lockout math, OTP-code hashing, and request schemas.
import crypto from 'node:crypto';

// scrypt cost parameters. BAKED into every hash string (scrypt$N$r$p$salt$dk),
// so they can be raised later WITHOUT a migration - verifyPin reads them back
// out of the stored hash and re-derives with the same cost. 16384/8/1 needs
// ~16 MB, comfortably under node's 32 MB scrypt maxmem default (we pass 64 MB
// so a future bump has headroom).
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

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
    return `scrypt$${N}$${r}$${p}$${Buffer.from(salt).toString('base64')}$${dk.toString('base64')}`;
}

// Verify a PIN against a stored hash. Constant-time on the derived key. Reads
// N/r/p + salt back out of the encoded string so hashes made with older params
// still verify after the cost is raised. Returns false on any malformed input.
export function verifyPin(pin, encoded, { pepper = '', scrypt = crypto.scryptSync } = {}) {
    if (typeof encoded !== 'string') return false;
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, dkB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(dkB64, 'base64');
    if (!salt.length || !expected.length) return false;
    const dk = Buffer.from(scrypt(String(pin) + pepper, salt, expected.length, {
        N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT_MAXMEM,
    }));
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
}
