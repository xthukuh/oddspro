import { useEffect, useRef, useState } from 'react';
import { useSession } from '../auth/SessionProvider.jsx';
import useOutsideDismiss from '../useOutsideDismiss.js';
import { Z } from '../zLayers.js';
import { Row } from './OverflowMenu.jsx';
import { IconUser, IconUserPlus, IconLogout, IconPhone, IconShield, IconRefresh, IconSpinner } from './icons.jsx';

// Desktop session control (right of the gear; the mobile overflow menu carries
// the same rows for parity). Guest -> user-silhouette button with Sign in /
// Create account; signed in -> initial-in-a-circle with an account header +
// Edit profile / Sign out. Anchored dropdown in the OverflowMenu idiom:
// absolute panel inside a relative wrapper, useOutsideDismiss (the nav's
// backdrop-filter traps fixed backdrops) + Escape to close. Admin sessions get
// an Admin row opening the Phase 6 AdminPanel (role check is UX only - the
// admin APIs re-verify the session server-side).
export default function AvatarMenu({ btnCls, activeCls }) {
    const session = useSession();
    const [open, setOpen] = useState(false);
    const [sync, setSync] = useState(null); // null | 'busy' | 'ok' | 'error'
    const wrapRef = useRef(null);
    useOutsideDismiss(wrapRef, open, () => setOpen(false));
    useEffect(() => {
        if (!open) return;
        const onKey = e => { if (e.key === 'Escape') setOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open]);

    if (!session) return null;
    const { user, isGuest, openAuth, logout, syncPrefs } = session;
    const initial = (user?.name ?? '').trim().charAt(0).toUpperCase() || '?';
    const go = fn => { setOpen(false); fn(); };

    // Manual prefs sync (Phase 7). The menu stays open to show the outcome
    // (a real pull reloads the page anyway), then closes itself.
    const doSync = async () => {
        if (sync === 'busy') return;
        setSync('busy');
        const r = await syncPrefs();
        setSync(r.action === 'error' ? 'error' : 'ok');
        setTimeout(() => { setSync(null); setOpen(false); }, 1200);
    };
    const syncLabel = sync === 'busy' ? 'Syncing…'
        : sync === 'ok' ? 'Synced'
            : sync === 'error' ? 'Sync failed - try again' : 'Sync settings';

    return (
        <div ref={wrapRef} className="relative">
            <button onClick={() => setOpen(v => !v)}
                aria-label={isGuest ? 'Sign in' : `Account - ${user.name}`}
                title={isGuest ? 'Sign in or create an account' : user.name}
                className={open ? activeCls : btnCls}>
                {isGuest
                    ? <IconUser />
                    : <span className="w-7 h-7 inline-flex items-center justify-center rounded-full bg-accent text-white text-[13px] font-semibold">{initial}</span>}
            </button>
            {open && (
                <div className={`absolute right-0 top-[46px] w-60 bg-surface text-label rounded-2xl shadow-2xl border border-separator-2 py-1 ${Z.popup} [animation:op-pop_0.16s_ease]`}>
                    {isGuest ? (
                        <>
                            <Row icon={<IconUser />} label="Sign in" onClick={() => go(() => openAuth('signin'))} />
                            <Row icon={<IconUserPlus />} label="Create account" onClick={() => go(() => openAuth('signup'))} />
                        </>
                    ) : (
                        <>
                            <div className="px-4 pt-2.5 pb-2">
                                <div className="text-[15px] font-semibold truncate">{user.name}</div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[13px] text-label-2">
                                    <IconPhone width="13" height="13" />
                                    <span className="truncate">{user.phone}</span>
                                </div>
                            </div>
                            <div className="h-px bg-separator-2 my-1" />
                            {user.role === 'admin' && (
                                <Row icon={<IconShield />} label="Admin" onClick={() => go(() => openAuth('admin'))} />
                            )}
                            <Row icon={<IconUser />} label="Edit profile" onClick={() => go(() => openAuth('profile'))} />
                            <Row icon={sync === 'busy' ? <IconSpinner className="[animation:op-spin_0.8s_linear_infinite]" /> : <IconRefresh />}
                                label={syncLabel} onClick={doSync} disabled={sync === 'busy'}
                                active={sync === 'ok'} />
                            <Row icon={<IconLogout />} label="Sign out" onClick={() => go(() => logout())} />
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
