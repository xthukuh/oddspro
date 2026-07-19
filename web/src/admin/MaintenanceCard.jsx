import { useEffect, useState } from 'react';
import { getAdminSettings, putAdminSettings } from '../api.js';
import {
    maintenanceState, parseMaintenanceWindow, renderMaintenanceNotice,
} from '../../../src/db/maintenance-rules.js';
import { Switch } from './SettingsEditor.jsx';

// M14 Maintenance card (Dashboard section): state chip + toggle + window +
// message template with live preview. Writes through the standard settings PUT
// (all-or-nothing validation; every change lands a dated admin_audit row), so
// this card and Admin -> Settings are two faces of the same four keys.

const KEYS = ['MAINTENANCE_SCHEDULED', 'MAINTENANCE_START', 'MAINTENANCE_END', 'MAINTENANCE_MESSAGE'];

// 'YYYY-MM-DD HH:mm' (the stored EAT contract) <-> datetime-local's T form.
const toInput = s => (s ? String(s).replace(' ', 'T') : '');
const fromInput = s => (s ? String(s).replace('T', ' ') : '');

// EAT wall-clock stamp from an epoch: shift +3h, read as UTC - no host-
// timezone decode (the browser running this card may not be in EAT).
const eatStamp = ms => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ');

const CHIP = {
    off: 'text-label-2 bg-fill',
    scheduled: 'text-hot bg-hot/10',
    active: 'text-miss bg-miss/10',
};

const inputCls = 'h-9 px-2 rounded-lg bg-fill border border-separator text-[13px] text-label';

export default function MaintenanceCard() {
    const [form, setForm] = useState(null);   // { scheduled, start, end, message } being edited
    const [savedCfg, setSavedCfg] = useState(null); // last-saved copy - the chip reflects REALITY
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        getAdminSettings().then(rows => {
            const v = k => rows.find(r => r.key === k)?.effective;
            const f = {
                scheduled: Boolean(v('MAINTENANCE_SCHEDULED')),
                start: v('MAINTENANCE_START') ?? '',
                end: v('MAINTENANCE_END') ?? '',
                message: v('MAINTENANCE_MESSAGE') ?? '',
            };
            setForm(f);
            setSavedCfg(f);
        }).catch(e => setError(e.message));
    }, []);
    // The chip follows the clock (scheduled -> active -> off) without a reload.
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 30_000);
        return () => clearInterval(id);
    }, []);

    if (error && !form) return <p className="text-miss text-[13px]" role="alert">Maintenance settings failed: {error}</p>;
    if (!form) return null;

    const state = maintenanceState(savedCfg, now);
    const dirty = JSON.stringify(form) !== JSON.stringify(savedCfg);
    const win = parseMaintenanceWindow(form.start, form.end);
    const preview = renderMaintenanceNotice(form.message, win);
    const set = patch => { setForm(f => ({ ...f, ...patch })); setNotice(null); setError(null); };

    const presetHour = () => {
        const start = Math.ceil(Date.now() / 300_000) * 300_000; // next 5-min mark
        set({ scheduled: true, start: eatStamp(start), end: eatStamp(start + 3_600_000) });
    };

    async function save() {
        setBusy(true);
        setError(null);
        try {
            await putAdminSettings({
                MAINTENANCE_SCHEDULED: form.scheduled,
                MAINTENANCE_START: form.start,
                MAINTENANCE_END: form.end,
                MAINTENANCE_MESSAGE: form.message,
            });
            setSavedCfg(form);
            setNotice('Saved - the schedule is live (clients pick it up within a minute).');
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="bg-surface border border-separator-2 rounded-2xl p-4 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-[13px] font-semibold text-label">Maintenance</h3>
                <span className={`text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 ${CHIP[state]}`}>
                    {state}
                </span>
                <div className="ml-auto flex items-center gap-2">
                    <span className="text-[11px] text-label-2">Scheduled</span>
                    <Switch checked={form.scheduled} onChange={v => set({ scheduled: v })} disabled={busy} />
                </div>
            </div>
            <p className="text-[11px] text-label-3 mt-0.5 mb-3">
                Visitors get a dismissible warning banner before the window and a full-screen downtime
                notice (API 503, admins bypass) during it; it expires to off on its own at the end.
            </p>

            <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1 text-[11px] text-label-2">
                    Starts (EAT)
                    <input type="datetime-local" className={inputCls} value={toInput(form.start)}
                        onChange={e => set({ start: fromInput(e.target.value) })} disabled={busy} />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-label-2">
                    Ends (EAT)
                    <input type="datetime-local" className={inputCls} value={toInput(form.end)}
                        onChange={e => set({ end: fromInput(e.target.value) })} disabled={busy} />
                </label>
                <button onClick={presetHour} disabled={busy}
                    className="cursor-pointer h-9 px-3 rounded-full text-[12px] font-medium bg-fill text-label-2 hover:bg-fill-hover">
                    +1h from now
                </button>
            </div>
            {form.scheduled && !win && (
                <p className="text-[11px] text-hot mt-1.5">
                    Set a valid window (end after start) - maintenance stays OFF without one.
                </p>
            )}

            <label className="block mt-3 text-[11px] text-label-2">
                Message template <span className="text-label-3">- placeholders {'${downtime_start}'} / {'${downtime_end}'}</span>
                <textarea rows={2} className={`${inputCls} mt-1 w-full h-auto py-1.5 resize-y`}
                    value={form.message} onChange={e => set({ message: e.target.value })} disabled={busy} />
            </label>
            <p className="text-[11px] text-label-3 mt-1">
                Preview: <span className="text-label-2">{preview}</span>
            </p>

            <div className="flex items-center gap-3 mt-3">
                <button onClick={save} disabled={busy || !dirty}
                    className="cursor-pointer h-9 px-4 rounded-full text-[12px] font-semibold bg-accent text-white disabled:opacity-40 disabled:cursor-default">
                    {busy ? 'Saving…' : 'Save schedule'}
                </button>
                {dirty && !busy && (
                    <button onClick={() => { setForm(savedCfg); setError(null); }}
                        className="cursor-pointer h-9 px-3 rounded-full text-[12px] font-medium bg-fill text-label-2 hover:bg-fill-hover">
                        Discard
                    </button>
                )}
                {notice && <span className="text-[11px] text-hit">{notice}</span>}
                {error && form && <span className="text-[11px] text-miss" role="alert">{error}</span>}
            </div>
        </div>
    );
}
