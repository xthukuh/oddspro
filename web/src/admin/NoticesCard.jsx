import { useEffect, useState } from 'react';
import { getAdminNotices, patchAdminNotice, createAdminNotice } from '../api.js';
import { noticeLabel } from '../../../src/db/notice-rules.js';

// Data-quality notices (Dashboard). Auto-detected spans arrive unconfirmed and
// are ALREADY shown to visitors with an UNCONFIRMED prefix; this card is where
// that hedge gets removed, or the proposal gets thrown out. Dismissing is
// permanent: the span unique index stops the detector proposing it again.

const CHIP = {
    unconfirmed: 'text-hot bg-hot/10',
    approved: 'text-hit bg-hit/10',
    dismissed: 'text-label-3 bg-fill',
};

const inputCls = 'h-9 px-2 rounded-lg bg-fill border border-separator text-[13px] text-label';

const BLANK = {
    kind: 'odds_outage', severity: 'outage',
    date_from: '', date_to: '',
    title: 'No odds collected',
    note: 'Collection was down. Odds for these games were never captured.',
};

export default function NoticesCard() {
    const [rows, setRows] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [adding, setAdding] = useState(false);
    const [form, setForm] = useState(BLANK);

    const load = () => getAdminNotices().then(setRows).catch(e => setError(e.message));
    useEffect(() => { load(); }, []);

    if (error && !rows) return <p className="text-miss text-[13px]" role="alert">Notices failed: {error}</p>;
    if (!rows) return null;

    async function setStatus(n, status) {
        if (status === 'dismissed'
            && !window.confirm(`Dismiss "${n.title}" for ${n.date_from} to ${n.date_to}?\n\nIt stops being shown and will never be proposed again.`)) return;
        setBusy(true);
        setError(null);
        try {
            await patchAdminNotice(n.id, status);
            await load();
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    }

    async function add() {
        setBusy(true);
        setError(null);
        try {
            await createAdminNotice(form);
            setForm(BLANK);
            setAdding(false);
            await load();
        } catch (e) { setError(e.message); } finally { setBusy(false); }
    }

    const pending = rows.filter(r => r.status === 'unconfirmed').length;
    const set = patch => setForm(f => ({ ...f, ...patch }));

    return (
        <div className="bg-surface border border-separator-2 rounded-2xl p-4 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-[13px] font-semibold text-label">Data notices</h3>
                {pending > 0 && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 text-hot bg-hot/10">
                        {pending} to review
                    </span>
                )}
                <button onClick={() => setAdding(a => !a)} disabled={busy}
                    className="cursor-pointer ml-auto h-8 px-3 rounded-full text-[12px] font-medium bg-fill text-label-2 hover:bg-fill-hover">
                    {adding ? 'Cancel' : 'Add notice'}
                </button>
            </div>
            <p className="text-[11px] text-label-3 mt-0.5 mb-3">
                Warnings shown to visitors on damaged days. Detected ones show as UNCONFIRMED until you approve them.
            </p>

            {adding && (
                <div className="flex flex-wrap items-end gap-2 mb-3 pb-3 border-b border-separator-2">
                    <label className="flex flex-col gap-1 text-[11px] text-label-2">From
                        <input type="date" className={inputCls} value={form.date_from}
                            onChange={e => set({ date_from: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-label-2">To
                        <input type="date" className={inputCls} value={form.date_to}
                            onChange={e => set({ date_to: e.target.value })} />
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-label-2">Severity
                        <select className={inputCls} value={form.severity}
                            onChange={e => set({
                                severity: e.target.value,
                                kind: e.target.value === 'outage' ? 'odds_outage' : 'odds_degraded',
                                title: e.target.value === 'outage' ? 'No odds collected' : 'Some odds missing',
                                note: e.target.value === 'outage'
                                    ? 'Collection was down. Odds for these games were never captured.'
                                    : 'Collection ran but did not finish. Some games have no odds.',
                            })}>
                            <option value="outage">Outage</option>
                            <option value="degraded">Degraded</option>
                        </select>
                    </label>
                    <label className="flex flex-col gap-1 text-[11px] text-label-2 grow min-w-[200px]">Note
                        <input className={inputCls} value={form.note} onChange={e => set({ note: e.target.value })} />
                    </label>
                    <button onClick={add} disabled={busy || !form.date_from || !form.date_to}
                        className="cursor-pointer h-9 px-4 rounded-full text-[12px] font-semibold bg-accent text-white disabled:opacity-40 disabled:cursor-default">
                        Save
                    </button>
                </div>
            )}

            {!rows.length && <p className="text-[12px] text-label-3">No notices. Nothing is flagged.</p>}
            <ul className="flex flex-col gap-2">
                {rows.map(n => (
                    <li key={n.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 ${CHIP[n.status]}`}>
                            {n.status}
                        </span>
                        <span className="text-label-2 tabular-nums whitespace-nowrap">
                            {n.date_from}{n.date_to !== n.date_from ? ` to ${n.date_to}` : ''}
                        </span>
                        <span className="text-label grow min-w-[140px]">{noticeLabel(n)}</span>
                        <span className="text-[10px] text-label-3">{n.source}</span>
                        {n.status !== 'approved' && (
                            <button onClick={() => setStatus(n, 'approved')} disabled={busy}
                                className="cursor-pointer h-7 px-2.5 rounded-full text-[11px] font-medium bg-hit/10 text-hit hover:bg-hit/20">
                                Approve
                            </button>
                        )}
                        {n.status !== 'dismissed' && (
                            <button onClick={() => setStatus(n, 'dismissed')} disabled={busy}
                                className="cursor-pointer h-7 px-2.5 rounded-full text-[11px] font-medium bg-fill text-label-2 hover:bg-fill-hover">
                                Dismiss
                            </button>
                        )}
                    </li>
                ))}
            </ul>
            {error && <p className="text-[11px] text-miss mt-2" role="alert">{error}</p>}
        </div>
    );
}
