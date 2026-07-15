// Guest-vs-normal access rules (src/db/access-rules.js). Pure, offline -
// the access descriptor, the guest date ceiling and the row redaction the
// server applies to /api/records for guests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessFromUser, guestDateAllowed, redactRecordForRole } from '../src/db/access-rules.js';

test('accessFromUser: no user = guest, signed-in = full, admin keeps its role', () => {
    assert.deepEqual(accessFromUser(null), { role: 'guest', canFuture: false, fullDetail: false });
    assert.deepEqual(accessFromUser(undefined), { role: 'guest', canFuture: false, fullDetail: false });
    assert.deepEqual(accessFromUser({ id: 1, role: 'normal' }), { role: 'normal', canFuture: true, fullDetail: true });
    assert.deepEqual(accessFromUser({ id: 2, role: 'admin' }), { role: 'admin', canFuture: true, fullDetail: true });
    // Unknown/missing role folds to 'normal' - any real session is full tier
    assert.equal(accessFromUser({ id: 3 }).role, 'normal');
    assert.equal(accessFromUser({ id: 4, role: 'weird' }).canFuture, true);
});

test('guestDateAllowed: past/today yes, future no, all-dates delegated to SQL', () => {
    const today = '2026-07-15';
    assert.equal(guestDateAllowed('2026-07-14', today), true);  // past
    assert.equal(guestDateAllowed('2026-07-15', today), true);  // today (whole day)
    assert.equal(guestDateAllowed('2026-07-16', today), false); // tomorrow
    assert.equal(guestDateAllowed('2027-01-01', today), false); // far future
    assert.equal(guestDateAllowed('all', today), true);         // ceiling applied in SQL
    assert.equal(guestDateAllowed(null, today), true);
    assert.equal(guestDateAllowed('', today), true);
    // Year/month boundaries stay plain string compares (ISO dates sort)
    assert.equal(guestDateAllowed('2025-12-31', '2026-01-01'), true);
    assert.equal(guestDateAllowed('2026-02-01', '2026-01-31'), false);
});

const fullRow = () => ({
    match_id: 9, api_id: 7, provider: 'betpawa', fixture: 'A - B',
    tip_market: 'X2', tip_price: 1.44, tip_confidence: 0.873, tip_outcome: null,
    tip_breakdown: { parts: 2, market_prob: 0.7 },
    tip_skip_reason: null, tip_ai_verdict: 'veto', tip_ai_reason: 'because', tip_ai_review: { checks: [] },
    hot: true, hot_score: 0.61, hot_outcome: null,
    hot_reason: 'ai says', hot_review: { probability: 0.6 }, hot_signals: { gates: [] },
    markets: { '1': 2.1 }, stats: {},
});

test('redactRecordForRole(guest) strips internal reasoning, keeps the tip itself', () => {
    const row = fullRow();
    const out = redactRecordForRole(row, 'guest');
    // stripped: blend breakdown, AI reasons/reviews, hot-pick gate audit
    assert.equal(out.tip_breakdown, null);
    assert.equal(out.tip_ai_reason, null);
    assert.equal(out.tip_ai_review, null);
    assert.equal(out.hot_reason, null);
    assert.equal(out.hot_review, null);
    assert.equal(out.hot_signals, null);
    // kept: the bettable tip, its outcome ledger, the veto flag, odds, stats
    assert.equal(out.tip_market, 'X2');
    assert.equal(out.tip_price, 1.44);
    assert.equal(out.tip_ai_verdict, 'veto');
    assert.equal(out.hot, true);
    assert.deepEqual(out.markets, { '1': 2.1 });
    // exact confidence coarsened to 0.05 buckets (0.873 -> 0.85)
    assert.equal(out.tip_confidence, 0.85);
    // input row untouched (redaction returns a copy)
    assert.equal(row.tip_breakdown.parts, 2);
    assert.equal(row.tip_confidence, 0.873);
});

test('redactRecordForRole: confidence buckets are clean numbers, null stays null', () => {
    assert.equal(redactRecordForRole({ tip_confidence: 0.926 }, 'guest').tip_confidence, 0.95);
    assert.equal(redactRecordForRole({ tip_confidence: 0.9 }, 'guest').tip_confidence, 0.9);
    assert.equal(redactRecordForRole({ tip_confidence: 0.02 }, 'guest').tip_confidence, 0);
    assert.equal(redactRecordForRole({ tip_confidence: null }, 'guest').tip_confidence, null);
    // mysql2 DECIMAL-as-string coerces too
    assert.equal(redactRecordForRole({ tip_confidence: '0.87' }, 'guest').tip_confidence, 0.85);
    // tipless rows pass through without inventing fields
    const bare = redactRecordForRole({ match_id: 1 }, 'guest');
    assert.equal('tip_breakdown' in bare, false);
});

test('redactRecordForRole: full-detail roles and null rows pass through untouched', () => {
    const row = fullRow();
    assert.equal(redactRecordForRole(row, 'normal'), row); // same reference - no copy
    assert.equal(redactRecordForRole(row, 'admin'), row);
    assert.equal(redactRecordForRole(null, 'guest'), null);
});
