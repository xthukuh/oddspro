import { OP_MARK } from '../components/Logo.jsx';
import { Z } from '../zLayers.js';

// Full-screen scaffold for the auth views (sign in / sign up / verify /
// profile) - the codebase is router-free, so these render as opaque overlays
// ON TOP of the app (children stay mounted underneath, preserving table state)
// A brand mark, centered card, token
// palette. Shared control classes live here so the four views can't drift.
export default function AuthShell({ title, subtitle, children, footer }) {
    return (
        <div className={`fixed inset-0 ${Z.modalScrim} bg-app overflow-y-auto [animation:op-fade_0.2s_ease]`}>
            <div className="min-h-full flex items-start sm:items-center justify-center px-6 py-10">
                <div className="w-full max-w-sm">
                    <div className="mb-5 text-center">{OP_MARK}</div>
                    <div className="bg-surface rounded-2xl shadow-sm border border-separator-2 px-5 py-6">
                        <h1 className="text-label text-lg font-semibold text-center">{title}</h1>
                        {subtitle && <p className="text-label-2 text-[13px] leading-snug mt-1.5 text-center">{subtitle}</p>}
                        <div className="mt-5 flex flex-col gap-3.5">{children}</div>
                    </div>
                    {footer && <div className="mt-5 text-center text-sm text-label-2">{footer}</div>}
                </div>
            </div>
        </div>
    );
}

// ≥44px touch targets (the repo's touch rule) on all auth controls.
export const inputCls = 'w-full bg-surface border border-separator text-label rounded-[10px] h-11 px-3 text-[15px] outline-none focus:border-accent';
export const btnCls = 'w-full cursor-pointer rounded-[10px] bg-accent h-11 text-white text-[15px] font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-default';
export const linkCls = 'cursor-pointer text-accent hover:underline';

// Inline error / notice lines under a form (role=alert mirrors App's banner).
export function FormError({ children }) {
    if (!children) return null;
    return <p className="text-miss text-[13px] leading-snug" role="alert">{children}</p>;
}

export function FormNotice({ children }) {
    if (!children) return null;
    return <p className="text-accent text-[13px] leading-snug" role="status">{children}</p>;
}
