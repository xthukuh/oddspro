// Pure SMS + OTP rules (zod-only, zero other imports, offline-testable). Covers
// phone normalization, OTP generation / expiry / reuse math, resend backoff, and
// the Bonga provider response envelopes. Deliberately crypto-free (OTP code
// HASHING lives in src/auth-rules.js with the other node:crypto helpers) and
// config/HTTP-free (the provider client src/sms/bonga.js and orchestrator
// src/sms/index.js own those) - so the whole SMS decision surface is unit-tested
// without a network or a Bonga account.
import { z } from 'zod';

// --- Phone numbers ----------------------------------------------------------
// E.164: a leading + then 8-15 digits, first digit non-zero.
const E164 = /^\+[1-9]\d{7,14}$/;
export function isValidE164(s) {
    return typeof s === 'string' && E164.test(s);
}
// Bonga's MSISDN is the number WITHOUT the leading + (digits only, e.g.
// 254799944004). (VERIFY the exact expected shape against the live endpoint -
// flagged in the plan; this is the natural E.164-minus-plus form.)
export function toMsisdn(e164) {
    if (!isValidE164(e164)) throw new Error(`invalid E.164 phone: ${e164}`);
    return e164.slice(1);
}

// Region -> E.164 calling code for the national-form inference below. Only
// regions the app actually serves (SMS_DEFAULT_REGION); extend as needed -
// an unlisted region simply can't infer bare national numbers (fail-safe).
const REGION_CALLING_CODES = { KE: '254', UG: '256', TZ: '255' };

// Normalize a user-typed phone into E.164, or null when it can't be done
// safely. Accepts: E.164 passthrough (`+254...`), the 00 international
// dialing prefix (`00254...`), MSISDN form (`254...`), national trunk form
// (`0799...`), and the bare national significant number (`799...`) - the
// last three resolved via `region`'s calling code. Formatting noise
// (spaces, dashes, dots, parens) is stripped first. Every candidate is
// re-validated as E.164, so a bad guess returns null rather than a junk key.
export function normalizePhone(input, { region = 'KE' } = {}) {
    if (typeof input !== 'string') return null;
    const s = input.replace(/[\s\-.()]/g, '');
    if (!s) return null;
    if (s.startsWith('+')) return isValidE164(s) ? s : null;
    if (!/^\d+$/.test(s)) return null;
    if (s.startsWith('00')) {
        const intl = `+${s.slice(2)}`;
        return isValidE164(intl) ? intl : null;
    }
    const code = REGION_CALLING_CODES[region];
    if (!code) return null;
    // Already carries the calling code (MSISDN form) - don't double-prefix.
    if (s.startsWith(code) && isValidE164(`+${s}`)) return `+${s}`;
    const national = s.startsWith('0') ? s.slice(1) : s;
    const e164 = `+${code}${national}`;
    return isValidE164(e164) ? e164 : null;
}

// --- OTP codes --------------------------------------------------------------
// A uniform numeric code of `len` digits with leading zeros preserved.
// `randomInt` is INJECTED - pass crypto.randomInt in production, a stub in
// tests. It must return an integer in [0, maxExclusive).
export function generateOtp(len, randomInt) {
    if (!Number.isInteger(len) || len < 4 || len > 10) throw new Error(`bad OTP length: ${len}`);
    return String(randomInt(10 ** len)).padStart(len, '0');
}

// DB datetimes come back as Date (mysql2); normalize Date | number | ISO -> ms.
// Exported for the auth lockout math (auth-rules.js) - one copy (C1).
export const _ms = v => (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v)));

// Expiry timestamp (ms) for a code issued at nowMs.
export function otpExpiry(nowMs, ttlMinutes) {
    return nowMs + ttlMinutes * 60_000;
}
export function isOtpExpired(row, nowMs) {
    return _ms(row.expires_at) <= nowMs;
}
// SMS economy: reuse the latest unconsumed code while it's still valid instead
// of generating and sending a fresh one.
export function shouldReuseOtp(row, nowMs) {
    return Boolean(row) && row.consumed_at == null && !isOtpExpired(row, nowMs);
}

// --- Resend backoff ---------------------------------------------------------
// Cooldown (seconds) required BEFORE the next send, growing 60·k with each
// resend: with `resendCount` completed resends the next one waits
// base·(count+1), so the user-visible sequence is 60, 120, 180, ...
export function resendCooldownSeconds(resendCount, base = 60) {
    return base * (Math.max(0, resendCount) + 1);
}
// Can the user resend now? Enforces the growing cooldown AND an optional hard
// cap on total resends. Returns { ok, reason, retryAfterSeconds }.
export function canResend(nowMs, lastSentAt, resendCount, { base = 60, max = Infinity } = {}) {
    if (resendCount >= max) return { ok: false, reason: 'max', retryAfterSeconds: null };
    const required = resendCooldownSeconds(resendCount, base);
    const elapsed = (nowMs - _ms(lastSentAt)) / 1000;
    if (elapsed >= required) return { ok: true, reason: null, retryAfterSeconds: 0 };
    return { ok: false, reason: 'cooldown', retryAfterSeconds: Math.ceil(required - elapsed) };
}

// Should an issue request (signup / change-phone) send a fresh code? The
// cooldown + cap are gated on the USER's active row, never on the target phone
// - alternating two numbers must not reset the clock (the SMS-flood exploit).
//   send   - no active row, or the cooldown has elapsed and the cap allows.
//   reuse  - same phone, still-valid code, inside the cooldown: the code already
//            on its way still works, so report the wait instead of spending SMS.
//   reject - inside the cooldown for a different phone (or a dead code), or the
//            hard resend cap is hit - the caller should answer 429.
export function otpIssueDecision(existing, phone, nowMs, { base = 60, max = Infinity } = {}) {
    if (!existing) return { action: 'send' };
    const cr = canResend(nowMs, existing.last_sent_at, existing.resend_count, { base, max });
    if (cr.ok) return { action: 'send' };
    if (cr.reason === 'cooldown' && existing.phone === phone && shouldReuseOtp(existing, nowMs)) {
        return { action: 'reuse', retryAfterSeconds: cr.retryAfterSeconds };
    }
    return { action: 'reject', reason: cr.reason, retryAfterSeconds: cr.retryAfterSeconds };
}

// --- Bonga provider responses (zod) -----------------------------------------
// status: 222 = success, 666 = error. Coerced (the API may send it as a
// string); optional fields stay tolerant so a shape drift doesn't throw.
const _num = z.union([z.string(), z.number()]).optional();

const SendEnvelope = z.object({
    status: z.coerce.number(),
    status_message: z.string().optional().default(''),
    unique_id: _num,
    credits: _num,
});
// Compact evidence for an unparseable provider body (logged, never rendered).
function _snippet(data) {
    let s;
    try { s = typeof data === 'string' ? data : JSON.stringify(data); } catch { s = String(data); }
    return String(s).slice(0, 120);
}
// Tolerant by design (M1 2026-07-19): send sits in a user request path, so a
// provider shape drift must fold to a loud { ok:false } verdict - a thrown
// ZodError here used to masquerade as "couldn't send" with no evidence.
export function parseBongaSend(data) {
    const p = SendEnvelope.safeParse(data);
    if (!p.success) {
        return { ok: false, status: null, message: `unparseable send response: ${_snippet(data)}`, messageId: null, credits: null };
    }
    const d = p.data;
    return {
        ok: d.status === 222,
        status: d.status,
        message: d.status_message,
        messageId: d.unique_id != null ? String(d.unique_id) : null,
        credits: d.credits != null ? Number(d.credits) : null,
    };
}

const BalanceEnvelope = z.object({
    status: z.coerce.number(),
    status_message: z.string().optional().default(''),
    client_name: z.string().optional(),
    sms_credits: _num,
    sms_threshold: _num,
    api_client_id: _num,
});
export function parseBongaBalance(data) {
    const d = BalanceEnvelope.parse(data);
    return {
        ok: d.status === 222,
        status: d.status,
        message: d.status_message,
        clientName: d.client_name ?? null,
        credits: d.sms_credits != null ? Number(d.sms_credits) : null,
        threshold: d.sms_threshold != null ? Number(d.sms_threshold) : null,
    };
}

// Real envelope verified live 2026-07-19 (unique_id 597538152): the vendor
// sends NO delivery_status field - only delivery_status_desc (e.g.
// "DeliveredToTerminal"), plus date_received + msisdn. Tolerant like send: the
// M13 resend-time delivery check runs inside a user request path.
const DeliveryEnvelope = z.object({
    status: z.coerce.number(),
    status_message: z.string().optional().default(''),
    unique_id: _num,
    delivery_status_desc: z.string().nullable().optional(),
    date_received: z.string().nullable().optional(),
    msisdn: z.union([z.string(), z.number()]).nullable().optional(),
});
export function parseBongaDelivery(data) {
    const p = DeliveryEnvelope.safeParse(data);
    if (!p.success) {
        return { ok: false, status: null, message: `unparseable delivery response: ${_snippet(data)}`, deliveryStatusDesc: null, dateReceived: null, msisdn: null };
    }
    const d = p.data;
    return {
        ok: d.status === 222,
        status: d.status,
        message: d.status_message,
        deliveryStatusDesc: d.delivery_status_desc ?? null,
        dateReceived: d.date_received ?? null,
        msisdn: d.msisdn != null ? String(d.msisdn) : null,
    };
}

// 222 = ok; anything else (666 or unknown) is a FATAL application error. The
// transport-level network retry (net-rules) is separate and owned by the
// caller - a 666 must never be retried (it won't self-heal).
export function classifyBongaStatus(status) {
    return Number(status) === 222 ? 'ok' : 'fatal';
}

// SECURITY: is an outbound URL cleartext HTTP to a NON-loopback host? Bonga's
// vendor-published send endpoint is plain http:// (an IP:port with no TLS), so
// the API secret + recipient number + message transit UNENCRYPTED. Loopback
// (a local HTTPS-terminating proxy) is exempt. The send path warns once when
// this is true; operators can override BONGA_API_URL_SEND with their own HTTPS
// proxy. Pure so it's unit-tested offline.
export function isCleartextUrl(url) {
    const s = String(url || '');
    if (!s.toLowerCase().startsWith('http://')) return false;
    // WHATWG URL (a global - still zero-import) handles userinfo, ports and
    // bracketed IPv6 hosts the old split() misparsed (C4: http://[::1]:.../ or
    // http://user:pass@127.0.0.1/ fired the warning falsely).
    let host;
    try {
        host = new URL(s).hostname.toLowerCase(); // IPv6 keeps its brackets: '[::1]'
    } catch {
        return true; // unparseable http:// - warn rather than stay silent
    }
    return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}
