import { useEffect, useMemo, useState } from 'react';
import { getAdminUsers, patchAdminUser } from '../api.js';
import { stageSelection } from './campaignHandoff.js';
import { adminHash } from './useAdminRoute.js';
import { useSession } from '../auth/SessionProvider.jsx';
import { Z } from '../zLayers.js';

// Admin Users section (M8): list + search + guarded row actions over
// GET/PATCH /api/admin/users. The server is authoritative (pure guards in
// src/db/admin-rules.js reject self-disable/demote, self PIN actions and
// removing the last active admin) - this UI additionally HIDES the self
// footguns so the 400s are never provoked in normal use. Dangerous actions
// (disable, PIN reset, role changes) require a typed confirmation word; a PIN
// reset reveals the temp PIN exactly once (it is never stored in plaintext).
// Row multi-select feeds the M9 campaign "selection" audience.

const TONES = {
    hit: 'text-hit bg-hit/10',
    miss: 'text-miss bg-miss/10',
    hot: 'text-hot bg-hot/10',
    accent: 'text-accent bg-accent/10',
    muted: 'text-label-2 bg-fill',
};
function Chip({ tone = 'muted', title, children }) {
    return (
        <span title={title}
            className={`inline-block text-[10px] font-semibold uppercase tracking-wide rounded px-1.5 py-0.5 whitespace-nowrap ${TONES[tone]}`}>
            {children}
        </span>
    );
}

const fmtWhen = v => {
    if (v == null) return '–';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v)
        : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const isLockedNow = u => (u.locked_until != null && new Date(u.locked_until).getTime() > Date.now()) || u.pin_attempts > 0;

// Dangerous actions and their typed confirmation words. Benign actions
// (enable, verify, unlock, force PIN change) apply on click.
const CONFIRMS = {
    disable: {
        word: 'DISABLE', label: 'Disable', patch: { is_active: false },
        body: 'Signs the user out of every device and blocks sign-in until re-enabled.',
    },
    reset_pin: {
        word: 'RESET', label: 'Reset PIN', patch: { reset_pin: true },
        body: 'Issues a temporary 4-digit PIN (shown once), signs the user out everywhere, and forces a PIN change at the next sign-in.',
    },
    make_admin: {
        word: 'ADMIN', label: 'Make admin', patch: { role: 'admin' },
        body: 'Grants full access to this admin area, settings and user management.',
    },
    make_normal: {
        word: 'NORMAL', label: 'Remove admin', patch: { role: 'normal' },
        body: 'Revokes admin access. Their signed-in sessions stay valid as a normal user.',
    },
};

function ConfirmDialog({ user, action, busy, onConfirm, onCancel }) {
    const [typed, setTyped] = useState('');
    const c = CONFIRMS[action];
    const ok = typed.trim() === c.word;
    return (
        <div className={`fixed inset-0 ${Z.modalCard} bg-black/30 flex items-center justify-center p-4`}>
            <div className="bg-surface border border-separator rounded-2xl shadow-lg w-full max-w-sm p-5">
                <h3 className="text-label text-sm font-semibold">{c.label}: {user.name}</h3>
                <p className="text-label-2 text-[12px] mt-0.5">{user.phone}</p>
                <p className="text-label-2 text-[12px] mt-2">{c.body}</p>
                <p className="text-label text-[12px] mt-3">Type <code className="font-semibold">{c.word}</code> to confirm.</p>
                <input autoFocus value={typed} onChange={e => setTyped(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && ok && !busy) onConfirm(); }}
                    className="mt-1.5 w-full bg-app border border-separator text-label rounded-lg h-9 px-2.5 text-[13px] outline-none focus:border-accent"
                    placeholder={c.word} />
                <div className="mt-4 flex items-center justify-end gap-2">
                    <button onClick={onCancel} disabled={busy}
                        className="cursor-pointer h-9 px-4 rounded-lg bg-fill hover:bg-fill-hover text-label-2 text-[13px] disabled:opacity-40">Cancel</button>
                    <button onClick={onConfirm} disabled={!ok || busy}
                        className="cursor-pointer h-9 px-4 rounded-lg bg-miss text-white text-[13px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-default">
                        {busy ? 'Working…' : c.label}
                    </button>
                </div>
            </div>
        </div>
    );
}

// One-time temp-PIN reveal. The PIN exists only in this response - closing the
// dialog is the last time anyone (including us) can read it.
function TempPinDialog({ user, pin, onClose }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className={`fixed inset-0 ${Z.modalCard} bg-black/30 flex items-center justify-center p-4`}>
            <div className="bg-surface border border-separator rounded-2xl shadow-lg w-full max-w-sm p-5 text-center">
                <h3 className="text-label text-sm font-semibold">Temporary PIN for {user.name}</h3>
                <p className="text-label-2 text-[12px] mt-0.5">{user.phone}</p>
                <div className="my-4 text-3xl font-bold tracking-[0.35em] tabular-nums text-label pl-[0.35em]">{pin}</div>
                <p className="text-hot text-[12px]">Shown once - share it securely. The user must set a new PIN at their next sign-in.</p>
                <div className="mt-4 flex items-center justify-center gap-2">
                    <button onClick={() => { navigator.clipboard?.writeText(pin).then(() => setCopied(true)).catch(() => {}); }}
                        className="cursor-pointer h-9 px-4 rounded-lg bg-fill hover:bg-fill-hover text-label-2 text-[13px]">
                        {copied ? 'Copied ✓' : 'Copy'}
                    </button>
                    <button onClick={onClose}
                        className="cursor-pointer h-9 px-4 rounded-lg bg-accent text-white text-[13px] font-semibold hover:opacity-90">Done</button>
                </div>
            </div>
        </div>
    );
}

export default function UsersSection() {
    const { user: me } = useSession();
    const [users, setUsers] = useState(null);
    const [total, setTotal] = useState(0);
    const [q, setQ] = useState('');
    const [selected, setSelected] = useState(() => new Set());
    const [busyId, setBusyId] = useState(null);
    const [confirm, setConfirm] = useState(null); // { user, action }
    const [reveal, setReveal] = useState(null);   // { user, pin }
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);

    async function load() {
        setError(null);
        try {
            const { users: list, total: t } = await getAdminUsers();
            setUsers(list);
            setTotal(t);
            setSelected(prev => new Set([...prev].filter(id => list.some(u => u.id === id))));
        } catch (e) {
            setError(e.message);
            setUsers([]);
        }
    }
    useEffect(() => { load(); }, []);

    const shown = useMemo(() => {
        const term = q.trim().toLowerCase();
        if (!term) return users ?? [];
        return (users ?? []).filter(u =>
            u.name.toLowerCase().includes(term) || u.phone.toLowerCase().includes(term));
    }, [users, q]);

    const allShownSelected = shown.length > 0 && shown.every(u => selected.has(u.id));
    const toggleAll = () => setSelected(allShownSelected
        ? new Set()
        : new Set(shown.map(u => u.id)));
    const toggleOne = id => setSelected(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id); else next.add(id);
        return next;
    });

    // Hand the picked ids to the Messaging section (M9) and navigate there.
    // The hash write is what drives useAdminRoute - no prop drilling needed,
    // and it leaves a real history entry so Back returns to the user list.
    const messageSelected = () => {
        const ids = [...selected];
        stageSelection(ids, users.filter(u => selected.has(u.id)).map(u => u.name));
        window.location.hash = adminHash('messaging');
    };

    async function apply(user, patch) {
        setBusyId(user.id);
        setError(null);
        setNotice(null);
        try {
            const res = await patchAdminUser(user.id, patch);
            setUsers(prev => prev.map(u => (u.id === user.id ? res.user : u)));
            if (res.temp_pin) setReveal({ user: res.user, pin: res.temp_pin });
            else setNotice(`Updated ${res.user.name} (${res.user.phone}).`);
        } catch (e) {
            setError(e.message);
        } finally {
            setBusyId(null);
            setConfirm(null);
        }
    }

    if (users == null) return <p className="text-label-2 text-sm py-8 text-center">Loading users…</p>;

    const btn = 'cursor-pointer h-7 px-2 rounded-md text-[11px] bg-fill hover:bg-fill-hover text-label-2 disabled:opacity-30 disabled:cursor-default whitespace-nowrap';

    // Contextual per-row actions. Self footguns are hidden (the server rejects
    // them anyway); dangerous ones open the typed confirm.
    function actions(u) {
        const self = me && u.id === me.id;
        const busy = busyId != null;
        const out = [];
        const plain = (key, label, patch, title) => out.push(
            <button key={key} className={btn} disabled={busy} title={title} onClick={() => apply(u, patch)}>{label}</button>);
        const confirmed = (key, action) => out.push(
            <button key={key} className={btn} disabled={busy} onClick={() => setConfirm({ user: u, action })}>{CONFIRMS[action].label}</button>);

        if (!u.is_active) plain('enable', 'Enable', { is_active: true }, 'Allow sign-in again');
        else if (!self) confirmed('disable', 'disable');
        if (!u.phone_verified) plain('verify', 'Verify', { phone_verified: true }, 'Mark the phone as verified (manual override when SMS fails)');
        else plain('unverify', 'Unverify', { phone_verified: false }, 'Clear the phone-verified flag');
        if (isLockedNow(u)) plain('unlock', 'Unlock', { unlock: true }, 'Clear the PIN lockout and failed attempts');
        if (!self) {
            if (!u.must_change_pin) plain('forcepin', 'Force PIN change', { force_pin_change: true }, 'Require a new PIN at the next sign-in');
            confirmed('resetpin', 'reset_pin');
            if (u.role === 'admin') confirmed('demote', 'make_normal');
            else confirmed('promote', 'make_admin');
        }
        return out;
    }

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search name or phone…"
                    className="bg-surface border border-separator text-label rounded-lg h-9 px-2.5 text-[13px] outline-none focus:border-accent w-56" />
                <span className="text-label-3 text-[12px]">{shown.length} of {total} user{total === 1 ? '' : 's'}</span>
                {selected.size > 0 && (
                    <>
                        <span className="text-[11px] text-accent bg-accent/10 rounded px-2 py-0.5"
                            title="Selection feeds the SMS campaign audience (Messaging, M9)">
                            {selected.size} selected
                            <button className="ml-1.5 cursor-pointer" onClick={() => setSelected(new Set())} title="Clear selection">×</button>
                        </span>
                        <button onClick={messageSelected}
                            title="Open Messaging with these users as the campaign audience"
                            className="cursor-pointer h-7 px-2.5 rounded-lg text-[12px] bg-fill hover:bg-fill-hover text-label-2">
                            Message selected →
                        </button>
                    </>
                )}
                <button onClick={load} disabled={busyId != null}
                    className="ml-auto cursor-pointer h-9 px-3 rounded-lg text-[12px] bg-fill hover:bg-fill-hover text-label-2 disabled:opacity-40">Reload</button>
            </div>

            <div className="bg-surface rounded-2xl border border-separator-2 overflow-x-auto">
                <table className="w-full text-[12px] min-w-[860px]">
                    <thead>
                        <tr className="text-left text-[11px] text-label-3">
                            <th className="pl-4 pr-1 py-2.5 w-8">
                                <input type="checkbox" checked={allShownSelected} onChange={toggleAll}
                                    className="accent-accent h-4 w-4 cursor-pointer" title="Select all shown" />
                            </th>
                            <th className="px-2 py-2.5 font-medium">User</th>
                            <th className="px-2 py-2.5 font-medium">Phone</th>
                            <th className="px-2 py-2.5 font-medium">Role</th>
                            <th className="px-2 py-2.5 font-medium">Status</th>
                            <th className="px-2 py-2.5 font-medium text-right" title="Signed-in devices (unexpired, unrevoked sessions)">Sessions</th>
                            <th className="px-2 py-2.5 font-medium">Last sign-in</th>
                            <th className="px-2 py-2.5 font-medium">Joined</th>
                            <th className="px-2 py-2.5 pr-4 font-medium">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-separator-2">
                        {shown.map(u => {
                            const self = me && u.id === me.id;
                            return (
                                <tr key={u.id} className={busyId === u.id ? 'opacity-50' : ''}>
                                    <td className="pl-4 pr-1 py-2">
                                        <input type="checkbox" checked={selected.has(u.id)} onChange={() => toggleOne(u.id)}
                                            className="accent-accent h-4 w-4 cursor-pointer" />
                                    </td>
                                    <td className="px-2 py-2">
                                        <span className="text-label font-medium">{u.name}</span>
                                        {self && <span className="text-label-3 ml-1">(you)</span>}
                                        {u.must_change_pin && (
                                            <div><Chip tone="hot" title="A new PIN is required at the next sign-in">PIN change pending</Chip></div>
                                        )}
                                    </td>
                                    <td className="px-2 py-2 whitespace-nowrap">
                                        <span className="text-label tabular-nums">{u.phone}</span>
                                        <span className={`ml-1 ${u.phone_verified ? 'text-hit' : 'text-label-3'}`}
                                            title={u.phone_verified ? 'Phone verified' : 'Phone NOT verified'}>
                                            {u.phone_verified ? '✓' : '?'}
                                        </span>
                                    </td>
                                    <td className="px-2 py-2">
                                        <Chip tone={u.role === 'admin' ? 'accent' : 'muted'}>{u.role}</Chip>
                                    </td>
                                    <td className="px-2 py-2">
                                        {!u.is_active ? <Chip tone="miss">Disabled</Chip>
                                            : isLockedNow(u) ? <Chip tone="hot" title={`${u.pin_attempts} failed attempt${u.pin_attempts === 1 ? '' : 's'}${u.locked_until ? ` - locked until ${fmtWhen(u.locked_until)}` : ''}`}>Locked</Chip>
                                                : <Chip tone="hit">Active</Chip>}
                                    </td>
                                    <td className="px-2 py-2 text-right tabular-nums text-label-2">{u.active_sessions}</td>
                                    <td className="px-2 py-2 whitespace-nowrap text-label-2">{fmtWhen(u.last_login_at)}</td>
                                    <td className="px-2 py-2 whitespace-nowrap text-label-2">{fmtWhen(u.created_at)}</td>
                                    <td className="px-2 py-2 pr-4">
                                        <div className="flex flex-wrap gap-1">{actions(u)}</div>
                                    </td>
                                </tr>
                            );
                        })}
                        {!shown.length && (
                            <tr><td colSpan={9} className="px-4 py-6 text-center text-label-3">No users match.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            {error && <p className="text-miss text-[13px]" role="alert">{error}</p>}
            {notice && <p className="text-accent text-[13px]" role="status">{notice}</p>}

            {confirm && (
                <ConfirmDialog user={confirm.user} action={confirm.action} busy={busyId != null}
                    onConfirm={() => apply(confirm.user, CONFIRMS[confirm.action].patch)}
                    onCancel={() => setConfirm(null)} />
            )}
            {reveal && <TempPinDialog user={reveal.user} pin={reveal.pin} onClose={() => setReveal(null)} />}
        </div>
    );
}
