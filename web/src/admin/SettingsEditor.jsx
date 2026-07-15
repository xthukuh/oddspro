import { useEffect, useMemo, useState } from 'react';
import { getAdminSettings, putAdminSettings, deleteAdminSetting } from '../api.js';

// Dynamic-settings editor over the P4 admin endpoints. Each catalog row shows
// its default vs override vs effective value plus a live/restart badge (live =
// the consumer late-reads it; restart = read once at boot/scheduler start).
// Edits accumulate locally and save as ONE batch PUT - the server validates
// all-or-nothing (M7) and answers with the keys that still need a restart.
const GROUP_LABELS = { safe: 'Safe-only selection', refresh: 'Refresh & scheduler', features: 'Feature flags' };

function Badge({ live }) {
    return live
        ? <span className="text-[10px] font-semibold uppercase tracking-wide text-hit bg-hit/10 rounded px-1.5 py-0.5">live</span>
        : <span className="text-[10px] font-semibold uppercase tracking-wide text-hot bg-hot/10 rounded px-1.5 py-0.5">restart</span>;
}

const fmt = v => (v == null ? '–' : String(v));

export default function SettingsEditor() {
    const [rows, setRows] = useState(null);
    const [edits, setEdits] = useState({}); // key -> raw input value (string | boolean)
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    async function load() {
        setError(null);
        try {
            setRows(await getAdminSettings());
        } catch (e) {
            setError(e.message);
            setRows([]);
        }
    }
    useEffect(() => { load(); }, []);

    const groups = useMemo(() => {
        const by = new Map();
        for (const r of rows ?? []) {
            if (!by.has(r.group)) by.set(r.group, []);
            by.get(r.group).push(r);
        }
        return [...by.entries()];
    }, [rows]);

    const dirty = Object.keys(edits).length > 0;

    async function save() {
        setBusy(true);
        setError(null);
        setNotice(null);
        try {
            const res = await putAdminSettings(edits);
            setEdits({});
            await load();
            setNotice(res.restart_required?.length
                ? `Saved. Restart required for: ${res.restart_required.join(', ')}`
                : 'Saved - changes are live.');
        } catch (e) {
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
            await load();
            setNotice(res.restart_required ? `Reset. Restart required for: ${key}` : `Reset ${key} - live.`);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    if (rows == null) return <p className="text-label-2 text-sm py-8 text-center">Loading settings…</p>;

    const inputCls = 'w-36 bg-surface border border-separator text-label rounded-lg h-9 px-2.5 text-[13px] outline-none focus:border-accent';

    return (
        <div className="flex flex-col gap-5">
            {groups.map(([group, list]) => (
                <section key={group} className="bg-surface rounded-2xl border border-separator-2 overflow-hidden">
                    <h2 className="px-4 pt-3 pb-2 text-[13px] font-semibold text-label">{GROUP_LABELS[group] ?? group}</h2>
                    <div className="divide-y divide-separator-2">
                        {list.map(r => {
                            const editing = Object.prototype.hasOwnProperty.call(edits, r.key);
                            const shown = editing ? edits[r.key] : r.effective;
                            return (
                                <div key={r.key} className="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                                    <div className="flex-1 min-w-[180px]">
                                        <div className="flex items-center gap-2">
                                            <code className="text-[12px] text-label">{r.key}</code>
                                            <Badge live={r.live} />
                                            {r.override != null && <span className="text-[10px] text-accent font-medium">overridden</span>}
                                        </div>
                                        <div className="text-[11px] text-label-3">
                                            default {fmt(r.default)}
                                            {(r.min != null || r.max != null) && ` · ${r.min ?? ''}…${r.max ?? ''}`}
                                        </div>
                                    </div>
                                    {r.type === 'boolean' ? (
                                        <select className={inputCls} value={String(shown)} disabled={busy}
                                            onChange={e => setEdits(prev => ({ ...prev, [r.key]: e.target.value === 'true' }))}>
                                            <option value="true">On</option>
                                            <option value="false">Off</option>
                                        </select>
                                    ) : (
                                        <input className={inputCls} value={shown ?? ''} disabled={busy}
                                            inputMode={r.type === 'string' ? 'text' : 'decimal'}
                                            onChange={e => setEdits(prev => ({ ...prev, [r.key]: e.target.value }))} />
                                    )}
                                    <button onClick={() => reset(r.key)} disabled={busy || r.override == null}
                                        title="Remove the override - back to the config default"
                                        className="cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-fill hover:bg-fill-hover text-label-2 disabled:opacity-30 disabled:cursor-default">Reset</button>
                                </div>
                            );
                        })}
                    </div>
                </section>
            ))}
            <div className="flex items-center gap-3">
                <button onClick={save} disabled={!dirty || busy}
                    className="cursor-pointer h-10 px-5 rounded-[10px] bg-accent text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
                    {busy ? 'Saving…' : `Save changes${dirty ? ` (${Object.keys(edits).length})` : ''}`}
                </button>
                {dirty && !busy && (
                    <button onClick={() => setEdits({})}
                        className="cursor-pointer h-10 px-4 rounded-[10px] bg-fill hover:bg-fill-hover text-label-2 text-[13px]">Discard</button>
                )}
            </div>
            {error && <p className="text-miss text-[13px]" role="alert">{error}</p>}
            {notice && <p className="text-accent text-[13px]" role="status">{notice}</p>}
        </div>
    );
}
