// Secure secret generator for the .env bootstrap values (PIN_PEPPER,
// API_TOKEN, ADMIN_TOKEN, session peppers) and one-off codes. node:crypto
// only: cryptographically secure, no dependencies, prints to stdout and
// nothing else (safe to pipe). Never persists or logs what it generates.
//
// Usage:
//   node scripts/gen-secret.js               # 32-byte hex (64 chars) - the PIN_PEPPER shape
//   node scripts/gen-secret.js hex [bytes]   # hex of N random bytes (default 32)
//   node scripts/gen-secret.js b64 [bytes]   # base64url of N random bytes (default 32)
//   node scripts/gen-secret.js pin [digits]  # numeric PIN, default 4 digits (ADMIN_SEED_PIN)
//   node scripts/gen-secret.js uuid          # random UUID v4
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

const [kind = 'hex', sizeArg] = process.argv.slice(2);

function bytes(dflt) {
    const n = parseInt(sizeArg, 10);
    if (Number.isNaN(n)) return dflt;
    if (n < 8 || n > 1024) {
        console.error(`byte length must be 8..1024, got ${sizeArg}`);
        process.exit(1);
    }
    return n;
}

switch (kind) {
    case 'hex':
        console.log(randomBytes(bytes(32)).toString('hex'));
        break;
    case 'b64':
        console.log(randomBytes(bytes(32)).toString('base64url'));
        break;
    case 'pin': {
        const digits = parseInt(sizeArg ?? '4', 10);
        if (Number.isNaN(digits) || digits < 4 || digits > 12) {
            console.error(`pin digits must be 4..12, got ${sizeArg}`);
            process.exit(1);
        }
        // randomInt per digit: uniform, no modulo bias, leading zeros allowed.
        console.log(Array.from({ length: digits }, () => randomInt(0, 10)).join(''));
        break;
    }
    case 'uuid':
        console.log(randomUUID());
        break;
    default:
        console.error('Usage: node scripts/gen-secret.js [hex|b64|pin|uuid] [bytes|digits]');
        process.exit(1);
}
