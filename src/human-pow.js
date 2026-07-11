// Stateless proof-of-work human gate (server side). No third-party service and
// no per-challenge server state: each challenge is HMAC-signed so the server
// only re-checks the signature + the work on submit, and the "check-once"
// session token is a second HMAC-signed blob. The browser (web/src/humanPow.js)
// brute-forces a nonce whose sha256(challenge:nonce) has >= `bits` leading zero
// bits; the server is the correctness authority (it recomputes with node
// crypto), so a buggy/absent client hash simply never passes.
//
// Pure except for node:crypto (stdlib) - no config/.env/DB imports, so the
// whole flow is offline-testable (tests/human-pow.test.js).
import crypto from 'node:crypto';

export function sha256Hex(str) {
    return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function hmacHex(secret, data) {
    return crypto.createHmac('sha256', String(secret)).update(String(data)).digest('hex');
}

// Constant-time hex-string compare (guards length first - timingSafeEqual
// throws on unequal-length buffers).
function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Number of leading zero BITS in a hex digest (the PoW difficulty measure).
export function leadingZeroBits(hex) {
    let bits = 0;
    for (const ch of String(hex)) {
        const nibble = parseInt(ch, 16);
        if (Number.isNaN(nibble)) break;
        if (nibble === 0) { bits += 4; continue; }
        if (nibble < 2) bits += 3;       // 0001
        else if (nibble < 4) bits += 2;  // 001x
        else if (nibble < 8) bits += 1;  // 01xx
        break;                            // first non-zero nibble ends the run
    }
    return bits;
}

// Issue a signed PoW challenge. `nonce` (the challenge id) is injectable for
// deterministic tests; production uses a fresh random 16 bytes.
export function issueChallenge(secret, { bits, ttlMs, now = Date.now(), nonce } = {}) {
    const c = nonce ?? crypto.randomBytes(16).toString('hex');
    const b = Number(bits);
    const exp = now + Number(ttlMs);
    return { challenge: c, bits: b, exp, sig: hmacHex(secret, `${c}.${b}.${exp}`) };
}

// Verify a submitted solution. Returns { ok, reason } - reason is a short slug
// for logging, never surfaced verbatim as a security hint.
export function verifyChallenge(secret, submission, { now = Date.now() } = {}) {
    const { challenge, bits, exp, sig, nonce } = submission ?? {};
    if (!challenge || bits == null || exp == null || !sig || nonce == null) {
        return { ok: false, reason: 'malformed' };
    }
    const b = Number(bits);
    const e = Number(exp);
    if (!Number.isFinite(b) || !Number.isFinite(e)) return { ok: false, reason: 'malformed' };
    // Authenticity: the params must carry our signature (blocks a client from
    // lowering `bits`, extending `exp`, or forging a challenge we never issued).
    if (!safeEqualHex(sig, hmacHex(secret, `${challenge}.${b}.${e}`))) return { ok: false, reason: 'bad-signature' };
    if (now > e) return { ok: false, reason: 'expired' };
    // The work itself: sha256(challenge:nonce) must clear the difficulty.
    if (leadingZeroBits(sha256Hex(`${challenge}:${nonce}`)) < b) return { ok: false, reason: 'insufficient-work' };
    return { ok: true, reason: 'ok' };
}

// Check-once session token: base64url(JSON payload) + '.' + HMAC. Carries only
// an expiry; presence of a valid unexpired token = "already verified".
export function signHumanToken(secret, { ttlMs, now = Date.now() } = {}) {
    const payload = Buffer.from(JSON.stringify({ e: now + Number(ttlMs) })).toString('base64url');
    return `${payload}.${hmacHex(secret, payload)}`;
}

export function verifyHumanToken(secret, token, { now = Date.now() } = {}) {
    if (typeof token !== 'string' || !token.includes('.')) return { ok: false, reason: 'malformed' };
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return { ok: false, reason: 'malformed' };
    if (!safeEqualHex(sig, hmacHex(secret, payload))) return { ok: false, reason: 'bad-signature' };
    let exp;
    try {
        exp = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))?.e;
    } catch {
        return { ok: false, reason: 'malformed' };
    }
    if (!Number.isFinite(Number(exp))) return { ok: false, reason: 'malformed' };
    if (now > Number(exp)) return { ok: false, reason: 'expired' };
    return { ok: true, reason: 'ok', exp: Number(exp) };
}
