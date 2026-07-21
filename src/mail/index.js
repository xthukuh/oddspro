import { effective } from '../settings.js';
import { withRetry } from '../db/retry-rules.js';
import { isRetryableNetworkError } from '../db/net-rules.js';
import { debugLog } from '../utils.js';
import * as smtp from './smtp.js';

// Mail provider seam (M13), mirroring src/sms/index.js: smtp is the only
// provider today and getProvider() is the single swap point - a new provider
// implements send() returning the same normalized shape, and nothing else
// changes. Outbound sends ride the shared network retry (transient
// ECONNRESET/ETIMEDOUT self-heals; an SMTP rejection throws through to the
// caller - it won't self-heal, so it must surface as sent:false there).
//
// Economy + dev ergonomics: MAIL_MAILER 'log' (the default) hits no network -
// the email body is logged to the server console, so every email-fallback flow
// is fully testable without an SMTP account. 'smtp' with missing creds fails
// closed at send time (a clear error, never a silent "success").
const PROVIDERS = { smtp };
const RETRY = { tries: 3, base: 500, isRetryable: isRetryableNetworkError };

export function getProvider() {
    return PROVIDERS.smtp; // future: pick by MAIL_MAILER value
}

// Late-read so the admin MAIL_MAILER override applies live (settings.effective
// falls back to config env when no override is set).
export function mailEnabled() {
    return effective('MAIL_MAILER') === 'smtp';
}

// Send one email. Returns { ok, messageId, dev? }. Never hits the network in
// 'log' mode; throws only on a real send failure the caller should surface.
// One-time notice when the dev sink is swallowing real mail. MAIL_MAILER
// defaults to 'log', and the email fallback is precisely the recovery path for
// users SMS cannot reach - a forgotten MAIL_MAILER=smtp is a silent dead end.
let _warnedDevSink = false;
function _warnDevSinkOnce() {
    if (_warnedDevSink) return;
    _warnedDevSink = true;
    console.warn('[mail] MAIL_MAILER=log - no email is reaching the network, so the email OTP '
        + 'fallback and Forgot-PIN recovery silently do nothing. Bodies are echoed to the log ONLY '
        + 'under DEBUG=1 (they carry reset codes). Set MAIL_MAILER=smtp with MAIL_* credentials.');
}

export async function sendMail({ to, subject, text }) {
    if (!mailEnabled()) {
        _warnDevSinkOnce();
        // DEBUG-gated: the body carries a PIN-reset code, the strongest
        // credential in the system. See the twin note in src/sms/index.js.
        debugLog(`[mail:dev] MAIL_MAILER=log - would send to ${to}: ${subject} | ${text}`);
        return { ok: true, dev: true, messageId: null };
    }
    const res = await withRetry(() => getProvider().send({ to, subject, text }), RETRY);
    return { ok: res.ok, messageId: res.messageId, message: res.message };
}
