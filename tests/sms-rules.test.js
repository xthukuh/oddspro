// SMS + OTP rules (src/db/sms-rules.js). Pure, offline - phone normalization,
// OTP gen/expiry/reuse, resend backoff, and the Bonga response envelopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidE164, toMsisdn, normalizePhone, generateOtp, otpExpiry, isOtpExpired, shouldReuseOtp,
    resendCooldownSeconds, canResend, otpIssueDecision, parseBongaSend, parseBongaBalance,
    parseBongaDelivery, classifyBongaStatus, isCleartextUrl, isDeliveryFailure, otpRowTarget,
} from '../src/db/sms-rules.js';

test('isValidE164 accepts real numbers and rejects junk', () => {
    assert.equal(isValidE164('+254799944004'), true);
    assert.equal(isValidE164('+14155552671'), true);
    assert.equal(isValidE164('0799944004'), false);   // no +
    assert.equal(isValidE164('+0799944004'), false);  // leading 0 after +
    assert.equal(isValidE164('+254 799 944 004'), false); // spaces
    assert.equal(isValidE164(''), false);
    assert.equal(isValidE164(null), false);
});

test('toMsisdn strips the + (Bonga MSISDN form)', () => {
    assert.equal(toMsisdn('+254799944004'), '254799944004');
    assert.throws(() => toMsisdn('0799944004'), /invalid E\.164/);
});

test('normalizePhone: national/local Kenyan forms become E.164 (+254...)', () => {
    // Bare national significant number (what a Kenyan types without the 0).
    assert.equal(normalizePhone('799944004'), '+254799944004');
    // National format with the trunk 0.
    assert.equal(normalizePhone('0799944004'), '+254799944004');
    // Already E.164: passthrough untouched.
    assert.equal(normalizePhone('+254799944004'), '+254799944004');
    // MSISDN form (calling code, no +) round-trips instead of double-prefixing.
    assert.equal(normalizePhone('254799944004'), '+254799944004');
    // 00 international dialing prefix.
    assert.equal(normalizePhone('00254799944004'), '+254799944004');
    // Formatting noise (spaces, dashes, dots, parens) is stripped.
    assert.equal(normalizePhone(' 0712 345-678 '), '+254712345678');
    assert.equal(normalizePhone('(254) 799.944.004'), '+254799944004');
});

test('normalizePhone: invalid input and unknown regions fail safe (null)', () => {
    assert.equal(normalizePhone('abc'), null);
    assert.equal(normalizePhone(''), null);
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone('+0799944004'), null);      // invalid E.164 stays invalid
    assert.equal(normalizePhone('07999'), null);            // too short even prefixed
    // Unknown region: national forms can't be inferred, but explicit
    // international forms (+ / 00) still normalize.
    assert.equal(normalizePhone('799944004', { region: 'ZZ' }), null);
    assert.equal(normalizePhone('+254799944004', { region: 'ZZ' }), '+254799944004');
    assert.equal(normalizePhone('0041446681800', { region: 'ZZ' }), '+41446681800');
});

test('generateOtp makes a fixed-length numeric code, leading zeros kept', () => {
    assert.equal(generateOtp(6, () => 42), '000042');       // padded
    assert.equal(generateOtp(6, () => 987654), '987654');
    assert.equal(generateOtp(4, () => 7), '0007');
    // randomInt is called with the exclusive upper bound 10**len.
    let seen;
    generateOtp(6, max => { seen = max; return 1; });
    assert.equal(seen, 1_000_000);
    assert.throws(() => generateOtp(3, () => 1), /bad OTP length/);
});

test('otp expiry + reuse math', () => {
    const now = 1_000_000_000_000;
    const exp = otpExpiry(now, 10);
    assert.equal(exp, now + 600_000);
    assert.equal(isOtpExpired({ expires_at: exp }, now + 599_000), false);
    assert.equal(isOtpExpired({ expires_at: exp }, now + 601_000), true);
    // reuse only an unconsumed, unexpired code
    assert.equal(shouldReuseOtp({ expires_at: exp, consumed_at: null }, now), true);
    assert.equal(shouldReuseOtp({ expires_at: exp, consumed_at: new Date(now) }, now), false);
    assert.equal(shouldReuseOtp({ expires_at: exp, consumed_at: null }, exp + 1), false);
    assert.equal(shouldReuseOtp(null, now), false);
    // tolerates Date-typed expiry (mysql2 returns Date)
    assert.equal(isOtpExpired({ expires_at: new Date(exp) }, now), false);
});

test('resend backoff grows 60·n: 60, 120, 180', () => {
    assert.deepEqual([0, 1, 2].map(n => resendCooldownSeconds(n, 60)), [60, 120, 180]);
    assert.equal(resendCooldownSeconds(4, 60), 300);
});

test('canResend enforces the cooldown and the max-resends cap', () => {
    const now = 2_000_000_000_000;
    // 30s after a first send (resendCount 0 -> needs 60s): blocked, ~30s left.
    let r = canResend(now, now - 30_000, 0, { base: 60, max: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cooldown');
    assert.equal(r.retryAfterSeconds, 30);
    // 61s later: allowed.
    r = canResend(now, now - 61_000, 0, { base: 60, max: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.retryAfterSeconds, 0);
    // hit the hard cap regardless of elapsed time.
    r = canResend(now, now - 10_000_000, 5, { base: 60, max: 5 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'max');
});

test('otpIssueDecision: fresh user (no active row) sends', () => {
    const now = 3_000_000_000_000;
    assert.deepEqual(otpIssueDecision(null, '+254700000001', now, { base: 60, max: 5 }), { action: 'send' });
});

test('otpIssueDecision: same phone + valid code inside the cooldown reuses (no new SMS)', () => {
    const now = 3_000_000_000_000;
    const row = {
        phone: '+254700000001', consumed_at: null, resend_count: 0,
        last_sent_at: now - 30_000, expires_at: now + 570_000,
    };
    const d = otpIssueDecision(row, '+254700000001', now, { base: 60, max: 5 });
    assert.equal(d.action, 'reuse');
    assert.equal(d.retryAfterSeconds, 30);
});

test('otpIssueDecision: a DIFFERENT phone inside the cooldown is rejected (flood exploit)', () => {
    const now = 3_000_000_000_000;
    const row = {
        phone: '+254700000001', consumed_at: null, resend_count: 0,
        last_sent_at: now - 30_000, expires_at: now + 570_000,
    };
    // The H1 exploit: alternating two numbers must NOT reset the cooldown clock.
    const d = otpIssueDecision(row, '+254700000002', now, { base: 60, max: 5 });
    assert.equal(d.action, 'reject');
    assert.equal(d.reason, 'cooldown');
    assert.equal(d.retryAfterSeconds, 30);
});

test('otpIssueDecision: cooldown elapsed sends again, whatever the phone', () => {
    const now = 3_000_000_000_000;
    const row = {
        phone: '+254700000001', consumed_at: null, resend_count: 1,
        last_sent_at: now - 121_000, expires_at: now + 500_000, // needs 120s, 121 elapsed
    };
    assert.deepEqual(otpIssueDecision(row, '+254700000001', now, { base: 60, max: 5 }), { action: 'send' });
    assert.deepEqual(otpIssueDecision(row, '+254700000002', now, { base: 60, max: 5 }), { action: 'send' });
});

test('otpIssueDecision: the hard resend cap rejects even a same-phone valid code', () => {
    const now = 3_000_000_000_000;
    const row = {
        phone: '+254700000001', consumed_at: null, resend_count: 5,
        last_sent_at: now - 10_000_000, expires_at: now + 500_000, // long past any cooldown
    };
    const d = otpIssueDecision(row, '+254700000001', now, { base: 60, max: 5 });
    assert.equal(d.action, 'reject');
    assert.equal(d.reason, 'max');
});

test('otpIssueDecision: same phone but a dead code inside the cooldown rejects (nothing to reuse)', () => {
    const now = 3_000_000_000_000;
    const expired = {
        phone: '+254700000001', consumed_at: null, resend_count: 3,
        last_sent_at: now - 30_000, expires_at: now - 1_000, // needs 240s cooldown, code already expired
    };
    const d = otpIssueDecision(expired, '+254700000001', now, { base: 60, max: 5 });
    assert.equal(d.action, 'reject');
    assert.equal(d.reason, 'cooldown');
});

test('parseBongaSend maps a 222 success and a 666 error', () => {
    const ok = parseBongaSend({ status: 222, status_message: 'Success', unique_id: 'abc123', credits: 4980 });
    assert.deepEqual(ok, { ok: true, status: 222, message: 'Success', messageId: 'abc123', credits: 4980 });
    // status may arrive as a string; unique_id numeric.
    const err = parseBongaSend({ status: '666', status_message: 'Invalid key' });
    assert.equal(err.ok, false);
    assert.equal(err.status, 666);
    assert.equal(err.messageId, null);
});

test('parseBongaBalance + parseBongaDelivery', () => {
    const b = parseBongaBalance({
        status: 222, status_message: 'OK', client_name: 'Intent',
        sms_credits: '4980', sms_threshold: '100', api_client_id: '1461',
    });
    assert.equal(b.ok, true);
    assert.equal(b.credits, 4980);
    assert.equal(b.clientName, 'Intent');
    // The exact live envelope captured 2026-07-19 (no delivery_status field).
    const d = parseBongaDelivery({
        status: 222, status_message: 'fetched delivery status', unique_id: '597538152',
        delivery_status_desc: 'DeliveredToTerminal',
        date_received: '2026-07-19 01:07:24', correlator: null, msisdn: '254724212034',
    });
    assert.equal(d.ok, true);
    assert.equal(d.deliveryStatusDesc, 'DeliveredToTerminal');
    assert.equal(d.dateReceived, '2026-07-19 01:07:24');
    assert.equal(d.msisdn, '254724212034');
});

test('send/delivery envelopes are tolerant - shape drift folds to ok:false, never throws', () => {
    // A provider outage page / HTML body / empty object must not throw in the
    // OTP request path (a thrown ZodError used to masquerade as "couldn't send").
    const junk = parseBongaSend('<html>503 upstream</html>');
    assert.equal(junk.ok, false);
    assert.equal(junk.status, null);
    assert.match(junk.message, /^unparseable send response:/);
    const empty = parseBongaSend({});
    assert.equal(empty.ok, false);
    assert.equal(empty.messageId, null);
    const dJunk = parseBongaDelivery({ nonsense: true });
    assert.equal(dJunk.ok, false);
    assert.match(dJunk.message, /^unparseable delivery response:/);
});

test('classifyBongaStatus: 222 ok, everything else fatal (never retried)', () => {
    assert.equal(classifyBongaStatus(222), 'ok');
    assert.equal(classifyBongaStatus('222'), 'ok');
    assert.equal(classifyBongaStatus(666), 'fatal');
    assert.equal(classifyBongaStatus(0), 'fatal');
});

test('isCleartextUrl flags non-loopback http:// (credential-in-cleartext guard)', () => {
    assert.equal(isCleartextUrl('http://167.172.14.50:4002/v1/send-sms'), true);  // the Bonga send host
    assert.equal(isCleartextUrl('http://sms.example.com/send'), true);
    assert.equal(isCleartextUrl('https://app.bongasms.co.ke/api/send'), false);   // TLS
    assert.equal(isCleartextUrl('http://localhost:8080/proxy'), false);            // local proxy exempt
    assert.equal(isCleartextUrl('http://127.0.0.1:8080/proxy'), false);
    assert.equal(isCleartextUrl(''), false);
    assert.equal(isCleartextUrl(null), false);
    // C4: bracketed IPv6 / userinfo hosts parse via WHATWG URL now
    assert.equal(isCleartextUrl('http://[::1]:4002/v1/send-sms'), false);          // IPv6 loopback proxy
    assert.equal(isCleartextUrl('http://user:pass@127.0.0.1:8080/proxy'), false);  // userinfo, loopback
    assert.equal(isCleartextUrl('http://user:pass@sms.example.com/send'), true);   // userinfo, remote
    assert.equal(isCleartextUrl('http://[2001:db8::1]/send'), true);               // IPv6 remote
});

// --- M13: delivery-failure classifier + channel-aware OTP rows ---------------

test('isDeliveryFailure: only DEFINITIVE failure descriptors count', () => {
    // Definitive - the number cannot receive this message; offer the email fallback.
    assert.equal(isDeliveryFailure('DeliveryImpossible'), true);
    assert.equal(isDeliveryFailure('SenderName Blacklisted'), true);
    assert.equal(isDeliveryFailure('Rejected'), true);
    assert.equal(isDeliveryFailure('MessageExpired'), true);
    assert.equal(isDeliveryFailure('Undeliverable'), true);
    // Success / transient / unknown - never push the user off SMS on these.
    assert.equal(isDeliveryFailure('DeliveredToTerminal'), false); // verified live 2026-07-19
    assert.equal(isDeliveryFailure('DeliveredToNetwork'), false);
    assert.equal(isDeliveryFailure('AbsentSubscriber'), false);    // phone off = transient
    assert.equal(isDeliveryFailure('DeliveryUncertain'), false);
    assert.equal(isDeliveryFailure(''), false);
    assert.equal(isDeliveryFailure(null), false);
    assert.equal(isDeliveryFailure(undefined), false);
});

test('otpRowTarget: sms rows target the phone, email rows the address', () => {
    assert.equal(otpRowTarget({ channel: 'sms', phone: '+254700000001', email: null }), '+254700000001');
    assert.equal(otpRowTarget({ channel: 'email', phone: '+254700000001', email: 'a@b.co' }), 'a@b.co');
    // Legacy rows predate the channel column - they were SMS by construction.
    assert.equal(otpRowTarget({ phone: '+254700000001' }), '+254700000001');
    assert.equal(otpRowTarget(null), null);
});

test('otpIssueDecision: email-channel row reuses for the same address, rejects a different target', () => {
    const now = Date.now();
    const row = {
        channel: 'email', email: 'a@b.co', phone: '+254700000001',
        consumed_at: null, expires_at: now + 300_000,
        last_sent_at: now - 10_000, resend_count: 0,
    };
    // Same email inside the cooldown: the emailed code still works - reuse.
    assert.equal(otpIssueDecision(row, 'a@b.co', now, { base: 60, max: 5 }).action, 'reuse');
    // A different target (the phone, or another email) inside the cooldown: reject.
    assert.equal(otpIssueDecision(row, '+254700000001', now, { base: 60, max: 5 }).action, 'reject');
    assert.equal(otpIssueDecision(row, 'x@y.z', now, { base: 60, max: 5 }).action, 'reject');
});
