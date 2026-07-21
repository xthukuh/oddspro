import { db } from './db/connection.js';
import { effective } from './settings.js';
import { AuthError } from './auth.js';
import { sendSms, smsEnabled, smsBalance } from './sms/index.js';
import { getTemplate } from './sms/templates.js';
import {
    renderTemplate, smsSegments, costEstimate,
    audienceCriteria, describeAudience,
    campaignBatchPlan, sendBreakerOpen, countDriftVerdict,
    canTransition, campaignIsTerminal, recipientTotals,
} from './db/campaign-rules.js';

// SMS broadcast campaigns (M9): thin knex orchestration over the pure rules in
// src/db/campaign-rules.js. Template CRUD lives in src/sms/templates.js (the
// table's one owner - see the cycle note there).
//
// The campaign job runs on its OWN single slot, deliberately NOT the
// auto-refresh slot: broadcasts are network-bound with zero DB gap-lock
// exposure, so blocking them behind a data refresh (or vice versa) would buy
// nothing and could stall a time-sensitive announcement for the length of a
// full sweep.

// --- Audience -> SQL ---------------------------------------------------------
// Stored datetimes are EAT wall-clock and the pool pins the session to +03:00,
// so bounds are bound as EAT strings. Passing a JS Date would let mysql2 format
// it in the NODE PROCESS's timezone - the same trap KICKOFF_SQL_EXPR documents.
const _eatSql = ms => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

// THE ONE translator from pure criteria to a knex where-chain. Both the preview
// count and the send-time materialization go through this function, which is
// what guarantees the number the admin approved describes the same people who
// actually receive the message.
function applyAudience(query, criteria) {
    if (criteria.excludeOptOut) query.where('users.sms_opt_out', 0);
    if (criteria.userIds) query.whereIn('users.id', criteria.userIds);
    if (criteria.phoneVerified !== null) query.where('users.phone_verified', criteria.phoneVerified ? 1 : 0);
    if (criteria.isActive !== null) query.where('users.is_active', criteria.isActive ? 1 : 0);
    if (criteria.role) query.where('users.role', criteria.role);
    if (criteria.neverLoggedIn) query.whereNull('users.last_login_at');
    if (criteria.requireEverLoggedIn) query.whereNotNull('users.last_login_at');
    if (criteria.lastLoginAfter != null) query.where('users.last_login_at', '>=', _eatSql(criteria.lastLoginAfter));
    if (criteria.lastLoginBefore != null) query.where('users.last_login_at', '<', _eatSql(criteria.lastLoginBefore));
    if (criteria.createdAfter != null) query.where('users.created_at', '>=', _eatSql(criteria.createdAfter));
    if (criteria.createdBefore != null) query.where('users.created_at', '<', _eatSql(criteria.createdBefore));
    return query;
}

async function audienceUsers(criteria) {
    return applyAudience(db('users').select('users.id', 'users.name', 'users.phone'), criteria)
        .orderBy('users.id', 'asc');
}

async function audienceCount(criteria) {
    const row = await applyAudience(db('users').count('* as c'), criteria).first();
    return Number(row?.c) || 0;
}

// --- Preview -----------------------------------------------------------------
// What the admin sees before confirming: the exact text that will be sent, the
// audience size, segment count and credit cost, plus the live provider balance
// so an under-funded broadcast is caught BEFORE it half-sends.
export async function previewCampaign({ message, template_id = null, audience }) {
    const criteria = audienceCriteria(audience);
    const template = template_id ? await getTemplate(template_id) : null;
    if (template_id && !template) throw new AuthError(404, 'Template not found');
    const text = template ? renderTemplate(template.body, { message }) : String(message ?? '').trim();
    const count = await audienceCount(criteria);
    const segments = smsSegments(text);

    let balance = null;
    try {
        if (smsEnabled()) {
            const b = await smsBalance();
            balance = b?.ok ? b.credits : null;
        }
    } catch {
        balance = null;   // best-effort: a balance-API hiccup must not block a preview
    }

    return {
        text, count, segments,
        cost_estimate: costEstimate(count, segments),
        audience_label: describeAudience(audience),
        balance,
        sms_enabled: smsEnabled(),
    };
}

// --- Campaign CRUD -----------------------------------------------------------
export async function createCampaign({ name, message, template_id = null, audience }, actor) {
    const preview = await previewCampaign({ message, template_id, audience });
    const [id] = await db('sms_campaigns').insert({
        created_by: actor?.id ?? null,
        template_id: template_id ?? null,
        name: String(name).trim(),
        // The RENDERED text is frozen here: editing the template afterwards must
        // never rewrite what a campaign says (the prematch/hot-pick freeze idiom).
        message: preview.text,
        audience: JSON.stringify(audience),
        status: 'draft',
        total: preview.count,
        segments: preview.segments,
        cost_estimate: preview.cost_estimate,
    });
    return getCampaign(id);
}

const _audience = row => (typeof row.audience === 'string' ? JSON.parse(row.audience) : row.audience);

function campaignView(row, extra = {}) {
    const audience = _audience(row);
    return {
        id: row.id,
        name: row.name,
        message: row.message,
        template_id: row.template_id,
        audience,
        audience_label: describeAudience(audience),
        status: row.status,
        total: row.total,
        sent: row.sent,
        failed: row.failed,
        segments: row.segments,
        cost_estimate: row.cost_estimate,
        started_at: row.started_at,
        finished_at: row.finished_at,
        error: row.error,
        created_at: row.created_at,
        ...extra,
    };
}

export async function listCampaigns({ limit = 50 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const rows = await db('sms_campaigns').orderBy('id', 'desc').limit(cap);
    return { campaigns: rows.map(r => campaignView(r)) };
}

export async function getCampaign(id) {
    const row = await db('sms_campaigns').where('id', Number(id) || 0).first();
    if (!row) throw new AuthError(404, 'Campaign not found');
    return campaignView(row);
}

// Per-recipient ledger for one campaign (the detail view / post-hoc audit).
export async function getCampaignRecipients(id, { limit = 1000 } = {}) {
    const cap = Math.min(Math.max(Number(limit) || 1000, 1), 5000);
    const rows = await db('sms_campaign_recipients')
        .where('campaign_id', Number(id) || 0).orderBy('id', 'asc').limit(cap);
    return { recipients: rows, totals: recipientTotals(rows) };
}

// --- The job slot ------------------------------------------------------------
const campaignJob = {
    running: false,
    campaign_id: null,
    name: null,
    total: 0,
    sent: 0,
    failed: 0,
    step: null,
    started_at: null,
    finished_at: null,
    error: null,
    cancelRequested: false,
    cancelled: false,
};

export function campaignJobStatus() {
    return { ...campaignJob };
}

export function requestCampaignCancel() {
    if (!campaignJob.running) return false;
    campaignJob.cancelRequested = true;
    return true;
}

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// Send one recipient and write its ledger row. Never throws: a per-recipient
// failure is DATA (it lands in the row), not a reason to abort the broadcast -
// the breaker decides that from the consecutive-failure count.
async function _sendOne(recipient, text) {
    try {
        const res = await sendSms({ to: recipient.phone, text });
        if (res.ok === false) {
            const detail = [res.status, res.message ?? 'provider error'].filter(x => x != null).join(' ');
            await db('sms_campaign_recipients').where('id', recipient.id)
                .update({ status: 'failed', error: String(detail).slice(0, 500) });
            return false;
        }
        await db('sms_campaign_recipients').where('id', recipient.id).update({
            status: 'sent',
            // 'dev' marks a dry run (SMS_ENABLED off): the ledger stays honest
            // about which rows never touched the network.
            message_id: res.dev ? 'dev' : (res.messageId ? String(res.messageId).slice(0, 64) : null),
            sent_at: db.fn.now(),
            error: null,
        });
        return true;
    } catch (e) {
        await db('sms_campaign_recipients').where('id', recipient.id)
            .update({ status: 'failed', error: String(e?.message ?? e).slice(0, 500) })
            .catch(() => {});
        return false;
    }
}

// Walk the pending ledger in paced batches. Cooperative cancel is polled
// between batches AND between recipients, so a stop request lands within one
// send rather than one batch.
async function _runCampaign(campaign) {
    const text = campaign.message;
    const plan = campaignBatchPlan(campaignJob.total, {
        size: effective('SMS_BATCH_SIZE'),
        delayMs: effective('SMS_BATCH_DELAY_MS'),
    });
    const breakerAfter = effective('SMS_BREAKER_AFTER');
    let consecutiveFailures = 0;

    for (let batch = 0; batch < plan.batches; batch += 1) {
        if (campaignJob.cancelRequested) return 'cancelled';
        // Re-read pending rows each batch: an interrupted run resumes from the
        // ledger by construction, no cursor to keep in sync.
        // Consent is re-checked EVERY batch, not just at materialization. The
        // ledger is built once at send time, but a broadcast is paced (batches
        // with a delay between them), so a large audience runs for many minutes
        // - and there is a live self-service opt-out in the profile screen.
        // Without this, someone who opts out at minute 2 of a 20-minute send
        // still receives the message. The module's promise is that consent is
        // structural rather than remembered; this was the one place it was
        // remembered-at-materialization instead.
        //
        // Retiring them to 'skipped' (rather than filtering the SELECT) keeps
        // the ledger honest - "we deliberately did not send to this person" is
        // a different fact from "still queued" - and lets the drain terminate
        // cleanly instead of looping over rows it will never send.
        await db('sms_campaign_recipients')
            .where({ campaign_id: campaign.id, status: 'pending' })
            .whereIn('user_id', db('users').select('id').where('sms_opt_out', 1))
            .update({ status: 'skipped' });

        const pending = await db('sms_campaign_recipients')
            .where({ campaign_id: campaign.id, status: 'pending' })
            .orderBy('id', 'asc').limit(plan.size);
        if (!pending.length) break;

        campaignJob.step = `batch ${batch + 1}/${plan.batches}`;
        for (const r of pending) {
            if (campaignJob.cancelRequested) return 'cancelled';
            const ok = await _sendOne(r, text);
            if (ok) {
                campaignJob.sent += 1;
                consecutiveFailures = 0;
            } else {
                campaignJob.failed += 1;
                consecutiveFailures += 1;
            }
            if (sendBreakerOpen({ consecutiveFailures }, breakerAfter)) {
                throw new Error(`${consecutiveFailures} consecutive send failures - provider, credits or network is down`);
            }
        }
        await db('sms_campaigns').where('id', campaign.id)
            .update({ sent: campaignJob.sent, failed: campaignJob.failed });
        if (batch < plan.batches - 1 && plan.delayMs > 0) await _sleep(plan.delayMs);
    }
    return 'completed';
}

// Claim the slot and run without awaiting (the route answers immediately; the
// web polls campaignJobStatus). Mirrors auto-refresh's startJob shape.
function startCampaignJob(campaign, total) {
    if (campaignJob.running) return false;
    Object.assign(campaignJob, {
        running: true,
        campaign_id: campaign.id,
        name: campaign.name,
        total,
        sent: 0,
        failed: 0,
        step: 'starting',
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        cancelRequested: false,
        cancelled: false,
    });

    _runCampaign(campaign)
        .then(async outcome => {
            campaignJob.cancelled = outcome === 'cancelled';
            await db('sms_campaigns').where('id', campaign.id).update({
                status: outcome,
                sent: campaignJob.sent,
                failed: campaignJob.failed,
                finished_at: db.fn.now(),
                error: null,
            });
        })
        .catch(async e => {
            campaignJob.error = String(e?.message ?? e);
            console.error(`[campaign ${campaign.id}] ${campaignJob.error}`);
            await db('sms_campaigns').where('id', campaign.id).update({
                status: 'failed',
                sent: campaignJob.sent,
                failed: campaignJob.failed,
                finished_at: db.fn.now(),
                error: campaignJob.error.slice(0, 500),
            }).catch(() => {});
        })
        .finally(() => {
            campaignJob.running = false;
            campaignJob.step = null;
            campaignJob.finished_at = new Date().toISOString();
            campaignJob.cancelRequested = false;
        });
    return true;
}

// --- Send --------------------------------------------------------------------
// The billable, irreversible step. Order matters: status guard -> live re-count
// -> drift verdict -> materialize ledger -> claim slot. Nothing is written until
// the drift check passes, so a refused send leaves no partial state.
export async function sendCampaign(id, { expected_count }, _actor) {
    const campaign = await db('sms_campaigns').where('id', Number(id) || 0).first();
    if (!campaign) throw new AuthError(404, 'Campaign not found');
    if (campaignIsTerminal(campaign.status)) {
        throw new AuthError(409, `This campaign is ${campaign.status} and cannot be sent again`);
    }
    if (!canTransition(campaign.status, 'sending')) {
        throw new AuthError(409, `Cannot send a campaign that is ${campaign.status}`);
    }
    if (campaignJob.running) {
        throw new AuthError(409, 'Another campaign is already sending');
    }

    const criteria = audienceCriteria(_audience(campaign));
    const recipients = await audienceUsers(criteria);
    const drift = countDriftVerdict(expected_count, recipients.length);
    if (drift.verdict !== 'send') {
        throw new AuthError(409, drift.reason || 'The audience changed since you previewed it - please review and confirm again');
    }
    if (!recipients.length) throw new AuthError(400, 'This audience is empty - nobody would receive the message');

    // Materialize the ledger. The (campaign_id, user_id) unique index makes this
    // idempotent, so a retried send cannot double-enqueue anyone.
    await db('sms_campaign_recipients')
        .insert(recipients.map(u => ({
            campaign_id: campaign.id, user_id: u.id, phone: u.phone, status: 'pending',
        })))
        .onConflict(['campaign_id', 'user_id']).ignore();

    await db('sms_campaigns').where('id', campaign.id).update({
        status: 'sending',
        total: recipients.length,
        sent: 0,
        failed: 0,
        started_at: db.fn.now(),
        finished_at: null,
        error: null,
    });

    // HONOR the claim. The guard above sits ~4 awaits earlier (audience query,
    // ledger insert, campaign update), so two overlapping sends can both pass
    // it - classic check-then-act across an await boundary. Discarding this
    // boolean meant the loser answered { started:true } while its campaign sat
    // in 'sending' with a materialized ledger and NO runner, and since
    // canTransition('sending','sending') is false it could never be sent again:
    // a silent lie plus an unrecoverable state. Roll the status back so the
    // draft stays sendable once the slot frees.
    if (!startCampaignJob(campaign, recipients.length)) {
        await db('sms_campaigns').where('id', campaign.id)
            .update({ status: 'draft', started_at: null });
        throw new AuthError(409, 'Another campaign started sending - please try again in a moment');
    }
    return { started: true, total: recipients.length, job: campaignJobStatus() };
}

// Cancel a running send (cooperative) or a draft (straight to cancelled).
export async function cancelCampaign(id) {
    const campaign = await db('sms_campaigns').where('id', Number(id) || 0).first();
    if (!campaign) throw new AuthError(404, 'Campaign not found');
    if (!canTransition(campaign.status, 'cancelled')) {
        throw new AuthError(409, `Cannot cancel a campaign that is ${campaign.status}`);
    }
    if (campaign.status === 'sending' && campaignJob.running && campaignJob.campaign_id === campaign.id) {
        requestCampaignCancel();
        return { cancelling: true };   // the job writes the terminal status
    }
    await db('sms_campaigns').where('id', campaign.id)
        .update({ status: 'cancelled', finished_at: db.fn.now() });
    return { cancelled: true };
}
