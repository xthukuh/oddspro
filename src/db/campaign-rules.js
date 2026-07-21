// Pure SMS template + campaign rules (M9; zod-only, zero other imports,
// offline-testable). Owns the whole broadcast decision surface: the template
// placeholder contract, GSM/UCS-2 segment counting (what a send actually
// COSTS), the audience discriminated union, batch pacing, the send-failure
// breaker and the campaign status machine. src/campaigns.js is the thin knex
// orchestration over these - the same split as admin-rules/admin-users.
//
// Consent note: `excludeOptOut` is emitted unconditionally by audienceCriteria
// and there is no schema key that can turn it off (spec decision 9). A caller
// cannot broadcast to a user who opted out, by construction rather than by
// remembering to. Transactional OTP sends don't come through here at all - a
// user who requested a login code asked for that one message.
import { z } from 'zod';

// --- Template placeholder contract -------------------------------------------
// Closed placeholder set, exactly the M14 maintenance-notice discipline:
// unknown `${...}` is rejected AT SAVE by the pattern below, so renderTemplate
// can be TOTAL and never throw inside a request path. A literal non-brace `$`
// stays legal (prices: "$5").
//
// `${name}` was ADVERTISED here and in the admin editor but never supplied by
// any caller: the campaign message is rendered and FROZEN at creation, before
// a single recipient is known, and segment count / cost estimate are computed
// from that one frozen string. So a personalized template shipped as "Hi ,"
// to the entire audience. Per-recipient rendering is a real feature (it would
// make the cost estimate a range rather than a number); advertising a
// placeholder that cannot work is not. Removed rather than faked.
export const MESSAGE_PLACEHOLDER = '${message}';
export const TEMPLATE_PLACEHOLDERS = ['message'];
export const TEMPLATE_MAX_LENGTH = 480;   // 3 GSM segments' worth of headroom
export const TEMPLATE_BODY_PATTERN = '^(?:[^$]|\\$(?!\\{)|\\$\\{message\\})*$';
export const DEFAULT_AUTH_TEMPLATE = '[OP] ${message}';

const PLACEHOLDER_RX = /\$\{([^}]*)\}/g;

// First problem with a template body, or null when it is valid. Returns a
// HUMAN string (it reaches the admin editor verbatim) rather than a code.
export function templateBodyIssue(body) {
    const s = String(body ?? '');
    if (!s.trim()) return 'Template body is required (it cannot be empty)';
    if (s.length > TEMPLATE_MAX_LENGTH) {
        return `Template body is ${s.length} characters - the limit is ${TEMPLATE_MAX_LENGTH}`;
    }
    for (const [, key] of s.matchAll(PLACEHOLDER_RX)) {
        if (!TEMPLATE_PLACEHOLDERS.includes(key)) {
            return `Unknown placeholder \${${key}} - only \${message} is allowed`;
        }
    }
    if (!s.includes(MESSAGE_PLACEHOLDER)) {
        return 'Template body must contain the ${message} placeholder';
    }
    return null;
}

// Render a template. TOTAL by design (the save-time validation above is the
// strict gate): a blank template falls back to the bare message, absent vars
// render empty, and an unknown placeholder stays literal.
//
// The substitution is ONE pass over the template, so a placeholder that
// appears inside the substituted VALUES is never re-expanded - campaign text
// containing "${name}" stays literal instead of reaching into the template
// variable space.
// The cosmetic whitespace/punctuation tidy that used to live here existed only
// to repair the gap an empty ${name} left ("Hi , go"). With that placeholder
// gone it had no job left but rewriting admin-authored text - it would turn a
// deliberate "Kickoff 20 : 00" into "Kickoff 20: 00". Removed with its cause,
// so what an admin types is what recipients receive.
export function renderTemplate(template, vars = {}) {
    const t = String(template ?? '').trim() || MESSAGE_PLACEHOLDER;
    const message = String(vars.message ?? '').trim();
    return t.replace(/\$\{message\}/g, () => message).trim();
}

// --- Segment counting --------------------------------------------------------
// What the operator is actually billed for. GSM 03.38 text packs 7 bits per
// character: 160 in a single message, 153 per part once concatenated (the UDH
// header eats 7 septets). Anything outside the alphabet forces UCS-2: 70 code
// units single, 67 concatenated. Characters in the GSM ESCAPE table cost two
// septets each - the classic "why did my 158-character message cost double"
// surprise, so they are counted properly rather than approximated.
const GSM_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡'
    + 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '\f^{}\\[~]|€';
const GSM_BASIC_SET = new Set(GSM_BASIC);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED);

export const SEGMENT_LIMITS = {
    gsm: { single: 160, multi: 153 },
    ucs2: { single: 70, multi: 67 },
};

// Septet cost of `text` in GSM-7, or null when a character forces UCS-2.
function _gsmSeptets(text) {
    let septets = 0;
    for (const ch of text) {                 // code points: an astral char exits here
        if (GSM_BASIC_SET.has(ch)) septets += 1;
        else if (GSM_EXTENDED_SET.has(ch)) septets += 2;
        else return null;
    }
    return septets;
}

// Billable segments for the RENDERED text (never the template - the whole
// point is what goes on the wire). An empty message is still one segment.
export function smsSegments(text) {
    const s = String(text ?? '');
    const septets = _gsmSeptets(s);
    const { single, multi } = septets == null ? SEGMENT_LIMITS.ucs2 : SEGMENT_LIMITS.gsm;
    // UCS-2 bills per UTF-16 CODE UNIT, so an emoji outside the BMP costs two.
    const units = septets == null ? s.length : septets;
    if (units <= single) return 1;
    return Math.ceil(units / multi);
}

// Provider credits a campaign will consume: one credit per segment per
// recipient. An ESTIMATE - the audience can drift before the send (see the
// re-count guard in src/campaigns.js).
export function costEstimate(recipients, segments) {
    const r = Math.max(0, Math.floor(Number(recipients) || 0));
    const s = Math.max(1, Math.floor(Number(segments) || 1));
    return r * s;
}

// --- Audience ----------------------------------------------------------------
// Two modes (spec decision 9): a declarative FILTER, or an explicit SELECTION
// handed over from the Users section's multi-select. Both are `.strict()`, so
// an unknown key - notably any attempt to pass `excludeOptOut` - is a parse
// error rather than a silently ignored field.
const COHORT_DATE = /^\d{4}-\d{2}-\d{2}$/;
const _cohortDate = z.string().regex(COHORT_DATE, 'expected YYYY-MM-DD').nullable().optional().default(null);

export const audienceFilterSchema = z.object({
    mode: z.literal('filter'),
    // Tri-state: 'any' means "don't constrain", never "false".
    verified: z.enum(['any', 'verified', 'unverified']).default('verified'),
    active: z.enum(['any', 'active', 'inactive']).default('active'),
    role: z.enum(['any', 'normal', 'admin']).default('any'),
    // Engagement recency, measured on last_login_at.
    engagement: z.enum(['any', 'recent', 'dormant', 'never']).default('any'),
    engagement_days: z.coerce.number().int().min(1).max(365).default(30),
    // Signup cohort window (EAT calendar dates).
    signed_up_after: _cohortDate,
    signed_up_before: _cohortDate,
}).strict();

export const audienceSelectionSchema = z.object({
    mode: z.literal('selection'),
    user_ids: z.array(z.coerce.number().int().positive()).min(1).max(1000),
}).strict();

export const audienceSchema = z.discriminatedUnion('mode', [audienceFilterSchema, audienceSelectionSchema]);

const _triBool = (v, yes, no) => (v === yes ? true : (v === no ? false : null));
// EAT midnight for a cohort date; the pinned +03:00 session makes this the
// same instant the DB compares against.
const _eatMs = d => (d ? Date.parse(`${d}T00:00:00+03:00`) : null);

// Normalize a parsed audience into the criteria object that src/campaigns.js
// translates into EXACTLY ONE knex where-chain. Keeping this as data (rather
// than a JS predicate plus a separate SQL builder) is what prevents the
// preview count from drifting away from who actually gets messaged.
//
// `nowMs` is injected so engagement windows are testable and so a long-running
// job keeps the bounds it started with.
export function audienceCriteria(audience, nowMs = Date.now()) {
    const base = {
        excludeOptOut: true,       // NON-NEGOTIABLE - see the module header
        userIds: null,
        phoneVerified: null,
        isActive: null,
        role: null,
        lastLoginAfter: null,
        lastLoginBefore: null,
        neverLoggedIn: false,
        requireEverLoggedIn: false,
        createdAfter: null,
        createdBefore: null,
    };
    if (audience.mode === 'selection') {
        // An admin who hand-picked these users has already made the
        // verified/active judgement; only consent still overrides them.
        return { ...base, userIds: [...new Set(audience.user_ids)] };
    }

    const windowMs = audience.engagement_days * 86_400_000;
    const c = {
        ...base,
        phoneVerified: _triBool(audience.verified, 'verified', 'unverified'),
        isActive: _triBool(audience.active, 'active', 'inactive'),
        role: audience.role === 'any' ? null : audience.role,
        createdAfter: _eatMs(audience.signed_up_after),
        // Exclusive upper bound: the UI says "before", so the chosen day itself
        // is excluded rather than half-included.
        createdBefore: _eatMs(audience.signed_up_before),
    };
    if (audience.engagement === 'recent') {
        c.lastLoginAfter = nowMs - windowMs;
    } else if (audience.engagement === 'dormant') {
        c.lastLoginBefore = nowMs - windowMs;
        // A never-logged-in account is NOT dormant: it has its own segment, so
        // win-back and onboarding stay separately targetable.
        c.requireEverLoggedIn = true;
    } else if (audience.engagement === 'never') {
        c.neverLoggedIn = true;
    }
    return c;
}

// One-line summary for the send-confirmation dialog and the campaign list.
export function describeAudience(audience) {
    if (!audience || typeof audience !== 'object') return 'Unknown audience';
    if (audience.mode === 'selection') {
        const n = audience.user_ids?.length ?? 0;
        return `${n} selected user${n === 1 ? '' : 's'}`;
    }
    const parts = [];
    if (audience.verified === 'verified') parts.push('verified');
    else if (audience.verified === 'unverified') parts.push('unverified');
    if (audience.active === 'active') parts.push('active');
    else if (audience.active === 'inactive') parts.push('disabled');
    if (audience.role && audience.role !== 'any') parts.push(`${audience.role}s`);
    const who = parts.length ? parts.join(' ') : 'all';
    const extra = [];
    if (audience.engagement === 'recent') extra.push(`signed in within ${audience.engagement_days}d`);
    else if (audience.engagement === 'dormant') extra.push(`inactive ${audience.engagement_days}d+`);
    else if (audience.engagement === 'never') extra.push('never signed in');
    if (audience.signed_up_after) extra.push(`joined on/after ${audience.signed_up_after}`);
    if (audience.signed_up_before) extra.push(`joined before ${audience.signed_up_before}`);
    return `${who} users${extra.length ? ` (${extra.join(', ')})` : ''}, opt-outs excluded`;
}

// --- Batch pacing ------------------------------------------------------------
export const DEFAULT_BATCH_SIZE = 20;
export const DEFAULT_BATCH_DELAY_MS = 2000;

// How the job walks the recipient ledger. The delay sits BETWEEN batches, so a
// single-batch campaign waits not at all. Junk knobs clamp to something safe
// rather than throwing - these come from admin-editable settings.
export function campaignBatchPlan(total, { size, delayMs } = {}) {
    const n = Math.max(0, Math.floor(Number(total) || 0));
    const rawSize = Number(size);
    const s = Number.isFinite(rawSize) ? Math.min(500, Math.max(1, Math.floor(rawSize))) : DEFAULT_BATCH_SIZE;
    const rawDelay = Number(delayMs);
    const d = Number.isFinite(rawDelay) ? Math.max(0, Math.floor(rawDelay)) : DEFAULT_BATCH_DELAY_MS;
    const batches = n === 0 ? 0 : Math.ceil(n / s);
    return { size: s, delayMs: d, batches, estimatedMs: Math.max(0, batches - 1) * d };
}

// --- Send-failure breaker ----------------------------------------------------
export const DEFAULT_BREAKER_AFTER = 5;

// Stop a running campaign when sends fail back-to-back (the AI harness's
// AI_BREAKER_AFTER prior art). CONSECUTIVE, not cumulative: a handful of dead
// numbers scattered through a large audience is normal and must not abort the
// broadcast, but five in a row means the provider/credits/network is down and
// continuing just burns the remaining ledger into failures.
export function sendBreakerOpen({ consecutiveFailures = 0 } = {}, after = DEFAULT_BREAKER_AFTER) {
    return Math.max(0, Number(consecutiveFailures) || 0) >= Math.max(1, Number(after) || DEFAULT_BREAKER_AFTER);
}

// --- Status machine ----------------------------------------------------------
export const CAMPAIGN_STATUSES = ['draft', 'sending', 'completed', 'cancelled', 'failed'];

// A finished campaign is FROZEN - re-sending would double-charge the people who
// already received it. Recovery from a partial send is a NEW campaign over the
// remaining audience, which keeps the ledger honest about what was delivered.
const TRANSITIONS = {
    draft: ['sending', 'cancelled'],
    sending: ['completed', 'cancelled', 'failed'],
    completed: [],
    cancelled: [],
    failed: [],
};

export function canTransition(from, to) {
    return Boolean(TRANSITIONS[from]?.includes(to));
}
export function campaignIsTerminal(status) {
    return CAMPAIGN_STATUSES.includes(status) && TRANSITIONS[status]?.length === 0;
}

// Fold the recipient ledger into the campaign counters (the job's progress
// payload and the post-hoc repair of a crashed run both read from here).
export function recipientTotals(rows = []) {
    const t = { total: 0, sent: 0, failed: 0, pending: 0 };
    for (const r of rows) {
        t.total += 1;
        if (r.status === 'sent') t.sent += 1;
        else if (r.status === 'failed') t.failed += 1;
        else t.pending += 1;
    }
    return t;
}

// --- Request envelopes -------------------------------------------------------
export const templateSchema = z.object({
    name: z.string().trim().min(1, 'Name is required').max(64),
    body: z.string().superRefine((v, ctx) => {
        const issue = templateBodyIssue(v);
        if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue });
    }),
    is_auth_default: z.boolean().default(false),
}).strict();

export const campaignCreateSchema = z.object({
    name: z.string().trim().min(1, 'Name is required').max(96),
    // The raw admin-authored text; the stored campaign message is this RENDERED
    // through the chosen template, frozen at creation.
    message: z.string().trim().min(1, 'Message is required').max(1000),
    template_id: z.coerce.number().int().positive().nullable().default(null),
    audience: audienceSchema,
}).strict();

// Sending is the irreversible, billable step, so it needs a typed confirmation
// AND the count the admin actually saw - src/campaigns.js re-counts server-side
// and refuses when reality has drifted away from what was approved.
export const campaignSendSchema = z.object({
    confirm: z.literal('SEND'),
    expected_count: z.coerce.number().int().min(0),
}).strict();

// Audience drift between the preview the admin approved and the server's
// re-count at send time. Signups, opt-outs, verifications and disables all
// move the number in the seconds or minutes between the two.
//
// `expected` = the count shown in the confirm dialog, `actual` = the live
// server re-count. Returns one of:
//   { verdict: 'send' }                     - proceed with `actual` recipients
//   { verdict: 'refuse', reason: '<human>' } - 409 back to the admin, who
//                                              re-previews and re-confirms
//
// Policy is ASYMMETRIC, because the two directions are not symmetric risks.
export function countDriftVerdict(expected, actual) {
    const e = Math.max(0, Math.floor(Number(expected) || 0));
    const a = Math.max(0, Math.floor(Number(actual) || 0));
    // Growth is the only unsafe direction: the extra recipients were never in
    // the preview the admin approved, and they bill credits beyond the estimate
    // the confirm dialog showed. Refuse and make them re-preview.
    if (a > e) {
        return {
            verdict: 'refuse',
            reason: `The audience grew from ${e} to ${a} recipient${a === 1 ? '' : 's'} since you previewed it`
                + ' - review the new recipients and confirm again',
        };
    }
    // Shrink always proceeds. Every way the count can fall between preview and
    // send - opt-out, disable, un-verify - REMOVES someone already approved, so
    // the send stays a subset of what the admin signed off on. Under-sending is
    // cheap and recoverable (a new campaign over the remainder); over-sending is
    // neither.
    return { verdict: 'send' };
}
