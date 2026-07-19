// M14 scheduled maintenance - pure rules (src/db/maintenance-rules.js).
// Offline: window parse (+03:00), state machine w/ past-end auto-expiry,
// total notice render over the closed placeholder set, dismissal signature,
// Retry-After math, and the catalog pattern sources.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_MAINTENANCE_MESSAGE, MAINT_DT_PATTERN, MAINT_MSG_PATTERN,
    parseMaintenanceWindow, maintenanceState, maintenanceStateAt,
    formatMaintenanceDt, renderMaintenanceNotice, windowSignature,
    retryAfterSeconds, maintenanceInfo,
} from '../src/db/maintenance-rules.js';

// 2026-07-19 22:00 EAT / 23:00 EAT as epoch ms (explicit +03:00 anchors).
const START = Date.parse('2026-07-19T22:00:00+03:00');
const END = Date.parse('2026-07-19T23:00:00+03:00');
const WIN = { start: '2026-07-19 22:00', end: '2026-07-19 23:00' };

test('parseMaintenanceWindow decodes EAT wall-clock with an explicit +03:00 offset', () => {
    const w = parseMaintenanceWindow(WIN.start, WIN.end);
    assert.equal(w.startMs, START);
    assert.equal(w.endMs, END);
    assert.equal(w.start, WIN.start);
    // Single-digit hour tolerated (AUTO_FULL_AT parity), padded at parse.
    assert.equal(parseMaintenanceWindow('2026-07-19 6:00', WIN.end).startMs,
        Date.parse('2026-07-19T06:00:00+03:00'));
});

test('parseMaintenanceWindow rejects junk, impossible dates and reversed bounds', () => {
    assert.equal(parseMaintenanceWindow('', WIN.end), null);
    assert.equal(parseMaintenanceWindow('tomorrow', WIN.end), null);
    assert.equal(parseMaintenanceWindow('2026-07-19T22:00', WIN.end), null); // T separator - not the contract
    assert.equal(parseMaintenanceWindow('2026-02-31 10:00', WIN.end), null); // impossible date -> NaN
    assert.equal(parseMaintenanceWindow(WIN.end, WIN.start), null);          // reversed
    assert.equal(parseMaintenanceWindow(WIN.start, WIN.start), null);        // zero-length
});

test('maintenanceState: off / scheduled / active / past-end auto-expiry', () => {
    const cfg = { scheduled: true, ...WIN };
    assert.equal(maintenanceState(cfg, START - 60_000), 'scheduled');
    assert.equal(maintenanceState(cfg, START), 'active');           // inclusive start
    assert.equal(maintenanceState(cfg, END - 1), 'active');
    assert.equal(maintenanceState(cfg, END), 'off');                // auto-expiry, never a stale 503
    assert.equal(maintenanceState(cfg, END + 3_600_000), 'off');
    assert.equal(maintenanceState({ ...cfg, scheduled: false }, START), 'off'); // toggle wins
    assert.equal(maintenanceState({ scheduled: true, start: '', end: '' }, START), 'off'); // no window
    assert.equal(maintenanceState(null, START), 'off');
});

test('maintenanceStateAt (the client ms core) matches the cfg state machine', () => {
    assert.equal(maintenanceStateAt(START, END, START - 1), 'scheduled');
    assert.equal(maintenanceStateAt(START, END, START + 1), 'active');
    assert.equal(maintenanceStateAt(START, END, END), 'off');
    assert.equal(maintenanceStateAt(NaN, END, START), 'off');   // junk cache folds to off
    assert.equal(maintenanceStateAt(END, START, START), 'off'); // reversed folds to off
});

test('renderMaintenanceNotice is total: default on blank, placeholders replaced, unknown stays literal', () => {
    const w = parseMaintenanceWindow(WIN.start, WIN.end);
    const dflt = renderMaintenanceNotice('', w);
    assert.equal(dflt, 'We will have scheduled maintenance downtime from Sun 19 Jul, 22:00 to Sun 19 Jul, 23:00');
    assert.equal(renderMaintenanceNotice(null, w), dflt);
    assert.equal(renderMaintenanceNotice('Back at ${downtime_end}.', w), 'Back at Sun 19 Jul, 23:00.');
    // Unknown placeholder: render never throws in a request path - the save
    // pattern is what rejects it (asserted below).
    assert.equal(renderMaintenanceNotice('Hi ${name}', w), 'Hi ${name}');
    // Null window renders empty values, not 'undefined'.
    assert.equal(renderMaintenanceNotice('From ${downtime_start}!', null), 'From !');
});

test('formatMaintenanceDt: human EAT wall-clock, junk passes through raw', () => {
    assert.equal(formatMaintenanceDt('2026-07-19 22:00'), 'Sun 19 Jul, 22:00');
    assert.equal(formatMaintenanceDt('2026-07-20 6:05'), 'Mon 20 Jul, 06:05');
    assert.equal(formatMaintenanceDt('garbage'), 'garbage');
});

test('windowSignature keys dismissal per window - either bound edited re-surfaces', () => {
    const sig = windowSignature(WIN.start, WIN.end);
    assert.equal(sig, '2026-07-19 22:00|2026-07-19 23:00');
    assert.notEqual(windowSignature(WIN.start, '2026-07-19 23:30'), sig);
    assert.equal(windowSignature(` ${WIN.start} `, WIN.end), sig); // trim-stable
});

test('retryAfterSeconds: ceil seconds to end, clamped at 0', () => {
    assert.equal(retryAfterSeconds(END, END - 90_500), 91);
    assert.equal(retryAfterSeconds(END, END), 0);
    assert.equal(retryAfterSeconds(END, END + 5_000), 0);
});

test('maintenanceInfo ships nulls when off and the full payload otherwise', () => {
    const cfg = { scheduled: true, ...WIN, message: '' };
    assert.deepEqual(maintenanceInfo(cfg, END + 1), {
        state: 'off', start: null, end: null, start_ms: null, end_ms: null, message: null, signature: null,
    });
    const info = maintenanceInfo(cfg, START - 1);
    assert.equal(info.state, 'scheduled');
    assert.equal(info.start_ms, START);
    assert.equal(info.end_ms, END);
    assert.equal(info.signature, windowSignature(WIN.start, WIN.end));
    assert.match(info.message, /^We will have scheduled maintenance/);
    assert.equal(maintenanceInfo(cfg, START).state, 'active');
});

test('catalog pattern sources: datetime + closed-placeholder message', () => {
    const dt = new RegExp(MAINT_DT_PATTERN);
    assert.equal(dt.test(''), true);                    // blank = unset
    assert.equal(dt.test('2026-07-19 22:00'), true);
    assert.equal(dt.test('2026-07-19 6:00'), true);
    assert.equal(dt.test('2026-07-19 25:00'), false);
    assert.equal(dt.test('2026-07-19T22:00'), false);
    assert.equal(dt.test('tomorrow'), false);
    const msg = new RegExp(MAINT_MSG_PATTERN);
    assert.equal(msg.test(''), true);
    assert.equal(msg.test(DEFAULT_MAINTENANCE_MESSAGE), true);
    assert.equal(msg.test('Down ${downtime_start}-${downtime_end}, sorry!'), true);
    assert.equal(msg.test('Costs $5 while down'), true);       // literal $ allowed
    assert.equal(msg.test('Hello ${name}'), false);            // unknown placeholder rejected at save
    assert.equal(msg.test('Bad ${downtime_start'), false);     // unterminated
});
