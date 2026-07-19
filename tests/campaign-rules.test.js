// SMS template + campaign rules (src/db/campaign-rules.js) - M9, offline.
// Template placeholder contract, GSM/UCS-2 segment counting, cost estimate,
// the audience discriminated union (with its NON-NEGOTIABLE opt-out
// exclusion), the batch plan, the send-failure breaker and the campaign
// status machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    TEMPLATE_BODY_PATTERN, MESSAGE_PLACEHOLDER, DEFAULT_AUTH_TEMPLATE,
    templateBodyIssue, renderTemplate,
    smsSegments, costEstimate,
    audienceSchema, audienceCriteria, describeAudience,
    campaignBatchPlan, sendBreakerOpen, countDriftVerdict,
    CAMPAIGN_STATUSES, canTransition, campaignIsTerminal, recipientTotals,
    templateSchema, campaignCreateSchema, campaignSendSchema,
} from '../src/db/campaign-rules.js';

// --- template body validation ------------------------------------------------

test('templateBodyIssue accepts a body carrying ${message}', () => {
    assert.equal(templateBodyIssue('[OP] ${message}'), null);
    assert.equal(templateBodyIssue('Hi ${name}, ${message} - Oddspro'), null);
    assert.equal(templateBodyIssue('${message}'), null);
});

test('templateBodyIssue requires the ${message} placeholder', () => {
    assert.match(templateBodyIssue('Just a flat announcement'), /\$\{message\}/);
    assert.match(templateBodyIssue('Hi ${name}'), /\$\{message\}/);
});

test('templateBodyIssue rejects unknown placeholders but allows a literal $', () => {
    assert.match(templateBodyIssue('${message} costs ${price}'), /price/);
    assert.match(templateBodyIssue('${message} ${}'), /placeholder/i);
    assert.equal(templateBodyIssue('${message} for $5 only'), null);
});

test('templateBodyIssue rejects blank and over-length bodies', () => {
    assert.match(templateBodyIssue(''), /empty|required/i);
    assert.match(templateBodyIssue('   '), /empty|required/i);
    assert.match(templateBodyIssue(`\${message}${'x'.repeat(480)}`), /480/);
});

test('TEMPLATE_BODY_PATTERN agrees with templateBodyIssue on placeholder legality', () => {
    const rx = new RegExp(TEMPLATE_BODY_PATTERN);
    assert.ok(rx.test('[OP] ${message}'));
    assert.ok(rx.test('Hi ${name}: ${message}'));
    assert.ok(rx.test('costs $5'));
    assert.ok(!rx.test('${message} ${price}'));
});

test('DEFAULT_AUTH_TEMPLATE is a valid body carrying the message placeholder', () => {
    assert.equal(templateBodyIssue(DEFAULT_AUTH_TEMPLATE), null);
    assert.ok(DEFAULT_AUTH_TEMPLATE.includes(MESSAGE_PLACEHOLDER));
});

// --- rendering ---------------------------------------------------------------

test('renderTemplate substitutes message and name', () => {
    assert.equal(renderTemplate('[OP] ${message}', { message: 'Hello' }), '[OP] Hello');
    assert.equal(renderTemplate('Hi ${name}, ${message}', { message: 'go', name: 'Ada' }), 'Hi Ada, go');
});

test('renderTemplate is TOTAL: blank template, missing vars and unknown placeholders never throw', () => {
    // A missing name renders empty (and collapses the double space it leaves).
    assert.equal(renderTemplate('Hi ${name}, ${message}', { message: 'go' }), 'Hi, go');
    assert.equal(renderTemplate('Hi ${name}, ${message}', { message: 'go', name: '  ' }), 'Hi, go');
    // Unknown placeholders stay literal - the save-time pattern already rejected
    // them; render sits in a request path and must not throw.
    assert.equal(renderTemplate('${message} ${nope}', { message: 'x' }), 'x ${nope}');
    assert.equal(renderTemplate('', { message: 'x' }), 'x');
    assert.equal(renderTemplate(null, { message: 'x' }), 'x');
    assert.equal(renderTemplate('${message}', {}), '');
});

test('renderTemplate does not re-expand a placeholder that came from the message', () => {
    // A user-authored message containing ${name} must stay literal - otherwise
    // campaign text could reach into the template variable space.
    assert.equal(renderTemplate('[OP] ${message}', { message: 'hi ${name}', name: 'Ada' }), '[OP] hi ${name}');
});

// --- segments ----------------------------------------------------------------

test('smsSegments counts GSM-7 at 160 / 153', () => {
    assert.equal(smsSegments(''), 1);
    assert.equal(smsSegments('a'.repeat(160)), 1);
    assert.equal(smsSegments('a'.repeat(161)), 2);
    assert.equal(smsSegments('a'.repeat(306)), 2);
    assert.equal(smsSegments('a'.repeat(307)), 3);
});

test('smsSegments charges GSM extension characters as two septets', () => {
    // '€' and '[' live in the GSM escape table: 1 char, 2 septets.
    assert.equal(smsSegments('€'.repeat(80)), 1);
    assert.equal(smsSegments('€'.repeat(81)), 2);
    assert.equal(smsSegments(`${'a'.repeat(159)}[`), 2);
});

test('smsSegments falls to UCS-2 70 / 67 on any non-GSM character', () => {
    // Accented Latin (é, à, ñ) IS in the GSM alphabet - it must NOT downgrade
    // an otherwise cheap message to UCS-2.
    assert.equal(smsSegments('é'.repeat(160)), 1);
    // '☺' is not, so a single one halves the whole message's capacity.
    assert.equal(smsSegments('☺'), 1);
    assert.equal(smsSegments(`☺${'a'.repeat(69)}`), 1);
    assert.equal(smsSegments(`☺${'a'.repeat(70)}`), 2);
    assert.equal(smsSegments(`☺${'a'.repeat(133)}`), 2);
    assert.equal(smsSegments(`☺${'a'.repeat(134)}`), 3);
});

test('smsSegments counts an astral emoji as two UCS-2 code units', () => {
    assert.equal(smsSegments('🎉'.repeat(35)), 1);
    assert.equal(smsSegments('🎉'.repeat(36)), 2);
});

test('costEstimate multiplies recipients by segments', () => {
    assert.equal(costEstimate(10, 1), 10);
    assert.equal(costEstimate(10, 3), 30);
    assert.equal(costEstimate(0, 5), 0);
    assert.equal(costEstimate(-1, 5), 0);
});

// --- audience ----------------------------------------------------------------

test('audienceSchema parses filter mode with defaults', () => {
    const a = audienceSchema.parse({ mode: 'filter' });
    assert.equal(a.mode, 'filter');
    assert.equal(a.verified, 'verified');   // default: only reachable, consented numbers
    assert.equal(a.active, 'active');
    assert.equal(a.role, 'any');
    assert.equal(a.engagement, 'any');
});

test('audienceSchema parses selection mode and requires at least one id', () => {
    const a = audienceSchema.parse({ mode: 'selection', user_ids: [3, 9] });
    assert.deepEqual(a.user_ids, [3, 9]);
    assert.throws(() => audienceSchema.parse({ mode: 'selection', user_ids: [] }));
    assert.throws(() => audienceSchema.parse({ mode: 'selection' }));
});

test('audienceSchema rejects unknown modes and unknown keys', () => {
    assert.throws(() => audienceSchema.parse({ mode: 'everyone' }));
    assert.throws(() => audienceSchema.parse({ mode: 'filter', sneaky: 1 }));
    assert.throws(() => audienceSchema.parse({ mode: 'filter', engagement: 'sometimes' }));
});

test('audienceCriteria ALWAYS excludes opt-out, in both modes', () => {
    assert.equal(audienceCriteria(audienceSchema.parse({ mode: 'filter' })).excludeOptOut, true);
    assert.equal(audienceCriteria(audienceSchema.parse({ mode: 'selection', user_ids: [1] })).excludeOptOut, true);
    // ...and a caller cannot smuggle it off through the audience payload.
    assert.throws(() => audienceSchema.parse({ mode: 'filter', excludeOptOut: false }));
    assert.throws(() => audienceSchema.parse({ mode: 'selection', user_ids: [1], excludeOptOut: false }));
});

test('audienceCriteria maps core filters to tri-state criteria', () => {
    const c = audienceCriteria(audienceSchema.parse({
        mode: 'filter', verified: 'unverified', active: 'any', role: 'normal',
    }));
    assert.equal(c.phoneVerified, false);
    assert.equal(c.isActive, null);       // null = don't constrain
    assert.equal(c.role, 'normal');
    assert.equal(c.userIds, null);
});

test('audienceCriteria turns engagement into last_login_at bounds', () => {
    const now = Date.parse('2026-07-19T12:00:00+03:00');
    const days = 30 * 86_400_000;
    const recent = audienceCriteria(audienceSchema.parse({
        mode: 'filter', engagement: 'recent', engagement_days: 30,
    }), now);
    assert.equal(recent.lastLoginAfter, now - days);
    assert.equal(recent.neverLoggedIn, false);

    const dormant = audienceCriteria(audienceSchema.parse({
        mode: 'filter', engagement: 'dormant', engagement_days: 30,
    }), now);
    assert.equal(dormant.lastLoginBefore, now - days);
    // A never-logged-in account is NOT dormant here: it belongs to the
    // 'never' segment, so win-back and onboarding stay separately targetable.
    assert.equal(dormant.neverLoggedIn, false);
    assert.equal(dormant.requireEverLoggedIn, true);

    const never = audienceCriteria(audienceSchema.parse({ mode: 'filter', engagement: 'never' }), now);
    assert.equal(never.neverLoggedIn, true);
    assert.equal(never.lastLoginAfter, null);
    assert.equal(never.lastLoginBefore, null);
});

test('audienceCriteria maps the signup cohort window', () => {
    const c = audienceCriteria(audienceSchema.parse({
        mode: 'filter', signed_up_after: '2026-07-01', signed_up_before: '2026-07-15',
    }));
    assert.equal(c.createdAfter, Date.parse('2026-07-01T00:00:00+03:00'));
    // Exclusive upper bound = the whole 'before' day is EXCLUDED; the UI labels
    // it "before", so an admin picking 07-15 does not silently include 07-15.
    assert.equal(c.createdBefore, Date.parse('2026-07-15T00:00:00+03:00'));
});

test('audienceSchema rejects malformed cohort dates and out-of-range engagement windows', () => {
    assert.throws(() => audienceSchema.parse({ mode: 'filter', signed_up_after: '19-07-2026' }));
    assert.throws(() => audienceSchema.parse({ mode: 'filter', engagement_days: 0 }));
    assert.throws(() => audienceSchema.parse({ mode: 'filter', engagement_days: 4000 }));
});

test('audienceCriteria in selection mode carries ids and drops filter constraints', () => {
    const c = audienceCriteria(audienceSchema.parse({ mode: 'selection', user_ids: [4, 4, 7] }));
    assert.deepEqual(c.userIds, [4, 7]);     // de-duplicated
    assert.equal(c.phoneVerified, null);
    assert.equal(c.isActive, null);
    assert.equal(c.excludeOptOut, true);     // still non-negotiable
});

test('describeAudience renders a human summary for the confirm dialog', () => {
    assert.match(describeAudience(audienceSchema.parse({ mode: 'selection', user_ids: [1, 2] })), /2 selected/i);
    assert.match(describeAudience(audienceSchema.parse({ mode: 'filter' })), /verified/i);
});

// --- batching ----------------------------------------------------------------

test('campaignBatchPlan splits recipients into paced batches', () => {
    const plan = campaignBatchPlan(45, { size: 20, delayMs: 2000 });
    assert.equal(plan.batches, 3);
    assert.equal(plan.size, 20);
    // Delay happens BETWEEN batches, not after the last one.
    assert.equal(plan.delayMs, 2000);
    assert.equal(plan.estimatedMs, 2 * 2000);
});

test('campaignBatchPlan handles empty and single-batch runs', () => {
    assert.deepEqual(campaignBatchPlan(0, { size: 20, delayMs: 2000 }).batches, 0);
    assert.equal(campaignBatchPlan(0, { size: 20, delayMs: 2000 }).estimatedMs, 0);
    assert.equal(campaignBatchPlan(20, { size: 20, delayMs: 2000 }).batches, 1);
    assert.equal(campaignBatchPlan(20, { size: 20, delayMs: 2000 }).estimatedMs, 0);
});

test('campaignBatchPlan clamps junk knobs to safe values', () => {
    assert.equal(campaignBatchPlan(10, { size: 0, delayMs: 2000 }).size, 1);
    assert.equal(campaignBatchPlan(10, { size: -5, delayMs: -1 }).delayMs, 0);
    assert.equal(campaignBatchPlan(10, {}).size > 0, true);
});

// --- failure breaker ---------------------------------------------------------

test('sendBreakerOpen trips only on sustained consecutive failures', () => {
    assert.equal(sendBreakerOpen({ consecutiveFailures: 0, sent: 0, failed: 0 }), false);
    assert.equal(sendBreakerOpen({ consecutiveFailures: 4, sent: 0, failed: 4 }), false);
    assert.equal(sendBreakerOpen({ consecutiveFailures: 5, sent: 0, failed: 5 }), true);
});

test('sendBreakerOpen resets with any success (a flaky number is not an outage)', () => {
    assert.equal(sendBreakerOpen({ consecutiveFailures: 0, sent: 10, failed: 9 }), false);
});

// --- status machine ----------------------------------------------------------

test('CAMPAIGN_STATUSES covers the lifecycle', () => {
    for (const s of ['draft', 'sending', 'completed', 'cancelled', 'failed']) {
        assert.ok(CAMPAIGN_STATUSES.includes(s), `${s} missing`);
    }
});

test('canTransition allows the real lifecycle and blocks the rest', () => {
    assert.ok(canTransition('draft', 'sending'));
    assert.ok(canTransition('draft', 'cancelled'));
    assert.ok(canTransition('sending', 'completed'));
    assert.ok(canTransition('sending', 'cancelled'));
    assert.ok(canTransition('sending', 'failed'));
    // A finished campaign is FROZEN: re-sending would double-charge recipients.
    assert.ok(!canTransition('completed', 'sending'));
    assert.ok(!canTransition('cancelled', 'sending'));
    assert.ok(!canTransition('failed', 'sending'));
    assert.ok(!canTransition('draft', 'completed'));
    assert.ok(!canTransition('sending', 'draft'));
    assert.ok(!canTransition('nonsense', 'sending'));
});

test('campaignIsTerminal marks the frozen states', () => {
    assert.equal(campaignIsTerminal('completed'), true);
    assert.equal(campaignIsTerminal('cancelled'), true);
    assert.equal(campaignIsTerminal('failed'), true);
    assert.equal(campaignIsTerminal('draft'), false);
    assert.equal(campaignIsTerminal('sending'), false);
});

test('recipientTotals folds the ledger into counters', () => {
    const t = recipientTotals([
        { status: 'sent' }, { status: 'sent' }, { status: 'failed' }, { status: 'pending' },
    ]);
    assert.deepEqual(t, { total: 4, sent: 2, failed: 1, pending: 1 });
});

// --- request envelopes -------------------------------------------------------

test('templateSchema validates name + body together', () => {
    assert.deepEqual(templateSchema.parse({ name: 'Promo', body: '[OP] ${message}' }),
        { name: 'Promo', body: '[OP] ${message}', is_auth_default: false });
    assert.throws(() => templateSchema.parse({ name: '', body: '${message}' }));
    assert.throws(() => templateSchema.parse({ name: 'Promo', body: 'no placeholder' }));
    assert.throws(() => templateSchema.parse({ name: 'Promo', body: '${message} ${bad}' }));
});

test('campaignCreateSchema requires a name, message and audience', () => {
    const c = campaignCreateSchema.parse({
        name: 'Launch', message: 'We are live', audience: { mode: 'filter' },
    });
    assert.equal(c.template_id, null);
    assert.equal(c.audience.mode, 'filter');
    assert.throws(() => campaignCreateSchema.parse({ name: 'x', message: '', audience: { mode: 'filter' } }));
    assert.throws(() => campaignCreateSchema.parse({ name: 'x', message: 'y' }));
});

test('campaignSendSchema demands the typed confirmation and an expected count', () => {
    assert.deepEqual(campaignSendSchema.parse({ confirm: 'SEND', expected_count: 12 }),
        { confirm: 'SEND', expected_count: 12 });
    assert.throws(() => campaignSendSchema.parse({ confirm: 'send', expected_count: 12 }));
    assert.throws(() => campaignSendSchema.parse({ confirm: 'SEND' }));
    assert.throws(() => campaignSendSchema.parse({ expected_count: 12 }));
});

// --- audience drift between preview and send ---------------------------------

test('countDriftVerdict sends when the count is unchanged', () => {
    assert.deepEqual(countDriftVerdict(12, 12), { verdict: 'send' });
    assert.deepEqual(countDriftVerdict(0, 0), { verdict: 'send' });
});

test('countDriftVerdict sends on shrink - the send stays a subset of what was approved', () => {
    // Opt-out / disable / un-verify between preview and confirm: fewer people,
    // all of them already approved.
    assert.deepEqual(countDriftVerdict(50, 49), { verdict: 'send' });
    assert.deepEqual(countDriftVerdict(500, 3), { verdict: 'send' });
    assert.deepEqual(countDriftVerdict(7, 0), { verdict: 'send' });
});

test('countDriftVerdict refuses ANY growth with a human reason naming both counts', () => {
    const v = countDriftVerdict(12, 13);
    assert.equal(v.verdict, 'refuse');
    assert.match(v.reason, /grew from 12 to 13 recipients/);
    // A single new signup is enough - the extra recipient was never previewed.
    assert.equal(countDriftVerdict(0, 1).verdict, 'refuse');
    assert.match(countDriftVerdict(0, 1).reason, /to 1 recipient since/);
});

test('countDriftVerdict is total - junk coerces instead of throwing', () => {
    // `actual` is a live server count, but `expected` rides in from the client.
    assert.deepEqual(countDriftVerdict(undefined, 0), { verdict: 'send' });
    assert.deepEqual(countDriftVerdict(null, 0), { verdict: 'send' });
    assert.deepEqual(countDriftVerdict('nonsense', 0), { verdict: 'send' });
    assert.deepEqual(countDriftVerdict(-5, 0), { verdict: 'send' });
    assert.equal(countDriftVerdict('nonsense', 4).verdict, 'refuse');
    assert.deepEqual(countDriftVerdict(9.7, 9.2), { verdict: 'send' });
});
