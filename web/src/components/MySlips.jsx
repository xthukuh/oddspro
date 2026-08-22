import { useEffect, useState } from 'react';
import Sheet, { SheetClose } from './Sheet.jsx';
import { fetchMySlips, fetchSlipByCode, deleteUserSlip } from '../api.js';

// My slips (engine-v2 Phase 4): the account's saved betslips as a personal
// timeline (created_at is the stamp), settled server-side like the Daily
// MultiBet, plus load-by-code - entering a friend's 6-char code opens their
// slip in the playground as an editable copy (saving mints YOUR OWN code
// with provenance; the original is never touched).

const _fmtDay = ts => String(ts ?? '').replace('T', ' ').slice(0, 16);

function Badge({ outcome }) {
    if (outcome === 'won') return <span className="text-[11px] font-bold text-green">WON</span>;
    if (outcome === 'lost') return <span className="text-[11px] font-bold text-miss">LOST</span>;
    if (outcome === 'void') return <span className="text-[11px] text-label-3">VOID</span>;
    return <span className="text-[11px] text-label-2">pending</span>;
}

export default function MySlips({ onClose, onLoad }) {
    const [slips, setSlips] = useState(null);
    const [error, setError] = useState(null);
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);

    const reload = () => fetchMySlips().then(setSlips).catch(e => setError(e?.message ?? String(e)));
    useEffect(() => { reload(); }, []);

    const loadCode = async e => {
        e.preventDefault();
        if (!code.trim() || busy) return;
        setBusy(true); setError(null);
        try {
            const slip = await fetchSlipByCode(code.trim());
            onLoad(slip, { copyOf: slip.code });
        } catch (e2) {
            setError(e2?.message ?? String(e2));
        } finally {
            setBusy(false);
        }
    };

    const remove = async s => {
        if (!window.confirm(`Delete slip ${s.code}${s.title ? ` (${s.title})` : ''}? The share code stops working.`)) return;
        try { await deleteUserSlip(s.id); await reload(); }
        catch (e) { setError(e?.message ?? String(e)); }
    };

    return (
        <Sheet onClose={onClose} className="max-w-md">
            <div className="flex flex-col max-h-[calc(100dvh-4.5rem)]">
                <div className="flex items-center gap-3 px-6 pt-5 pb-2">
                    <h2 className="text-[22px] font-extrabold tracking-tight">My slips</h2>
                    <div className="ml-auto"><SheetClose onClose={onClose} /></div>
                </div>
                <form onSubmit={loadCode} className="px-6 pb-3 flex items-center gap-2">
                    <input value={code} onChange={e => setCode(e.target.value)} placeholder="Load by code, e.g. 7K3F9Q"
                        className="h-9 flex-1 min-w-0 px-2.5 rounded-lg bg-fill text-label text-[13px] outline-none focus:ring-1 focus:ring-accent uppercase" />
                    <button type="submit" disabled={busy || !code.trim()}
                        className="cursor-pointer h-9 px-3.5 rounded-lg bg-accent text-white text-[13px] font-semibold disabled:opacity-50">
                        Load
                    </button>
                </form>
                {error && <div className="mx-6 mb-2 text-[13px] text-miss">{error}</div>}
                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 space-y-2">
                    {!error && slips == null && <div className="px-2 text-sm text-label-3">Loading...</div>}
                    {slips?.length === 0 && <div className="px-2 text-sm text-label-3">Nothing saved yet - build a slip and hit Save.</div>}
                    {slips?.map(s => (
                        <div key={s.id} className="rounded-xl border border-separator px-3.5 py-2.5">
                            <div className="flex items-center gap-2">
                                <button className="cursor-pointer font-mono text-[13px] font-semibold text-accent hover:underline"
                                    title="Copy the share code"
                                    onClick={() => navigator.clipboard?.writeText(s.code)}>{s.code}</button>
                                <span className="text-[13px] text-label truncate">{s.title ?? ''}</span>
                                <span className="ml-auto text-[12px] tabular-nums text-label-2 shrink-0">
                                    {s.legs_total} legs @ {Number(s.combined_odds).toFixed(2)}x
                                </span>
                                <Badge outcome={s.outcome} />
                            </div>
                            <div className="mt-0.5 flex items-center gap-3 text-[11.5px] text-label-3">
                                <span>{_fmtDay(s.created_at)}</span>
                                {s.outcome != null && <span>{s.legs_hit ?? 0}/{s.legs_total} landed</span>}
                                {s.source_code && <span title="Copied from a shared slip">from {s.source_code}</span>}
                                <span className="grow" />
                                <button className="cursor-pointer text-accent hover:underline"
                                    onClick={() => onLoad(s, {})}>Open in playground</button>
                                <button className="cursor-pointer text-miss hover:underline" onClick={() => remove(s)}>Delete</button>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </Sheet>
    );
}
