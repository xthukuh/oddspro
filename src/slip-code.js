// Shareable-slip codes (engine-v2 Phase 4): 6-character Crockford base32 -
// no I/L/O/U, so a code survives handwriting and phone calls; ~1.07e9
// combinations keeps blind guessing impractical while staying typeable.
// Crypto-bearing pure module at the src/ root (the auth-rules convention).
import { randomInt } from 'node:crypto';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

export function generateSlipCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    return code;
}

// Tolerant input normalization (Crockford decode rules): case-insensitive,
// I/L read as 1, O as 0, separators dropped. Null when it cannot be a code.
export function normalizeSlipCode(input) {
    const s = String(input ?? '').toUpperCase().replace(/[\s-]/g, '')
        .replace(/[IL]/g, '1').replace(/O/g, '0');
    if (s.length !== CODE_LENGTH) return null;
    for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
    return s;
}
