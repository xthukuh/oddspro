import { useEffect, useMemo, useState } from 'react';
import { getAdminSettings, putAdminSettings, deleteAdminSetting, getAdminAudit } from '../api.js';
import { settingsDiff } from '../../../src/db/settings-rules.js';
import NumberInput from '../components/NumberInput.jsx';

// Dynamic-settings editor (M7 redesign) over the admin endpoints. Rows come
// from GET /api/admin/settings (catalog metadata + default/override/effective);
// edits accumulate locally and the pure settingsDiff (shared verbatim from
// src/db/settings-rules.js) decides what is REALLY dirty - typing the shown
// value back is clean, '1.60' == 1.6, a blanked numeric on an overridden row
// becomes a reset. The sticky Save bar renders ONLY while the diff is
// non-empty and writes exactly that diff: one all-or-nothing batch PUT (the
// server validates every key before any write) plus a DELETE per blank-reset.
// The recent-changes panel reads the M6 admin_audit trail (session-only route;
// ADMIN_TOKEN bearer access renders a note instead).

const GROUP_LABELS = {
    safe: 'Safe-only selection',
    refresh: 'Refresh & scheduler',
    pipeline: 'Pipeline & ingestion',
    hotpick: 'Hot-pick gates',
    tip: 'Tip candidacy & books',
    ai: 'AI review & enrichment',
    'ai-dark': 'AI dark switches',
    'auth-policy': 'Sign-in policy',
    otp: 'OTP policy',
    sms: 'SMS',
    mail: 'Email',
    geo: 'Visitor geo',
    bot: 'Bot filter',
    logging: 'Logging',
    tracking: 'Tracking',
    maintenance: 'Maintenance window',
};

const REGIME_TIP = 'Policy-regime knob: changing it changes which picks/verdicts get GENERATED, '
    + 'splitting the settled ledger into before/after populations. Every change lands a dated audit row.';

function Badge({ live }) {
    return live
        ? <span className="text-[10px] font-semibold uppercase tracking-wide text-hit bg-hit/10 rounded px-1.5 py-0.5">live</span>
        : <span className="text-[10px] font-semibold uppercase tracking-wide text-hot bg-hot/10 rounded px-1.5 py-0.5">restart</span>;
}

function RegimeChip() {
    return (
        <span title={REGIME_TIP}
            className="text-[10px] font-semibold uppercase tracking-wide text-hot bg-hot/10 rounded px-1.5 py-0.5 cursor-help">
            ⚠ regime
        </span>
    );
}

// iOS-style switch for boolean knobs (44px-wide tap target incl. padding).
// Exported for the Dashboard's Maintenance card (M14) - same admin chunk.
export function Switch({ checked, onChange, disabled }) {
    return (
        <button type="button" role="switch" aria-checked={checked} disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative shrink-0 w-11 h-[26px] rounded-full transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default ${
                checked ? 'bg-accent' : 'bg-fill-hover'}`}>
            <span className={`absolute top-[3px] left-[3px] w-5 h-5 rounded-full bg-white shadow transition-transform ${
                checked ? 'translate-x-[18px]' : ''}`} />
        </button>
    );
}

const fmt = v => (v == null || v === '' ? '–' : String(v));
const fmtAudit = v => (v == null ? 'default' : String(v));

function safePatternTest(source, value) {
    try { return new RegExp(source).test(value); } catch { return true; }
}

function fmtWhen(v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v)
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SettingsEditor() {
    const [rows, setRows] = useState(null);
    const [edits, setEdits] = useState({}); // key -> raw input value (string | number | boolean)
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [audit, setAudit] = useState(null);
    const [auditNote, setAuditNote] = useState(null);

    async function load() {
        setError(null);
        try {
            setRows(await getAdminSettings());
        } catch (e) {
            setError(e.message);
            setRows([]);
        }
    }
    async function loadAudit() {
        try {
            setAudit(await getAdminAudit(25));
            setAuditNote(null);
        } catch (e) {
            setAudit([]);
            setAuditNote(e.status === 401
                ? 'The audit trail needs a signed-in admin session (token access does not unlock it).'
                : e.message);
        }
    }
    useEffect(() => { load(); loadAudit(); }, []);

    const groups = useMemo(() => {
        const by = new Map();
        for (const r of rows ?? []) {
            if (!by.has(r.group)) by.set(r.group, []);
            by.get(r.group).push(r);
        }
        return [...by.entries()];
    }, [rows]);

    // ONE dirty-truth: the sticky bar's count and the save payload both come
    // from this diff, so they can never disagree.
    const diff = useMemo(() => settingsDiff(rows ?? [], edits), [rows, edits]);
    const dirtyKeys = useMemo(() => new Set([...Object.keys(diff.set), ...diff.reset]), [diff]);
    const regimeTouched = useMemo(
        () => (rows ?? []).filter(r => dirtyKeys.has(r.key) && r.regime).map(r => r.label),
        [rows, dirtyKeys]);
    const restartTouched = useMemo(
        () => (rows ?? []).filter(r => dirtyKeys.has(r.key) && !r.live).map(r => r.key),
        [rows, dirtyKeys]);

    async function save() {
        setBusy(true);
        setError(null);
        setNotice(null);
        // The server's all-or-nothing guarantee covers the PUT batch only; the
        // blank-value resets are a separate DELETE per key that necessarily
        // runs AFTER it. So a failure partway (network blip, session expiry)
        // leaves the overrides half-applied. What must not ALSO happen is the
        // UI lying about it: previously a throw skipped setEdits({}) wholesale,
        // so every edit still looked pending even though the PUT had committed.
        // Track what actually landed and clear exactly that, then name the keys
        // that did not.
        const restartKeys = [];
        const applied = [];
        const failed = [];
        try {
            if (Object.keys(diff.set).length) {
                const res = await putAdminSettings(diff.set);
                restartKeys.push(...(res.restart_required ?? []));
                applied.push(...Object.keys(diff.set));
            }
            for (const key of diff.reset) {
                try {
                    const res = await deleteAdminSetting(key);
                    if (res.restart_required) restartKeys.push(key);
                    applied.push(key);
                } catch (e) {
                    failed.push(`${key} (${e.message})`);
                }
            }
            // Drop only the edits that really landed, so anything still shown
            // as pending genuinely is.
            setEdits(prev => {
                const next = { ...prev };
                for (const k of applied) delete next[k];
                return next;
            });
            await Promise.all([load(), loadAudit()]);
            if (failed.length) {
                setError(`Partly saved. These were NOT reset: ${failed.join('; ')}`);
            } else {
                setNotice(restartKeys.length
                    ? `Saved. Restart required for: ${restartKeys.join(', ')}`
                    : 'Saved - changes are live.');
            }
        } catch (e) {
            // The PUT itself failed: nothing was written (server-side
            // all-or-nothing), so every edit correctly stays pending.
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function reset(key) {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = await deleteAdminSetting(key);
            setEdits(({ [key]: _drop, ...rest }) => rest);
            await Promise.all([load(), loadAudit()]);
            setNotice(res.restart_required ? `Reset. Restart required for: ${key}` : `Reset ${key} - live.`);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    if (rows == null) return <p className="text-label-2 text-sm py-8 text-center">Loading settings…</p>;

    const edit = (key, value) => setEdits(prev => ({ ...prev, [key]: value }));
    const inputCls = 'bg-surface border border-separator text-label rounded-lg h-9 px-2.5 text-[13px] outline-none focus:border-accent disabled:opacity-40';

    function control(r) {
        const editing = Object.prototype.hasOwnProperty.call(edits, r.key);
        const shown = editing ? edits[r.key] : r.effective;
        if (r.type === 'boolean') {
            return <Switch checked={Boolean(shown)} disabled={busy} onChange={v => edit(r.key, v)} />;
        }
        if (r.enum) {
            return (
                <select className={`${inputCls} w-36`} value={String(shown ?? '')} disabled={busy}
                    onChange={e => edit(r.key, e.target.value)}>
                    {r.enum.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
            );
        }
        if (r.type === 'int' || r.type === 'number') {
            return (
                <NumberInput className={`${inputCls} w-28`} value={shown ?? ''} disabled={busy}
                    min={r.min ?? undefined} max={r.max ?? undefined} int={r.type === 'int'}
                    onCommit={n => edit(r.key, n)} />
            );
        }
        // string (pattern-validated soft, server stays authoritative)
        const val = String(shown ?? '');
        const bad = r.pattern && !safePatternTest(r.pattern, val);
        return (
            <input className={`${inputCls} w-52 ${bad ? 'border-hot' : ''}`} value={val} disabled={busy}
                placeholder={r.pattern_hint ?? ''} title={r.pattern_hint ?? undefined}
                onChange={e => edit(r.key, e.target.value)} />
        );
    }

    return (
        <div className="flex flex-col gap-5">
            {groups.map(([group, list]) => (
                <section key={group} className="bg-surface rounded-2xl border border-separator-2 overflow-hidden">
                    <h2 className="px-4 pt-3 pb-2 text-[13px] font-semibold text-label">{GROUP_LABELS[group] ?? group}</h2>
                    <div className="divide-y divide-separator-2">
                        {list.map(r => (
                            <div key={r.key}
                                className={`px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 ${
                                    dirtyKeys.has(r.key) ? 'bg-accent/5' : ''}`}>
                                <div className="flex-1 min-w-[220px]">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[13px] text-label font-medium">{r.label}</span>
                                        <Badge live={r.live} />
                                        {r.regime && <RegimeChip />}
                                        {r.override != null && <span className="text-[10px] text-accent font-medium">overridden</span>}
                                    </div>
                                    <p className="text-[11px] text-label-2 mt-0.5 max-w-prose">{r.hint}</p>
                                    <p className="text-[11px] text-label-3 mt-0.5">
                                        <code className="text-[10px]">{r.key}</code>
                                        {' · '}default {fmt(r.default)}
                                        {(r.min != null || r.max != null) && ` · ${r.min ?? ''}…${r.max ?? ''}`}
                                    </p>
                                </div>
                                <div className="flex items-center gap-2">
                                    {control(r)}
                                    {r.unit && <span className="text-[11px] text-label-3 w-10">{r.unit}</span>}
                                    <button onClick={() => reset(r.key)} disabled={busy || r.override == null}
                                        title="Remove the override - back to the config default"
                                        className="cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-fill hover:bg-fill-hover text-label-2 disabled:opacity-30 disabled:cursor-default">Reset</button>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            ))}

            {error && <p className="text-miss text-[13px]" role="alert">{error}</p>}
            {notice && <p className="text-accent text-[13px]" role="status">{notice}</p>}

            {/* Sticky save bar - present ONLY while settingsDiff is non-empty. */}
            {diff.count > 0 && (
                <div className="sticky bottom-3 z-10">
                    <div className="bg-surface/95 backdrop-blur border border-separator rounded-2xl shadow-lg px-4 py-3 flex flex-col gap-2">
                        {regimeTouched.length > 0 && (
                            <p className="text-[12px] text-hot">
                                ⚠ Policy-regime change ({regimeTouched.join(', ')}): this alters which picks/verdicts
                                get generated - the settled ledger splits at this date. The audit trail records it.
                            </p>
                        )}
                        {restartTouched.length > 0 && (
                            <p className="text-[12px] text-label-2">Restart required to apply: {restartTouched.join(', ')}</p>
                        )}
                        <div className="flex items-center gap-3">
                            <button onClick={save} disabled={busy}
                                className="cursor-pointer h-10 px-5 rounded-[10px] bg-accent text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
                                {busy ? 'Saving…' : `Save ${diff.count} change${diff.count === 1 ? '' : 's'}`}
                            </button>
                            <button onClick={() => setEdits({})} disabled={busy}
                                className="cursor-pointer h-10 px-4 rounded-[10px] bg-fill hover:bg-fill-hover text-label-2 text-[13px] disabled:opacity-40">Discard</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Recent changes - the M6 admin_audit trail, newest first. */}
            <section className="bg-surface rounded-2xl border border-separator-2 overflow-hidden">
                <h2 className="px-4 pt-3 pb-2 text-[13px] font-semibold text-label">Recent changes</h2>
                {auditNote ? (
                    <p className="px-4 pb-3 text-[12px] text-label-2">{auditNote}</p>
                ) : !audit?.length ? (
                    <p className="px-4 pb-3 text-[12px] text-label-3">No settings changes recorded yet.</p>
                ) : (
                    <div className="divide-y divide-separator-2">
                        {audit.map(a => (
                            <div key={a.id} className="px-4 py-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[12px]">
                                <span className="text-label-3 tabular-nums shrink-0">{fmtWhen(a.created_at)}</span>
                                <code className="text-label">{a.target}</code>
                                <span className="text-label-2">
                                    {fmtAudit(a.old_value)} → {fmtAudit(a.new_value)}
                                </span>
                                <span className="text-label-3">{a.actor_phone ?? 'admin token'}</span>
                            </div>
                        ))}
                    </div>
                )}
            </section>
        </div>
    );
}
