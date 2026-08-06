import { useCallback, useEffect, useState } from 'react';
import { getAdminPats, createAdminPat, revokeAdminPat, getAdminUsers } from '../api.js';

// API tokens admin section (engine-v2 Phase 2): mint/list/revoke personal
// access tokens for third-party integrations (n8n) and automated reads.
// Uncomplicated-design philosophy: one list, one mint form, one reveal box.
// The plaintext token is shown EXACTLY ONCE after minting - the server only
// stores its hash - so the reveal box is explicit and copy-first.

const fmt = ts => (ts ? String(ts).replace('T', ' ').slice(0, 16) : '—');

export default function TokensSection() {
    const [tokens, setTokens] = useState(null);
    const [users, setUsers] = useState([]);
    const [error, setError] = useState(null);
    const [minted, setMinted] = useState(null);      // { token, pat } - shown once
    const [form, setForm] = useState({ user_id: '', name: '', expires_days: '' });
    const [busy, setBusy] = useState(false);

    const reload = useCallback(async () => {
        try { setTokens(await getAdminPats()); setError(null); }
        catch (e) { setError(e?.message ?? String(e)); }
    }, []);

    useEffect(() => { reload(); }, [reload]);
    useEffect(() => {
        // User picker is session-only server-side; an ADMIN_TOKEN-bearer admin
        // still gets the section, just with a manual id field.
        getAdminUsers().then(r => setUsers(r?.users ?? [])).catch(() => setUsers([]));
    }, []);

    const mint = async e => {
        e.preventDefault();
        if (busy) return;
        setBusy(true);
        try {
            const out = await createAdminPat({
                user_id: Number(form.user_id),
                name: form.name.trim(),
                expires_days: form.expires_days ? Number(form.expires_days) : null,
            });
            setMinted(out);
            setForm({ user_id: '', name: '', expires_days: '' });
            await reload();
        } catch (e2) {
            setError(e2?.message ?? String(e2));
        } finally {
            setBusy(false);
        }
    };

    const revoke = async t => {
        if (!window.confirm(`Revoke token ${t.prefix}… (${t.name})? Integrations using it stop working immediately.`)) return;
        try { await revokeAdminPat(t.id); await reload(); }
        catch (e) { setError(e?.message ?? String(e)); }
    };

    const inputCls = 'h-9 px-2.5 rounded-lg bg-fill text-label text-[13px] outline-none focus:ring-1 focus:ring-accent';

    return (
        <div className="max-w-3xl space-y-5">
            <div>
                <h2 className="text-label text-base font-semibold">API tokens</h2>
                <p className="text-label-2 text-[12px] mt-1 leading-relaxed">
                    Personal access tokens for integrations (n8n, automated reads). A token acts as its
                    user on read-only GET endpoints (<code className="text-label">/api/view</code>,{' '}
                    <code className="text-label">/api/records</code>, <code className="text-label">/api/daily-slip</code>…)
                    and is never valid on admin or account endpoints. Only a hash is stored.
                </p>
            </div>

            {error && <div className="text-[13px] text-red bg-red/10 rounded-lg px-3 py-2">{error}</div>}

            {minted && (
                <div className="rounded-xl border border-accent/40 bg-accent/5 p-3 space-y-2">
                    <div className="text-[13px] text-label font-medium">Token minted — copy it now, it is shown only once.</div>
                    <div className="flex items-center gap-2">
                        <code className="flex-1 min-w-0 truncate text-[12px] bg-fill rounded-lg px-2.5 py-2 text-label">{minted.token}</code>
                        <button className="cursor-pointer h-9 px-3 rounded-lg bg-accent text-white text-[13px] font-medium shrink-0"
                            onClick={() => navigator.clipboard?.writeText(minted.token)}>Copy</button>
                        <button className="cursor-pointer h-9 px-3 rounded-lg bg-fill text-label-2 text-[13px] shrink-0"
                            onClick={() => setMinted(null)}>Dismiss</button>
                    </div>
                    <div className="text-[12px] text-label-3">Use as <code>Authorization: Bearer &lt;token&gt;</code>.</div>
                </div>
            )}

            <form onSubmit={mint} className="flex flex-wrap items-end gap-2">
                {users.length ? (
                    <label className="flex flex-col gap-1 text-[12px] text-label-2">User
                        <select className={inputCls} value={form.user_id} required
                            onChange={e => setForm(f => ({ ...f, user_id: e.target.value }))}>
                            <option value="">Select…</option>
                            {users.map(u => <option key={u.id} value={u.id}>{u.name || u.phone} (#{u.id})</option>)}
                        </select>
                    </label>
                ) : (
                    <label className="flex flex-col gap-1 text-[12px] text-label-2">User id
                        <input className={`${inputCls} w-24`} inputMode="numeric" value={form.user_id} required
                            onChange={e => setForm(f => ({ ...f, user_id: e.target.value.replace(/\D/g, '') }))} />
                    </label>
                )}
                <label className="flex flex-col gap-1 text-[12px] text-label-2">Name
                    <input className={`${inputCls} w-44`} value={form.name} required maxLength={64}
                        placeholder="n8n-workflows" onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </label>
                <label className="flex flex-col gap-1 text-[12px] text-label-2">Expires (days, blank = never)
                    <input className={`${inputCls} w-36`} inputMode="numeric" value={form.expires_days}
                        onChange={e => setForm(f => ({ ...f, expires_days: e.target.value.replace(/\D/g, '') }))} />
                </label>
                <button type="submit" disabled={busy}
                    className="cursor-pointer h-9 px-4 rounded-lg bg-accent text-white text-[13px] font-medium disabled:opacity-50">
                    {busy ? 'Minting…' : 'Mint token'}
                </button>
            </form>

            <div className="rounded-xl border border-separator overflow-x-auto">
                <table className="w-full text-[13px]">
                    <thead>
                        <tr className="text-left text-label-3 text-[12px] border-b border-separator">
                            <th className="px-3 py-2 font-medium">Prefix</th>
                            <th className="px-3 py-2 font-medium">Name</th>
                            <th className="px-3 py-2 font-medium">User</th>
                            <th className="px-3 py-2 font-medium">Last used</th>
                            <th className="px-3 py-2 font-medium">Expires</th>
                            <th className="px-3 py-2 font-medium">Status</th>
                            <th className="px-3 py-2" />
                        </tr>
                    </thead>
                    <tbody>
                        {tokens == null && <tr><td colSpan={7} className="px-3 py-4 text-label-3">Loading…</td></tr>}
                        {tokens?.length === 0 && <tr><td colSpan={7} className="px-3 py-4 text-label-3">No tokens yet.</td></tr>}
                        {tokens?.map(t => (
                            <tr key={t.id} className="border-b border-separator/60 last:border-0">
                                <td className="px-3 py-2"><code className="text-label">{t.prefix}…</code></td>
                                <td className="px-3 py-2 text-label">{t.name}</td>
                                <td className="px-3 py-2 text-label-2">{t.user_name || t.user_phone || `#${t.user_id}`}</td>
                                <td className="px-3 py-2 text-label-2">{fmt(t.last_used_at)}</td>
                                <td className="px-3 py-2 text-label-2">{fmt(t.expires_at)}</td>
                                <td className="px-3 py-2">{t.revoked_at
                                    ? <span className="text-red">revoked</span>
                                    : <span className="text-green">active</span>}</td>
                                <td className="px-3 py-2 text-right">
                                    {!t.revoked_at && (
                                        <button className="cursor-pointer h-8 px-3 rounded-lg bg-fill hover:bg-fill-hover text-red text-[12px]"
                                            onClick={() => revoke(t)}>Revoke</button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
