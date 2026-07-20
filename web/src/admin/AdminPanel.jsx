import { useEffect } from 'react';
import { useSession } from '../auth/SessionProvider.jsx';
import { OP_MARK } from '../components/Logo.jsx';
import { Z } from '../zLayers.js';
import { useAdminRoute, ADMIN_SECTIONS } from './useAdminRoute.js';
import SettingsEditor from './SettingsEditor.jsx';
import DataLab from './DataLab.jsx';
import DashboardSection from './DashboardSection.jsx';
import UsersSection from './UsersSection.jsx';
import MessagingSection from './MessagingSection.jsx';
import DatabaseSection from './DatabaseSection.jsx';

// Admin panel (M5 shell): a full-page overlay in the AuthShell idiom (App
// stays mounted underneath - table state/scroll survive), opened from
// AvatarMenu/OverflowMenu -> Admin or an `#admin/<section>` deep link, and
// lazy-loaded from AuthGate so recharts never rides the guest bundle.
// Section nav: sidebar rail on md+, horizontal pill row below. Existing
// editors (Settings, Data lab) mount unchanged; sections still in flight
// render a placeholder naming their milestone. The server stays
// authoritative - every API this drives re-checks the admin session.

function Pending({ label, milestone }) {
    return (
        <div className="border border-dashed border-separator rounded-xl p-10 text-center">
            <div className="text-label font-medium text-sm">{label}</div>
            <div className="text-label-2 text-[12px] mt-1">Coming in {milestone} of the admin program.</div>
        </div>
    );
}

function AboutSection() {
    return (
        <div className="max-w-lg text-[13px] text-label-2 leading-relaxed">
            <h2 className="text-label text-base font-semibold">Oddspro admin</h2>
            <p className="mt-2">Football odds &amp; stats warehouse - admin area. Every panel here talks to
                session-guarded <code className="text-label">/api/admin/*</code> endpoints; nothing is client-authoritative.</p>
            <ul className="mt-3 space-y-1">
                <li><a className="text-accent" href="/privacy/index.html" target="_blank" rel="noopener">Privacy Policy</a></li>
                <li><a className="text-accent" href="/terms/index.html" target="_blank" rel="noopener">Terms of Use</a></li>
            </ul>
            <p className="mt-3 text-label-3 text-[12px]">Deep-linkable: <code>#admin/&lt;section&gt;</code>.</p>
        </div>
    );
}

const SECTION_BODY = {
    dashboard: <DashboardSection />,
    settings: <SettingsEditor />,
    lab: <DataLab />,
    users: <UsersSection />,
    messaging: <MessagingSection />,
    performance: <Pending label="Engine performance visualizations" milestone="M11" />,
    database: <DatabaseSection />,
    about: <AboutSection />,
};

export default function AdminPanel() {
    const { user, closeAuth } = useSession();
    const [section, navigate] = useAdminRoute(closeAuth);

    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') closeAuth(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [closeAuth]);

    const itemCls = active => `cursor-pointer shrink-0 md:w-full text-left h-9 px-3.5 rounded-lg text-[13px] font-medium transition-colors ${
        active ? 'bg-accent text-white' : 'text-label-2 hover:bg-fill'}`;

    return (
        <div className={`fixed inset-0 ${Z.modalScrim} bg-app overflow-y-auto [animation:op-fade_0.2s_ease]`}>
            <div className="max-w-6xl mx-auto px-4 sm:px-6 py-5">
                <div className="flex items-center gap-3">
                    <span className="shrink-0">{OP_MARK}</span>
                    <div className="flex-1 min-w-0">
                        <h1 className="text-label text-lg font-semibold leading-tight">Admin</h1>
                        <p className="text-label-2 text-[12px] truncate">{user?.name} · {ADMIN_SECTIONS.find(s => s.id === section)?.label}</p>
                    </div>
                    <button onClick={closeAuth} aria-label="Close admin panel" title="Close"
                        className="cursor-pointer w-11 h-11 shrink-0 rounded-full bg-fill hover:bg-fill-hover text-label text-lg leading-none">×</button>
                </div>
                <div className="mt-4 flex flex-col md:flex-row md:items-start gap-4">
                    <nav aria-label="Admin sections"
                        className="flex md:flex-col gap-1 md:w-44 shrink-0 overflow-x-auto md:overflow-visible pb-1 md:pb-0 md:sticky md:top-5">
                        {ADMIN_SECTIONS.map(s => (
                            <button key={s.id} className={itemCls(s.id === section)} onClick={() => navigate(s.id)}>
                                {s.label}
                            </button>
                        ))}
                    </nav>
                    <div className="flex-1 min-w-0 pb-10">
                        {SECTION_BODY[section] ?? null}
                    </div>
                </div>
            </div>
        </div>
    );
}
