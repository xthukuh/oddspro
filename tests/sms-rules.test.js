// SMS + OTP rules (src/db/sms-rules.js). Pure, offline - phone normalization,
// OTP gen/expiry/reuse, resend backoff, and the Bonga response envelopes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isValidE164, toMsisdn, generateOtp, otpExpiry, isOtpExpired, shouldReuseOtp,
    resendCooldownSeconds, canResend, parseBongaSend, parseBongaBalance,
    parseBongaDelivery, classifyBongaStatus,
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
    const d = parseBongaDelivery({
        status: 222, status_message: 'OK', delivery_status: 'DeliveredToTerminal',
        delivery_status_desc: 'Delivered',
    });
    assert.equal(d.ok, true);
    assert.equal(d.deliveryStatus, 'DeliveredToTerminal');
});

test('classifyBongaStatus: 222 ok, everything else fatal (never retried)', () => {
    assert.equal(classifyBongaStatus(222), 'ok');
    assert.equal(classifyBongaStatus('222'), 'ok');
    assert.equal(classifyBongaStatus(666), 'fatal');
    assert.equal(classifyBongaStatus(0), 'fatal');
});
