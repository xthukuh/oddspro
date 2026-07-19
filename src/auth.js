import crypto from 'node:crypto';
import { config } from './config.js';
import { db } from './db/connection.js';
import { withRetry, isRetryableDbError } from './db/retry-rules.js';
import {
    hashPinAsync, verifyPinAsync, newSessionToken, hashToken, hashOtpCode,
    registerFailedAttempt, isLocked, registerOtpAttempt, maskEmail, emailFallbackTarget,
} from './auth-rules.js';
import {
    generateOtp, otpExpiry, isOtpExpired, canResend, resendCooldownSeconds, otpIssueDecision,
    isDeliveryFailure,
} from './db/sms-rules.js';
import { normalizeIp } from './db/visit-rules.js'; // sessions.ip must store the same format visits.ip does
import { sendSms, smsDelivery, smsEnabled } from './sms/index.js';
import { wrapAuthText } from './sms/templates.js';  // M9 auth-default template wrap (fail-open)
import { sendMail } from './mail/index.js';
import { effective } from './settings.js';

// Auth service: thin knex orchestration over the pure rules (auth-rules.js) and
// the SMS seam (sms/). Same loader idiom as magic.js/hotpicks.js. Contended
// writes go through withRetry(isRetryableDbError). HTTP-status-carrying errors
// use AuthError so the server maps them without a translation table.

// One-time boot check: a missing pepper is allowed (dev) but flagged loudly -
// in production every PIN hash should be peppered, and changing PIN_PEPPER later
// invalidates all existing PINs (a deliberate global reset lever).
if (config.AUTH_ENABLED && !config.PIN_PEPPER) {
    console.warn('[auth] PIN_PEPPER is unset - PIN hashes have no server pepper. Set PIN_PEPPER in .env for production.');
}

const PEPPER = () => config.PIN_PEPPER || '';

export class AuthError extends Error {
    constructor(status, message, details = {}) {
        super(message);
        this.name = 'AuthError';
        this.status = status;
        this.details = details;
    }
}

// Never leak pin_hash / internal columns to the client.
export function publicUser(u) {
    if (!u) return null;
    return {
        id: u.id,
        name: u.name,
        role: u.role,
        phone: u.phone,
        phone_region: u.phone_region,
        phone_code: u.phone_code,
        phone_carrier: u.phone_carrier,
        phone_verified: Boolean(u.phone_verified),
        email: u.email ?? null,
        must_change_pin: Boolean(u.must_change_pin),
        is_active: Boolean(u.is_active),
        sms_opt_out: Boolean(u.sms_opt_out),
        last_login_at: u.last_login_at ?? null,
        terms_version: u.terms_version ?? null,
        terms_accepted_at: u.terms_accepted_at ?? null,
    };
}

const userById = id => db('users').where('id', id).first();
const userByPhone = phone => db('users').where('phone', phone).first();

function otpMessage(code) {
    return `Your Odds Pro verification code is ${code}. It expires in ${effective('OTP_TTL_MINUTES')} minutes.`;
}
// Same code, email envelope (M13 fallback channel).
function otpEmailContent(code) {
    return {
        subject: 'Your Odds Pro verification code',
        text: `${otpMessage(code)}\n\nIf you didn't request this code, you can ignore this email.`,
    };
}

// --- Accounts ---------------------------------------------------------------

export async function createUser({ name, phone, phone_region, phone_code, pin, terms_version = null }) {
    if (await userByPhone(phone)) throw new AuthError(409, 'That phone number is already registered');
    const pin_hash = await hashPinAsync(pin, { pepper: PEPPER() });
    try {
        const [id] = await withRetry(() => db('users').insert({
            name, role: 'normal', phone, phone_region, phone_code,
            phone_verified: 0, must_change_pin: 0, is_active: 1, pin_hash,
            // M4 consent record: the schema gate guarantees accepted_terms was
            // true, so a provided version stamps the acceptance time with it.
            terms_version, terms_accepted_at: terms_version ? db.fn.now() : null,
        }), { isRetryable: isRetryableDbError });
        return userById(id);
    } catch (e) {
        if (e?.code === 'ER_DUP_ENTRY') throw new AuthError(409, 'That phone number is already registered');
        throw e;
    }
}

// Verify phone + PIN, applying the account lockout. Returns the raw user row.
export async function authenticate({ phone, pin }) {
    const user = await userByPhone(phone);
    // Generic message either way so a wrong phone can't be distinguished.
    if (!user) throw new AuthError(401, 'Invalid phone number or PIN');
    if (!user.is_active) throw new AuthError(403, 'This account is disabled');

    const nowMs = Date.now();
    const lock = isLocked(user.locked_until, nowMs);
    if (lock.locked) {
        throw new AuthError(423, 'Account temporarily locked - too many wrong PINs', { retry_after_seconds: lock.retryAfterSeconds });
    }
    // A lock that has expired resets the attempt counter for this fresh try.
    const baseAttempts = user.locked_until ? 0 : user.pin_attempts;

    if (await verifyPinAsync(pin, user.pin_hash, { pepper: PEPPER() })) {
        await db('users').where('id', user.id).update({ pin_attempts: 0, locked_until: null, last_login_at: db.fn.now() });
        return userById(user.id);
    }
    const { attempts, lockedUntil } = registerFailedAttempt(baseAttempts, nowMs, {
        max: effective('PIN_MAX_ATTEMPTS'), lockoutMs: effective('PIN_LOCKOUT_MINUTES') * 60_000,
    });
    await db('users').where('id', user.id).update({
        pin_attempts: attempts, locked_until: lockedUntil ? new Date(lockedUntil) : null,
    });
    throw new AuthError(lockedUntil ? 423 : 401, lockedUntil
        ? 'Too many wrong PINs - account locked for a while' : 'Invalid phone number or PIN',
        lockedUntil ? { locked: true, retry_after_seconds: effective('PIN_LOCKOUT_MINUTES') * 60 } : {});
}

// --- Sessions ---------------------------------------------------------------

export async function mintSession(user, { userAgent = null, ip = null } = {}) {
    const { token, tokenHash } = newSessionToken();
    const expiresAt = new Date(Date.now() + effective('SESSION_TTL_DAYS') * 86_400_000);
    // normalizeIp (visit-rules, C1): strip ::ffff: prefixes / :port the same way
    // the visits log does, so the two tables agree on a client's IP format.
    const normIp = normalizeIp(ip);
    await withRetry(() => db('sessions').insert({
        user_id: user.id, token_hash: tokenHash, expires_at: expiresAt, last_seen_at: db.fn.now(),
        user_agent: userAgent ? String(userAgent).slice(0, 512) : null,
        ip: normIp ? String(normIp).slice(0, 45) : null,
    }), { isRetryable: isRetryableDbError });
    return token;
}

// Resolve a bearer token to { user, session } or null (unknown/expired/revoked/
// inactive). Throttles the last_seen_at write to ~once a minute per session.
export async function resolveSession(token) {
    if (!token) return null;
    const session = await db('sessions').where('token_hash', hashToken(token)).first();
    if (!session || session.revoked_at) return null;
    const nowMs = Date.now();
    if (new Date(session.expires_at).getTime() <= nowMs) return null;
    const user = await userById(session.user_id);
    if (!user || !user.is_active) return null;
    if (!session.last_seen_at || nowMs - new Date(session.last_seen_at).getTime() > 60_000) {
        db('sessions').where('id', session.id).update({ last_seen_at: db.fn.now() }).catch(() => {});
    }
    return { user, session };
}

export async function revokeSession(sessionId) {
    await db('sessions').where('id', sessionId).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}
export async function revokeAllForUser(userId) {
    await db('sessions').where('user_id', userId).whereNull('revoked_at').update({ revoked_at: db.fn.now() });
}

// --- OTP --------------------------------------------------------------------

const activeOtp = (userId, purpose) =>
    db('otp_codes').where({ user_id: userId, purpose }).whereNull('consumed_at').orderBy('id', 'desc').first();

// The issue-gate (cooldown + hard cap) keyed on the USER's active row whatever
// the target phone - alternating numbers must not reset the clock (SMS flood).
// Decision logic is pure (sms-rules otpIssueDecision, offline-tested).
const otpGate = (existing, phone, nowMs) => otpIssueDecision(existing, phone, nowMs, {
    base: effective('OTP_RESEND_BASE_SECONDS'), max: effective('OTP_MAX_RESENDS'),
});
function throwOtpRejected(gate) {
    throw new AuthError(429, gate.reason === 'max'
        ? 'Too many codes requested - try again later'
        : 'Please wait before requesting another code',
        { retry_after_seconds: gate.retryAfterSeconds, reason: gate.reason });
}

// Send the OTP SMS and fold the provider verdict into the caller's response.
// A Bonga app-error (bad key / no credits) resolves { ok:false } - it never
// throws - so it must be surfaced as sent:false, or the user is told "code
// sent" for an SMS that never left the provider (M3). E2 bounds how long the
// HTTP response waits for that verdict: sendSms's transport retries can take
// ~a minute on a network black-hole, so past SMS_RESPONSE_WAIT_MS the caller
// answers optimistically ({ sent:true, pending:true }) and the send finishes
// in the background, logging a late failure. Fast verdicts (the normal case,
// including every provider app-error) still surface as before - and network
// errors now fold into sent:false instead of throwing, so a dead provider is
// a resend prompt for the user, not a 500.
const SMS_RESPONSE_WAIT_MS = 8_000;
function _capped(promise) {
    return Promise.race([promise, new Promise(resolve => {
        const t = setTimeout(() => resolve(null), SMS_RESPONSE_WAIT_MS);
        t.unref?.(); // the cap alone must not hold the process open
    })]);
}

// Persist the provider message id onto the OTP row once the send verdict lands
// (possibly AFTER the HTTP response, on the pending path) - the M13 resend-time
// delivery check reads it back. Guarded on code_hash so a late verdict from a
// rotated-away send can't stamp its id onto the successor code's row.
function _persistMsgId(rowId, codeHash, messageId) {
    if (!rowId || !messageId) return;
    db('otp_codes').where({ id: rowId, code_hash: codeHash })
        .update({ provider_msg_id: String(messageId).slice(0, 64) })
        .catch(() => {});
}

async function sendOtpSms({ rowId, codeHash, phone, code }, extra) {
    const fail = detail => {
        console.error(`[auth] OTP SMS to ${phone} failed: ${detail}`);
        return { sent: false, error: 'send_failed', ...extra };
    };
    // M9: transactional text goes out through the configured auth template
    // (e.g. "[OP] ${message}"). Inside the promise chain so the wrap's DB read
    // rides the same _capped response-wait budget as the send itself;
    // wrapAuthText is fail-open, so no template (or no table) sends raw text.
    const send = wrapAuthText(otpMessage(code)).then(text => sendSms({ to: phone, text })).then(
        sms => {
            if (sms.ok === false) {
                return fail([sms.status, sms.message ?? 'provider error'].filter(x => x != null).join(' '));
            }
            _persistMsgId(rowId, codeHash, sms.messageId);
            return { sent: true, ...extra };
        },
        e => fail(e?.message ?? e),
    );
    const capped = await _capped(send);
    return capped ?? { sent: true, pending: true, ...extra };
}

// Email twin (M13): same verdict folding + response-wait cap as the SMS path,
// so the client sees ONE shape whatever the channel. `channel:'email'` rides
// the response for the "check your inbox" messaging.
async function sendOtpEmail({ rowId, codeHash, email, code }, extra) {
    const fail = detail => {
        console.error(`[auth] OTP email to ${email} failed: ${detail}`);
        return { sent: false, error: 'send_failed', channel: 'email', ...extra };
    };
    const send = sendMail({ to: email, ...otpEmailContent(code) }).then(
        mail => {
            if (mail.ok === false) return fail(mail.message ?? 'provider error');
            _persistMsgId(rowId, codeHash, mail.messageId);
            return { sent: true, channel: 'email', ...extra };
        },
        e => fail(e?.message ?? e),
    );
    const capped = await _capped(send);
    return capped ?? { sent: true, pending: true, channel: 'email', ...extra };
}

// Generate + send a fresh code (signup + change-phone + forgot-PIN + PIN
// change). Rotates the single active row for (user, purpose). Economy: a
// still-valid code for the SAME target that's still within its resend cooldown
// is a rapid duplicate - we skip spending another send and report the
// remaining cooldown. Any other send inside the cooldown (or past the resend
// cap) is a 429. channel 'email' (M13) sends to `email` instead of the phone;
// the row records both so verify-time guards stay per-send accurate.
export async function issueOtp(user, { purpose = 'phone_verify', phone, channel = 'sms', email = null } = {}) {
    phone = phone ?? user.phone;
    const target = channel === 'email' ? email : phone;
    const nowMs = Date.now();
    const existing = await activeOtp(user.id, purpose);
    const gate = otpGate(existing, target, nowMs);
    if (gate.action === 'reuse') {
        return { sent: false, reused: true, retry_after_seconds: gate.retryAfterSeconds };
    }
    if (gate.action === 'reject') throwOtpRejected(gate);
    const code = generateOtp(effective('OTP_LENGTH'), crypto.randomInt);
    const codeHash = hashOtpCode(code, PEPPER());
    const expiresAt = new Date(otpExpiry(nowMs, effective('OTP_TTL_MINUTES')));
    // Every rotate-send counts against the cap and grows the backoff - a
    // change-phone send must never stay at count 0 (the 60·n schedule and
    // OTP_MAX_RESENDS were dead letters without this).
    const resendCount = existing ? existing.resend_count + 1 : 0;
    // provider_msg_id resets on rotation - it belongs to the SENT code; the new
    // send's verdict re-stamps it (guarded on code_hash, see _persistMsgId).
    const rowVals = {
        phone, channel, email: channel === 'email' ? email : null,
        code_hash: codeHash, expires_at: expiresAt, attempts: 0, provider_msg_id: null,
    };
    let rowId;
    if (existing) {
        rowId = existing.id;
        await db('otp_codes').where('id', existing.id).update({
            ...rowVals, resend_count: resendCount, last_sent_at: db.fn.now(),
        });
    } else {
        [rowId] = await db('otp_codes').insert({
            user_id: user.id, purpose, ...rowVals, resend_count: 0, last_sent_at: db.fn.now(),
        });
    }
    const extra = {
        retry_after_seconds: resendCooldownSeconds(resendCount, effective('OTP_RESEND_BASE_SECONDS')),
    };
    return channel === 'email'
        ? sendOtpEmail({ rowId, codeHash, email, code }, extra)
        : sendOtpSms({ rowId, codeHash, phone, code }, extra);
}

// Did the row's last SMS definitively fail to deliver? Best-effort (M13): a
// missing message id, a transient fetch-delivery error or an uncertain
// descriptor all answer false - only a verified hard failure may steer the
// user to the email fallback. Never called in dev (SMS off = no msg ids).
async function _lastSmsDeliveryFailed(row) {
    if (!smsEnabled() || !row?.provider_msg_id || row.channel === 'email') return false;
    try {
        const d = await smsDelivery(row.provider_msg_id);
        return d.ok === true && isDeliveryFailure(d.deliveryStatusDesc);
    } catch {
        return false; // transient delivery-API failure - proceed with the SMS resend
    }
}

// Cooldown-gated resend (the verify-page button). Rotates the code (we don't
// store plaintext, so a resend is a fresh code) and bumps the backoff counter.
// M13: `email` requests the email channel (address policy per pure
// emailFallbackTarget - typed addresses are captured onto the account on
// authenticated purposes). A plain SMS resend first checks the delivery report
// of the previous send: a DEFINITIVE failure answers { delivery_failed:true }
// WITHOUT rotating or spending a send, so the email fallback is immediately
// usable instead of cooldown-starved behind a rotated clock.
export async function resendOtp(user, { purpose = 'phone_verify', email = null } = {}) {
    let target = null;
    if (email != null) {
        const t = emailFallbackTarget(purpose, { storedEmail: user.email, typedEmail: email });
        if (!t.ok) throw new AuthError(400, 'No email available for this account', { reason: t.reason });
        target = t;
    }
    const existing = await activeOtp(user.id, purpose);
    if (!existing) {
        if (target?.store) await db('users').where('id', user.id).update({ email: target.email });
        return issueOtp(user, target ? { purpose, channel: 'email', email: target.email } : { purpose });
    }
    const nowMs = Date.now();
    const cr = canResend(nowMs, existing.last_sent_at, existing.resend_count, {
        base: effective('OTP_RESEND_BASE_SECONDS'), max: effective('OTP_MAX_RESENDS'),
    });
    if (!cr.ok) {
        throw new AuthError(429, cr.reason === 'max' ? 'Too many resend attempts - try again later' : 'Please wait before resending',
            { retry_after_seconds: cr.retryAfterSeconds, reason: cr.reason });
    }
    if (!target && await _lastSmsDeliveryFailed(existing)) {
        return { sent: false, delivery_failed: true, email_hint: maskEmail(user.email) };
    }
    const code = generateOtp(effective('OTP_LENGTH'), crypto.randomInt);
    const codeHash = hashOtpCode(code, PEPPER());
    const newCount = existing.resend_count + 1;
    // A resend always re-anchors the row to the account's CURRENT phone (and
    // the requested channel) - a stale row target must never receive a code.
    await db('otp_codes').where('id', existing.id).update({
        phone: user.phone,
        channel: target ? 'email' : 'sms',
        email: target ? target.email : null,
        code_hash: codeHash, expires_at: new Date(otpExpiry(nowMs, effective('OTP_TTL_MINUTES'))),
        attempts: 0, resend_count: newCount, last_sent_at: db.fn.now(), provider_msg_id: null,
    });
    if (target?.store) await db('users').where('id', user.id).update({ email: target.email });
    const extra = {
        resend_count: newCount,
        retry_after_seconds: resendCooldownSeconds(newCount, effective('OTP_RESEND_BASE_SECONDS')),
    };
    return target
        ? sendOtpEmail({ rowId: existing.id, codeHash, email: target.email, code }, extra)
        : sendOtpSms({ rowId: existing.id, codeHash, phone: user.phone, code }, extra);
}

// Shared code-check ladder (M13): pending-row, expiry, target and attempt
// guards + the mismatch counter. Returns the row for the caller to CONSUME in
// its own transaction (verify / PIN reset / PIN change each pair consumption
// with their own user update). Throws AuthError on every failure path.
async function _checkOtp(user, { code, purpose }) {
    const existing = await activeOtp(user.id, purpose);
    if (!existing) throw new AuthError(400, 'No verification code pending - request a new one', { reason: 'none' });
    const nowMs = Date.now();
    if (isOtpExpired(existing, nowMs)) throw new AuthError(410, 'Code expired - request a new one', { reason: 'expired' });
    // An SMS code must have been sent to the account's CURRENT phone - a stale
    // row (e.g. a raced change-phone) must never verify a number that received
    // no code. Email rows skip this: the address IS the proof channel there.
    if (existing.channel !== 'email' && existing.phone !== user.phone) {
        throw new AuthError(409, 'Your phone number changed since this code was sent - request a new one', { reason: 'phone_changed' });
    }
    if (existing.attempts >= effective('OTP_MAX_ATTEMPTS')) {
        throw new AuthError(429, 'Too many attempts - request a new code', { reason: 'exhausted' });
    }
    if (existing.code_hash !== hashOtpCode(code, PEPPER())) {
        const { attempts, exhausted } = registerOtpAttempt(existing.attempts, { max: effective('OTP_MAX_ATTEMPTS') });
        await db('otp_codes').where('id', existing.id).update({ attempts });
        throw new AuthError(400, 'Incorrect code', {
            reason: 'mismatch', attempts_left: Math.max(0, effective('OTP_MAX_ATTEMPTS') - attempts), exhausted,
        });
    }
    return existing;
}

// Verify a code and mark the phone verified. Consumes the code (single-use).
// An email-channel code (M13) also completes PHONE verification - it's the
// fallback identity proof when SMS can't reach the number (the M8 admin
// manual-verify is the even-looser precedent).
export async function verifyOtp(user, { code, purpose = 'phone_verify' }) {
    const existing = await _checkOtp(user, { code, purpose });
    await db.transaction(async trx => {
        await trx('otp_codes').where('id', existing.id).update({ consumed_at: trx.fn.now() });
        await trx('users').where('id', user.id).update({ phone_verified: 1 });
    });
    return publicUser(await userById(user.id));
}

// --- Phone change / profile -------------------------------------------------

export async function changePhone(user, { phone, phone_region, phone_code }) {
    if (user.phone_verified) throw new AuthError(403, 'Your phone is already verified');
    const taken = await db('users').where('phone', phone).whereNot('id', user.id).first();
    if (taken) throw new AuthError(409, 'That phone number is already registered');
    // Flood gate BEFORE touching users.phone: a blocked request must leave the
    // account and its active OTP row untouched - a half-applied change would
    // let a later resend SMS the old number while verify flags the new one.
    const existing = await activeOtp(user.id, 'phone_verify');
    const gate = otpGate(existing, phone, Date.now());
    if (gate.action === 'reject') throwOtpRejected(gate);
    await db('users').where('id', user.id).update({ phone, phone_region, phone_code, phone_verified: 0 });
    const updated = await userById(user.id);
    const otp = await issueOtp(updated, { phone });
    return { user: publicUser(updated), otp };
}

// --- Forgot PIN (M13, purpose='pin_reset') ------------------------------------
// Self-service reset for a user locked out of their PIN. Unauthenticated, so
// answers stay GENERIC for unknown/disabled accounts ({ ok:true, sent:false } -
// signup's "already registered" 409 leaks phone existence anyway, but this
// flow must not add a cheaper oracle) and the email fallback may ONLY target
// the account's STORED address (pure emailFallbackTarget - a typed inbox here
// would be an account takeover).
export async function forgotPinStart({ phone, channel = 'sms' }) {
    const user = await userByPhone(phone);
    if (!user || !user.is_active) return { ok: true, sent: false };
    if (channel === 'email') {
        const t = emailFallbackTarget('pin_reset', { storedEmail: user.email });
        if (!t.ok) {
            throw new AuthError(400, 'No email on file for this account - ask an admin for a PIN reset', { reason: t.reason });
        }
        const otp = await issueOtp(user, { purpose: 'pin_reset', channel: 'email', email: t.email });
        return { ok: true, ...otp, email_hint: maskEmail(user.email) };
    }
    // A repeat request whose previous SMS verifiably failed to deliver skips
    // the pointless re-send and steers the client to the email option instead
    // (same no-rotate discipline as resendOtp - the fallback stays usable now).
    const existing = await activeOtp(user.id, 'pin_reset');
    if (existing && await _lastSmsDeliveryFailed(existing)) {
        return { ok: true, sent: false, delivery_failed: true, email_hint: maskEmail(user.email) };
    }
    const otp = await issueOtp(user, { purpose: 'pin_reset' });
    return { ok: true, ...otp };
}

// Complete the reset: code + new PIN -> fresh session (auto sign-in). The old
// PIN is unknown/compromised by premise, so EVERY existing session is revoked
// in the same transaction; the freshly minted one is the only survivor.
// Unknown phones answer the same 400 the no-pending-code path does.
export async function resetPinWithOtp({ phone, code, pin }, meta = {}) {
    const user = await userByPhone(phone);
    if (!user || !user.is_active) {
        throw new AuthError(400, 'No verification code pending - request a new one', { reason: 'none' });
    }
    const existing = await _checkOtp(user, { code, purpose: 'pin_reset' });
    const pin_hash = await hashPinAsync(pin, { pepper: PEPPER() });
    await db.transaction(async trx => {
        await trx('otp_codes').where('id', existing.id).update({ consumed_at: trx.fn.now() });
        await trx('users').where('id', user.id).update({
            pin_hash, pin_attempts: 0, locked_until: null, must_change_pin: 0, last_login_at: trx.fn.now(),
        });
        await trx('sessions').where('user_id', user.id).whereNull('revoked_at').update({ revoked_at: trx.fn.now() });
    });
    const fresh = await userById(user.id);
    const token = await mintSession(fresh, meta);
    return { token, user: publicUser(fresh) };
}

// --- Housekeeping (E3) --------------------------------------------------------
// Purge long-expired sessions and OTP rows - both tables otherwise grow without
// bound. 30 days past expiry keeps recent rows inspectable while the indexed
// expires_at range keeps the DELETEs cheap. Called best-effort from the light
// auto-refresh pass (a failure never fails the refresh).
export async function purgeExpiredAuth() {
    const cutoff = db.raw('NOW() - INTERVAL 30 DAY');
    const sessions = await db('sessions').where('expires_at', '<', cutoff).del();
    const otps = await db('otp_codes').where('expires_at', '<', cutoff).del();
    return { sessions, otps };
}

export async function updateProfile(user, { name, pin, current_pin, otp_code, sms_opt_out }) {
    const patch = {};
    if (name != null) patch.name = name;
    if (sms_opt_out != null) patch.sms_opt_out = sms_opt_out ? 1 : 0;
    let otpRow = null;
    if (pin) {
        if (!(await verifyPinAsync(current_pin, user.pin_hash, { pepper: PEPPER() }))) {
            throw new AuthError(401, 'Your current PIN is incorrect');
        }
        // M13 critical-change auth: the PIN change must also carry a valid
        // confirmation code (purpose='pin_change'; requested via the
        // pin-change-otp route). The current PIN alone no longer suffices -
        // this is what makes a shoulder-surfed PIN + stolen session unable to
        // silently rotate the credential.
        if (!otp_code) throw new AuthError(400, 'Enter the confirmation code we sent you', { reason: 'otp_required' });
        otpRow = await _checkOtp(user, { code: otp_code, purpose: 'pin_change' });
        patch.pin_hash = await hashPinAsync(pin, { pepper: PEPPER() });
        patch.must_change_pin = 0;
    }
    if (Object.keys(patch).length) {
        await db.transaction(async trx => {
            if (otpRow) await trx('otp_codes').where('id', otpRow.id).update({ consumed_at: trx.fn.now() });
            await trx('users').where('id', user.id).update(patch);
        });
    }
    return publicUser(await userById(user.id));
}
