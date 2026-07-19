import { formatMaintenanceDt } from '../../src/db/maintenance-rules.js';

// M14 full-screen maintenance screen. Rendered by App WITHOUT unmounting the
// app (table state survives the window), above every sheet/modal. While it is
// up the app's polls, records fetches and tracking are suspended (App.jsx) -
// the network goes quiet and App's own-clock timer brings everything back a
// few jittered seconds after the window ends.
export default function MaintenanceOverlay({ info }) {
    return (
        <div className="fixed inset-0 z-[100] bg-app text-label flex items-center justify-center p-6"
            role="alert" aria-live="assertive">
            <div className="max-w-md text-center flex flex-col items-center gap-3">
                {/* Simple line-art wrench-in-circle, theme-tinted via currentColor */}
                <svg viewBox="0 0 24 24" className="w-12 h-12 text-accent" fill="none"
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" opacity="0.35" />
                    <path d="M14.7 6.3a3.5 3.5 0 0 0-4.4 4.4L7 14l-1 3 3-1 3.3-3.3a3.5 3.5 0 0 0 4.4-4.4l-2.2 2.2-1.8-.4-.4-1.8 2.4-2z" />
                </svg>
                <h1 className="text-lg font-semibold">Scheduled maintenance</h1>
                <p className="text-sm text-label-2">{info.message}</p>
                <p className="text-sm font-medium text-accent">
                    Expected back by {formatMaintenanceDt(info.end)} <span className="text-label-3 font-normal">(EAT)</span>
                </p>
                <p className="text-xs text-label-3">
                    Your view is paused, not lost - the app resumes here automatically when maintenance ends.
                </p>
            </div>
        </div>
    );
}
