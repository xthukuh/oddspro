import { config } from '../config.js';
import { effective } from '../settings.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';
import { isCleartextUrl } from '../db/sms-rules.js';
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

// One-time cleartext-transport warning: Bonga's send host is plain HTTP, so the
// API secret + recipient + message travel UNENCRYPTED. We can't default to HTTPS
// (the vendor publishes no TLS send endpoint) and refusing to send would break
// the only working path, so we warn loudly and let operators route
// BONGA_API_URL_SEND through their own HTTPS proxy. See docs/DEPLOYMENT.md.
let _warnedInsecure = false;
function _warnInsecureOnce() {
    if (_warnedInsecure || !isCleartextUrl(config.BONGA_API_URL_SEND)) return;
    _warnedInsecure = true;
    console.warn(`[sms] SECURITY: SMS send endpoint ${config.BONGA_API_URL_SEND} is plaintext HTTP - `
        + 'the API secret, recipient number and message transit UNENCRYPTED. This is the Bonga '
        + 'vendor-published send host (balance/delivery use HTTPS). Route BONGA_API_URL_SEND through '
        + 'an HTTPS proxy you control to protect credentials.');
}

export function getProvider() {
    return PROVIDERS.bonga; // future: pick by config.SMS_PROVIDER
}

// Late-read so the admin SMS_ENABLED override applies live (settings.effective
// falls back to config env when no override / cache not loaded - e.g. CLI runs
// that never loadOverrides()).
export function smsEnabled() {
    return Boolean(effective('SMS_ENABLED'));
}

// Send one SMS. Returns { ok, messageId, dev? }. Never hits the network when
// SMS is disabled; throws only on a real send failure the caller should surface.
export async function sendSms({ to, text }) {
    if (!smsEnabled()) {
        console.debug(`[sms:dev] SMS disabled - would send to ${to}: ${text}`);
        return { ok: true, dev: true, messageId: null };
    }
    _warnInsecureOnce();
    const res = await withRetry(() => getProvider().send({ to, text }), RETRY);
    return { ok: res.ok, messageId: res.messageId, status: res.status, message: res.message };
}

export async function smsBalance() {
    return withRetry(() => getProvider().balance(), RETRY);
}

export async function smsDelivery(messageId) {
    return withRetry(() => getProvider().delivery(messageId), RETRY);
}
