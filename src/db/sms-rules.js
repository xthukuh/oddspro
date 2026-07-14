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

// --- OTP codes --------------------------------------------------------------
// A uniform numeric code of `len` digits with leading zeros preserved.
// `randomInt` is INJECTED - pass crypto.randomInt in production, a stub in
// tests. It must return an integer in [0, maxExclusive).
export function generateOtp(len, randomInt) {
    if (!Number.isInteger(len) || len < 4 || len > 10) throw new Error(`bad OTP length: ${len}`);
    return String(randomInt(10 ** len)).padStart(len, '0');
}

// DB datetimes come back as Date (mysql2); normalize Date | number | ISO -> ms.
const _ms = v => (v instanceof Date ? v.getTime() : (typeof v === 'number' ? v : Date.parse(v)));

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
export function parseBongaSend(data) {
    const d = SendEnvelope.parse(data);
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

const DeliveryEnvelope = z.object({
    status: z.coerce.number(),
    status_message: z.string().optional().default(''),
    delivery_status: z.string().optional(),
    delivery_status_desc: z.string().optional(),
});
export function parseBongaDelivery(data) {
    const d = DeliveryEnvelope.parse(data);
    return {
        ok: d.status === 222,
        status: d.status,
        message: d.status_message,
        deliveryStatus: d.delivery_status ?? null,
        deliveryStatusDesc: d.delivery_status_desc ?? null,
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
    const host = s.slice(7).split(/[/:?#]/)[0].toLowerCase();
    return !['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
}
