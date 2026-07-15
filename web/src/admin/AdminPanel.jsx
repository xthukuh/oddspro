import { useEffect, useState } from 'react';
import { useSession } from '../auth/SessionProvider.jsx';
import { OP_MARK } from '../HumanGate.jsx';
import { Z } from '../zLayers.js';
import SettingsEditor from './SettingsEditor.jsx';
import DataLab from './DataLab.jsx';

// Admin panel (v1.1.0 Phase 6): a full-screen overlay in the AuthShell idiom
// (App stays mounted underneath - table state/scroll survive), opened from
// AvatarMenu -> Admin for role==='admin' sessions and lazy-loaded from
// AuthGate so recharts never rides the guest bundle. Two tabs: the dynamic
// settings editor (P4 endpoints) and the data-viz lab. The server stays
// authoritative - every API this drives re-checks the admin session.
export default function AdminPanel() {
    const { user, closeAuth } = useSession();
    const [tab, setTab] = useState('settings');

    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') closeAuth(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [closeAuth]);

    const tabCls = active => `cursor-pointer h-9 px-4 rounded-full text-[13px] font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'bg-fill text-label-2 hover:bg-fill-hover'}`;

    return (
        <div className={`fixed inset-0 ${Z.modalScrim} bg-app overflow-y-auto [animation:op-fade_0.2s_ease]`}>
            <div className="max-w-5xl mx-auto px-4 sm:px-6 py-5">
                <div className="flex items-center gap-3">
                    <span className="shrink-0">{OP_MARK}</span>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-label text-lg font-semibold leading-tight">Admin</h1>
                        <p className="text-label-2 text-[12px] truncate">{user?.name} · server settings & data lab</p>
                    </div>
                    <button onClick={closeAuth} aria-label="Close admin panel" title="Close"
                        className="cursor-pointer w-11 h-11 shrink-0 rounded-full bg-fill hover:bg-fill-hover text-label text-lg leading-none">×</button>
                </div>
                <div className="mt-4 flex items-center gap-2">
                    <button className={tabCls(tab === 'settings')} onClick={() => setTab('settings')}>Settings</button>
                    <button className={tabCls(tab === 'lab')} onClick={() => setTab('lab')}>Data lab</button>
                </div>
                <div className="mt-4 pb-10">
                    {tab === 'settings' ? <SettingsEditor /> : <DataLab />}
                </div>
            </div>
        </div>
    );
}
