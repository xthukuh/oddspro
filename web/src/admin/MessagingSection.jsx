import { useCallback, useEffect, useRef, useState } from 'react';
import {
    getSmsTemplates, saveSmsTemplate, deleteSmsTemplate,
    previewSmsCampaign, getSmsCampaigns, createSmsCampaign,
    sendSmsCampaign, cancelSmsCampaign, getSmsJob,
} from '../api.js';
import { claimSelection } from './campaignHandoff.js';

// Admin Messaging section (M9): SMS templates + broadcast campaigns over the
// session-guarded /api/admin/sms/* routes. The server is authoritative for
// everything that matters - audience membership, opt-out exclusion, the
// send-time re-count - so this UI's job is to make the COST and the REACH of a
// send impossible to miss before the admin confirms it.
//
// Sending is irreversible and billable, so it is deliberately a two-gesture
// flow: create a draft (which freezes the rendered text), then type SEND
// against a shown recipient count.

const TONES = {
    hit: 'text-hit bg-hit/10',
    miss: 'text-miss bg-miss/10',
    hot: 'text-hot bg-hot/10',
    accent: 'text-accent bg-accent/10',
    muted: 'text-label-2 bg-fill',
};
const STATUS_TONE = {
    draft: 'muted', sending: 'accent', completed: 'hit', cancelled: 'muted', failed: 'miss',
};
function Chip({ tone = 'muted', title, children }) {
    return (
        <span title={title}
            className={`inline-block text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 whitespace-nowrap ${TONES[tone]}`}>
            {children}
        </span>
    );
}

function Card({ title, hint, children, right }) {
    return (
        <section className="bg-surface rounded-2xl border border-separator-2 p-4">
            <div className="flex items-start gap-2 mb-3">
                <div>
                    <h3 className="text-label text-sm font-semibold">{title}</h3>
                    {hint && <p className="text-label-3 text-[12px] mt-0.5">{hint}</p>}
                </div>
                {right && <div className="ml-auto">{right}</div>}
            </div>
            {children}
        </section>
    );
}

const inputCls = 'bg-surface border border-separator text-label rounded-lg h-9 px-2.5 text-[13px] outline-none focus:border-accent';
const btnCls = 'cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-fill hover:bg-fill-hover text-label-2 disabled:opacity-40';
const primaryCls = 'cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-accent text-white hover:opacity-90 disabled:opacity-40';

const fmtWhen = v => {
    if (v == null) return '–';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v)
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const errText = e => e?.body?.error || e?.message || String(e);

// --- Templates ---------------------------------------------------------------

const BLANK_TEMPLATE = { id: null, name: '', body: '[OP] ${message}', is_auth_default: false };

function TemplatesCard({ templates, reload, onError }) {
    const [draft, setDraft] = useState(BLANK_TEMPLATE);
    const [busy, setBusy] = useState(false);

    const save = async () => {
        setBusy(true);
        try {
            await saveSmsTemplate(draft.id, draft);
            setDraft(BLANK_TEMPLATE);
            await reload();
            onError(null);
        } catch (e) { onError(errText(e)); } finally { setBusy(false); }
    };
    const remove = async id => {
        setBusy(true);
        try {
            await deleteSmsTemplate(id);
            if (draft.id === id) setDraft(BLANK_TEMPLATE);
            await reload();
            onError(null);
        } catch (e) { onError(errText(e)); } finally { setBusy(false); }
    };

    return (
        <Card title="Templates"
            hint="A template wraps message text and must contain ${message} - the only placeholder. The auth default also wraps OTP/verification texts.">
            {templates.length > 0 && (
                <ul className="divide-y divide-separator-2 mb-3">
                    {templates.map(t => (
                        <li key={t.id} className="py-2 flex items-center gap-2 flex-wrap">
                            <span className="text-label text-[13px] font-medium">{t.name}</span>
                            {Boolean(t.is_auth_default) && (
                                <Chip tone="accent" title="OTP and verification texts are sent wrapped in this template">Auth default</Chip>
                            )}
                            <code className="text-label-2 text-[11px] bg-fill rounded px-1.5 py-0.5 truncate max-w-full">{t.body}</code>
                            <span className="ml-auto flex gap-1">
                                <button className={btnCls} disabled={busy}
                                    onClick={() => setDraft({ id: t.id, name: t.name, body: t.body, is_auth_default: Boolean(t.is_auth_default) })}>Edit</button>
                                <button className={btnCls} disabled={busy} onClick={() => remove(t.id)}>Delete</button>
                            </span>
                        </li>
                    ))}
                </ul>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <input className={`${inputCls} w-40`} placeholder="Template name" value={draft.name}
                    onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
                <input className={`${inputCls} flex-1 min-w-[240px] font-mono`} placeholder="[OP] ${message}" value={draft.body}
                    onChange={e => setDraft(d => ({ ...d, body: e.target.value }))} />
                <label className="flex items-center gap-1.5 text-[12px] text-label-2 cursor-pointer"
                    title="Wrap OTP / verification texts in this template">
                    <input type="checkbox" className="accent-accent h-4 w-4 cursor-pointer" checked={draft.is_auth_default}
                        onChange={e => setDraft(d => ({ ...d, is_auth_default: e.target.checked }))} />
                    Auth default
                </label>
                <button className={primaryCls} disabled={busy || !draft.name.trim() || !draft.body.trim()} onClick={save}>
                    {draft.id ? 'Update' : 'Add'}
                </button>
                {draft.id && <button className={btnCls} disabled={busy} onClick={() => setDraft(BLANK_TEMPLATE)}>Cancel</button>}
            </div>
        </Card>
    );
}

// --- Audience builder --------------------------------------------------------

const BLANK_FILTER = {
    mode: 'filter', verified: 'verified', active: 'active', role: 'any',
    engagement: 'any', engagement_days: 30, signed_up_after: null, signed_up_before: null,
};

function Select({ label, value, onChange, options, title }) {
    return (
        <label className="flex flex-col gap-1" title={title}>
            <span className="text-label-3 text-[11px]">{label}</span>
            <select className={inputCls} value={value} onChange={e => onChange(e.target.value)}>
                {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
        </label>
    );
}

function AudienceBuilder({ audience, setAudience, selectionLabels }) {
    if (audience.mode === 'selection') {
        return (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <Chip tone="accent">{audience.user_ids.length} hand-picked user{audience.user_ids.length === 1 ? '' : 's'}</Chip>
                <span className="text-label-3 truncate max-w-[420px]">{selectionLabels.join(', ')}</span>
                <button className={btnCls} onClick={() => setAudience(BLANK_FILTER)}>Use a filter instead</button>
            </div>
        );
    }
    const set = patch => setAudience({ ...audience, ...patch });
    return (
        <div className="flex flex-wrap gap-3 items-end">
            <Select label="Phone" value={audience.verified} onChange={v => set({ verified: v })}
                title="Unverified numbers may not be reachable"
                options={[['verified', 'Verified only'], ['unverified', 'Unverified only'], ['any', 'Any']]} />
            <Select label="Account" value={audience.active} onChange={v => set({ active: v })}
                options={[['active', 'Active only'], ['inactive', 'Disabled only'], ['any', 'Any']]} />
            <Select label="Role" value={audience.role} onChange={v => set({ role: v })}
                options={[['any', 'Any role'], ['normal', 'Normal'], ['admin', 'Admin']]} />
            <Select label="Engagement" value={audience.engagement} onChange={v => set({ engagement: v })}
                title="Measured on the last successful sign-in"
                options={[['any', 'Any'], ['recent', 'Signed in recently'], ['dormant', 'Dormant'], ['never', 'Never signed in']]} />
            {(audience.engagement === 'recent' || audience.engagement === 'dormant') && (
                <label className="flex flex-col gap-1">
                    <span className="text-label-3 text-[11px]">Days</span>
                    <input type="number" min={1} max={365} className={`${inputCls} w-20`} value={audience.engagement_days}
                        onChange={e => set({ engagement_days: Number(e.target.value) || 30 })} />
                </label>
            )}
            <label className="flex flex-col gap-1">
                <span className="text-label-3 text-[11px]">Joined on/after</span>
                <input type="date" className={`${inputCls} w-40`} value={audience.signed_up_after ?? ''}
                    onChange={e => set({ signed_up_after: e.target.value || null })} />
            </label>
            <label className="flex flex-col gap-1">
                <span className="text-label-3 text-[11px]">Joined before</span>
                <input type="date" className={`${inputCls} w-40`} value={audience.signed_up_before ?? ''}
                    onChange={e => set({ signed_up_before: e.target.value || null })} />
            </label>
        </div>
    );
}

// --- Composer ----------------------------------------------------------------

function Composer({ templates, onCreated, onError }) {
    const [name, setName] = useState('');
    const [message, setMessage] = useState('');
    const [templateId, setTemplateId] = useState(null);
    const [audience, setAudience] = useState(BLANK_FILTER);
    const [selectionLabels, setSelectionLabels] = useState([]);
    const [preview, setPreview] = useState(null);
    const [busy, setBusy] = useState(false);
    const seq = useRef(0);

    // A selection staged by the Users section wins over the default filter.
    useEffect(() => {
        const staged = claimSelection();
        if (staged) {
            setAudience({ mode: 'selection', user_ids: staged.ids });
            setSelectionLabels(staged.labels);
        }
    }, []);

    // Debounced live preview. Every response carries its request's sequence
    // number so a slow early reply can never overwrite a newer count - the
    // number on screen must always describe the audience on screen.
    useEffect(() => {
        if (!message.trim()) { setPreview(null); return undefined; }
        const mine = ++seq.current;
        const t = setTimeout(() => {
            previewSmsCampaign({ message, template_id: templateId, audience })
                .then(p => { if (mine === seq.current) { setPreview(p); onError(null); } })
                .catch(e => { if (mine === seq.current) { setPreview(null); onError(errText(e)); } });
        }, 350);
        return () => clearTimeout(t);
    }, [message, templateId, audience, onError]);

    const create = async () => {
        setBusy(true);
        try {
            const { campaign } = await createSmsCampaign({ name, message, template_id: templateId, audience });
            setName(''); setMessage(''); setPreview(null);
            onError(null);
            await onCreated(campaign);
        } catch (e) { onError(errText(e)); } finally { setBusy(false); }
    };

    const overBudget = preview?.balance != null && preview.cost_estimate > preview.balance;

    return (
        <Card title="New campaign" hint="Create a draft first; sending is a separate, confirmed step.">
            <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                    <input className={`${inputCls} w-56`} placeholder="Campaign name (internal)" value={name}
                        onChange={e => setName(e.target.value)} />
                    <select className={inputCls} value={templateId ?? ''}
                        onChange={e => setTemplateId(e.target.value ? Number(e.target.value) : null)}>
                        <option value="">No template (send text as-is)</option>
                        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                </div>
                <textarea className="bg-surface border border-separator text-label rounded-lg p-2.5 text-[13px] outline-none focus:border-accent min-h-[80px]"
                    placeholder="Message text…" value={message} onChange={e => setMessage(e.target.value)} />

                <div className="border-t border-separator-2 pt-3">
                    <div className="text-label-3 text-[11px] mb-2">Audience — people who opted out are always excluded.</div>
                    <AudienceBuilder audience={audience} setAudience={setAudience} selectionLabels={selectionLabels} />
                </div>

                {preview && (
                    <div className="bg-fill rounded-xl p-3 text-[12px] flex flex-col gap-2">
                        <div className="text-label-3 text-[11px]">Exactly what each person receives:</div>
                        <div className="text-label bg-surface border border-separator-2 rounded-lg p-2 whitespace-pre-wrap break-words">{preview.text}</div>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-label-2">
                            <span><b className="text-label tabular-nums">{preview.count}</b> recipient{preview.count === 1 ? '' : 's'}</span>
                            <span title="A long or emoji-bearing message costs more than one credit per recipient">
                                <b className="text-label tabular-nums">{preview.segments}</b> segment{preview.segments === 1 ? '' : 's'} each
                            </span>
                            <span><b className={`tabular-nums ${overBudget ? 'text-miss' : 'text-label'}`}>{preview.cost_estimate}</b> credits</span>
                            {preview.balance != null && <span className="text-label-3">balance {preview.balance}</span>}
                            {!preview.sms_enabled && <Chip tone="hot" title="SMS_ENABLED is off - a send will be a dry run and touch no network">Dry-run mode</Chip>}
                        </div>
                        <div className="text-label-3 text-[11px]">{preview.audience_label}</div>
                        {overBudget && <div className="text-miss text-[12px]">Not enough credits — this send would stop partway.</div>}
                    </div>
                )}

                <div>
                    <button className={primaryCls} disabled={busy || !name.trim() || !message.trim() || !preview?.count}
                        onClick={create}>Create draft</button>
                </div>
            </div>
        </Card>
    );
}

// --- Campaign list + send flow ----------------------------------------------

function SendConfirm({ campaign, approvedCount, onRecheck, onSend, onClose, busy, error }) {
    const [typed, setTyped] = useState('');
    return (
        <div className="mt-2 bg-fill rounded-xl p-3 text-[12px] flex flex-col gap-2">
            <div className="text-label">
                Send to <b className="tabular-nums">{approvedCount}</b> recipient{approvedCount === 1 ? '' : 's'}
                {' '}({campaign.segments} segment{campaign.segments === 1 ? '' : 's'} each ={' '}
                <b className="tabular-nums">{approvedCount * campaign.segments}</b> credits). This cannot be undone.
            </div>
            {error && (
                <div className="text-miss">
                    {error}
                    <button className={`${btnCls} ml-2`} onClick={onRecheck} disabled={busy}>Re-check audience</button>
                </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-label-2">Type <b className="text-label">SEND</b> to confirm:</span>
                <input className={`${inputCls} w-28`} value={typed} onChange={e => setTyped(e.target.value)} autoFocus />
                <button className={primaryCls} disabled={busy || typed !== 'SEND'} onClick={() => onSend(approvedCount)}>Send now</button>
                <button className={btnCls} disabled={busy} onClick={onClose}>Cancel</button>
            </div>
        </div>
    );
}

export default function MessagingSection() {
    const [templates, setTemplates] = useState([]);
    const [campaigns, setCampaigns] = useState([]);
    const [job, setJob] = useState(null);
    const [error, setError] = useState(null);
    const [sendFor, setSendFor] = useState(null);      // campaign id awaiting confirmation
    const [approvedCount, setApprovedCount] = useState(0);
    const [sendError, setSendError] = useState(null);
    const [busy, setBusy] = useState(false);

    const loadTemplates = useCallback(async () => setTemplates(await getSmsTemplates()), []);
    const loadCampaigns = useCallback(async () => {
        const { campaigns: list, job: j } = await getSmsCampaigns();
        setCampaigns(list);
        setJob(j);
    }, []);

    useEffect(() => {
        Promise.all([loadTemplates(), loadCampaigns()]).catch(e => setError(errText(e)));
    }, [loadTemplates, loadCampaigns]);

    // Poll while a send is in flight; stop as soon as it settles (the same
    // fast-poll-while-running idiom the refresh button uses).
    useEffect(() => {
        if (!job?.running) return undefined;
        const t = setInterval(() => {
            getSmsJob().then(j => {
                setJob(j);
                if (!j.running) loadCampaigns().catch(() => {});
            }).catch(() => {});
        }, 2000);
        return () => clearInterval(t);
    }, [job?.running, loadCampaigns]);

    const openSend = campaign => {
        setSendFor(campaign.id);
        setApprovedCount(campaign.total);
        setSendError(null);
    };

    // A refused send is NOT auto-retried with the new number: re-checking only
    // updates what the dialog SHOWS, so the admin re-approves the real figure.
    const recheck = async campaign => {
        setBusy(true);
        try {
            const p = await previewSmsCampaign({
                message: campaign.message, template_id: null, audience: campaign.audience,
            });
            setApprovedCount(p.count);
            setSendError(`Audience is now ${p.count}. Confirm again to send to that many people.`);
        } catch (e) { setSendError(errText(e)); } finally { setBusy(false); }
    };

    const send = async (campaign, count) => {
        setBusy(true);
        try {
            const res = await sendSmsCampaign(campaign.id, count);
            setJob(res.job);
            setSendFor(null);
            await loadCampaigns();
        } catch (e) { setSendError(errText(e)); } finally { setBusy(false); }
    };

    const cancel = async id => {
        setBusy(true);
        try {
            await cancelSmsCampaign(id);
            await loadCampaigns();
        } catch (e) { setError(errText(e)); } finally { setBusy(false); }
    };

    return (
        <div className="flex flex-col gap-4">
            {error && <div className="text-miss text-[12px] bg-miss/10 rounded-lg px-3 py-2">{error}</div>}

            <TemplatesCard templates={templates} reload={loadTemplates} onError={setError} />

            <Composer templates={templates} onError={setError}
                onCreated={async () => { await loadCampaigns(); }} />

            <Card title="Campaigns" hint="Drafts can be sent or discarded; a finished campaign is frozen."
                right={<button className={btnCls} onClick={() => loadCampaigns().catch(e => setError(errText(e)))}>Reload</button>}>
                {campaigns.length === 0 ? (
                    <p className="text-label-3 text-[12px]">No campaigns yet.</p>
                ) : (
                    <ul className="divide-y divide-separator-2">
                        {campaigns.map(c => {
                            const live = job?.running && job.campaign_id === c.id;
                            return (
                                <li key={c.id} className="py-3">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span className="text-label text-[13px] font-medium">{c.name}</span>
                                        <Chip tone={STATUS_TONE[c.status] ?? 'muted'}>{c.status}</Chip>
                                        <span className="text-label-3 text-[11px]">{fmtWhen(c.created_at)}</span>
                                        <span className="ml-auto flex gap-1">
                                            {c.status === 'draft' && (
                                                <>
                                                    <button className={primaryCls} disabled={busy || job?.running} onClick={() => openSend(c)}>Send…</button>
                                                    <button className={btnCls} disabled={busy} onClick={() => cancel(c.id)}>Discard</button>
                                                </>
                                            )}
                                            {c.status === 'sending' && (
                                                <button className={btnCls} disabled={busy} onClick={() => cancel(c.id)}>Stop</button>
                                            )}
                                        </span>
                                    </div>
                                    <div className="text-label-2 text-[12px] mt-1 break-words">{c.message}</div>
                                    <div className="text-label-3 text-[11px] mt-1 flex flex-wrap gap-x-3">
                                        <span>{c.audience_label}</span>
                                        <span className="tabular-nums">
                                            {live ? `${job.sent + job.failed}/${job.total}` : `${c.sent}/${c.total}`} sent
                                            {(live ? job.failed : c.failed) > 0 && <span className="text-miss"> · {live ? job.failed : c.failed} failed</span>}
                                        </span>
                                        {live && job.step && <span className="text-accent">{job.step}</span>}
                                        {c.error && <span className="text-miss">{c.error}</span>}
                                    </div>
                                    {sendFor === c.id && (
                                        <SendConfirm campaign={c} approvedCount={approvedCount} busy={busy} error={sendError}
                                            onRecheck={() => recheck(c)} onSend={count => send(c, count)}
                                            onClose={() => setSendFor(null)} />
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </Card>
        </div>
    );
}
