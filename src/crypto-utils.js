// Shared pure crypto helpers. Pure except for node:crypto (stdlib) - no
// config/.env/DB imports, so consumers stay offline-testable
// (tests/crypto-utils.test.js).
//
// Extracted from the retired src/human-pow.js (2026-07-16): the proof-of-work
// human gate was deprecated as irrelevant at this stage, but these two helpers
// were never PoW-specific - sha256Hex backs session-token + OTP-code hashing
// (src/auth-rules.js) and bearerMatches backs every machine-bearer / admin gate
// in src/server.js. The bot-UA blocklist + AI robots.txt (src/bot-rules.js) are
// a SEPARATE feature and remain in place.
import crypto from 'node:crypto';

export function sha256Hex(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

// Does an Authorization header carry a Bearer token matching ANY of the given
// machine secrets? Constant-time per compare (length-guarded); unset/empty
// secrets are skipped so a blank env var can never authenticate. The /api
// gates use this to recognize route-owned bearer auth (API_TOKEN, ADMIN_TOKEN)
// generically instead of growing a per-path allow-list.
export function bearerMatches(authorization, secrets) {
    const a = typeof authorization === 'string' ? authorization : '';
    if (!a.startsWith('Bearer ')) return false;
    const token = a.slice(7);
    if (!token) return false;
    let ok = false; // check every secret (no early exit) - uniform timing
    for (const s of secrets || []) {
        if (typeof s !== 'string' || !s.length) continue;
        if (s.length === token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(s))) ok = true;
    }
    return ok;
}
