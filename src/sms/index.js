import { config } from '../config.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';
import * as bonga from './bonga.js';

// SMS provider seam. Bonga is the only provider today; getProvider() is the
// single swap point - a new provider implements send/balance/delivery returning
// the same normalized shapes from sms-rules, and nothing else changes. All
// outbound sends go through the shared network retry (transient ECONNRESET/TLS
// self-heals; a 666 app error is { ok:false } and never retried).
//
// Economy + dev ergonomics: when SMS_ENABLED is off we DON'T hit the network -
// the OTP message is logged to the server console so signup/verify is fully
// testable without a Bonga account or spending credits. When SMS_ENABLED is ON
// but creds are missing, the provider throws (fail-closed) so the caller can
// surface a clear error rather than silently "succeeding".
const PROVIDERS = { bonga };
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export function getProvider() {
    return PROVIDERS.bonga; // future: pick by config.SMS_PROVIDER
}

export function smsEnabled() {
    return Boolean(config.SMS_ENABLED);
}

// Send one SMS. Returns { ok, messageId, dev? }. Never hits the network when
// SMS is disabled; throws only on a real send failure the caller should surface.
export async function sendSms({ to, text }) {
    if (!smsEnabled()) {
        console.debug(`[sms:dev] SMS disabled - would send to ${to}: ${text}`);
        return { ok: true, dev: true, messageId: null };
    }
    const res = await withRetry(() => getProvider().send({ to, text }), RETRY);
    return { ok: res.ok, messageId: res.messageId, status: res.status, message: res.message };
}

export async function smsBalance() {
    return withRetry(() => getProvider().balance(), RETRY);
}

export async function smsDelivery(messageId) {
    return withRetry(() => getProvider().delivery(messageId), RETRY);
}
