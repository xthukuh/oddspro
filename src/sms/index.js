import { config } from '../config.js';
import { effective } from '../settings.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';
import { isCleartextUrl, sendBudgetVerdict } from '../db/sms-rules.js';
import { eatDateKey } from '../db/auto-rules.js';
import { debugLog } from '../utils.js';
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

// One-time notice when the dev sink is swallowing real sends. SMS_ENABLED
// defaults OFF, so a deploy that forgets to wire Bonga silently fails every
// verification while telling users "code sent" - this makes that visible in
// the log instead of leaving it to be discovered by a stuck user.
let _warnedDevSink = false;
function _warnDevSinkOnce() {
    if (_warnedDevSink) return;
    _warnedDevSink = true;
    console.warn('[sms] SMS_ENABLED=0 - no SMS is reaching the network, so nobody can complete '
        + 'phone verification or a PIN reset. Codes are echoed to the log ONLY under DEBUG=1: an '
        + 'unrotated server log must never accumulate login and PIN-reset credentials by default. '
        + 'Set SMS_ENABLED=1 with Bonga credentials before serving real users.');
}

// In-process per-EAT-day counter behind SMS_DAILY_CAP. Same accepted trade-off
// as TIP_AI_DAILY_CAP: per process and reset by a restart, so a respawn loop
// could grant an extra day's budget. That is a bounded imprecision; the
// alternative (no ceiling at all) is unbounded spend, which is what the audit
// found reachable from the unauthenticated signup route.
let _budget = { day: null, count: 0 };

// Read-only view for diagnostics/tests - never mutate the live counter.
export function smsBudget() {
    return { ..._budget, cap: Number(effective('SMS_DAILY_CAP')) || 0 };
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
        _warnDevSinkOnce();
        // The message body carries the OTP, so it is DEBUG-gated (debugLog),
        // never a bare console.debug: SMS_ENABLED defaults off, and a default
        // deploy must not write every login and PIN-reset code plus the phone
        // number into a plaintext log the app never rotates.
        debugLog(`[sms:dev] SMS disabled - would send to ${to}: ${text}`);
        return { ok: true, dev: true, messageId: null };
    }
    // Reserve budget BEFORE sending: a send that fails or is retried has still
    // consumed provider capacity, and for a spend ceiling the conservative
    // direction is to count it. Refusals resolve { ok:false } like any other
    // provider failure, so every caller already handles them (an OTP surfaces
    // sent:false; a campaign counts a failure and its breaker stops the run).
    const verdict = sendBudgetVerdict(_budget, eatDateKey(Date.now()), effective('SMS_DAILY_CAP'));
    if (!verdict.allowed) {
        console.error(`[sms] DAILY CAP REACHED (${verdict.count}/${effective('SMS_DAILY_CAP')} today) - `
            + `refusing to send to ${to}. Raise SMS_DAILY_CAP in Admin -> Settings if this is legitimate traffic.`);
        return { ok: false, capped: true, messageId: null, status: 'daily_cap', message: 'Daily SMS cap reached' };
    }
    _budget = { day: verdict.day, count: verdict.count };
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
