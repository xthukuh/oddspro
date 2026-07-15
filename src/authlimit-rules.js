// Pure in-memory rate-limit math (zero imports, offline-testable). A caller
// keeps a Map<key, number[]> of hit timestamps; slidingWindowAllow prunes hits
// outside the window and decides whether one more is allowed, returning the
// pruned+updated array for the caller to store back.
//
// This is best-effort DoS softening ONLY. The server runs `trust proxy = true`,
// so a client-supplied X-Forwarded-For is spoofable and IP keys can't be
// trusted. The AUTHORITATIVE controls are the DB per-account PIN lockout and the
// DB-backed OTP resend cooldown (src/auth-rules.js + src/db/sms-rules.js).

export function slidingWindowAllow(hits, nowMs, { windowMs, max }) {
    const cutoff = nowMs - windowMs;
    const recent = (hits || []).filter(t => t > cutoff);
    if (recent.length >= max) {
        // Earliest hit in the window frees up a slot when it ages out.
        const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - nowMs) / 1000));
        return { allowed: false, hits: recent, retryAfterSeconds };
    }
    recent.push(nowMs);
    return { allowed: true, hits: recent, retryAfterSeconds: 0 };
}
