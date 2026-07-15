import { lazy, Suspense } from 'react';
import { useSession } from './SessionProvider.jsx';
import SignInView from './SignInView.jsx';
import SignUpView from './SignUpView.jsx';
import VerifyPhoneView from './VerifyPhoneView.jsx';
import ProfileView from './ProfileView.jsx';

// Lazy: the admin panel pulls recharts (~heavy) - keep it out of the guest
// bundle; vite splits the dynamic import into its own chunk fetched on first
// open. Role-gated below (UX only - every admin API re-checks the session).
const AdminPanel = lazy(() => import('../admin/AdminPanel.jsx'));

// SOFT auth gate: the app always renders - guests browse exactly as before,
// and the auth views are opaque overlays on top (so App keeps its state:
// loaded rows, scroll, sort). Two server-mirrored FORCED overlays:
//   - a signed-in but unverified phone -> VerifyPhoneView (verify-gated
//     features 403 with verify_required until then)
//   - must_change_pin (the seeded admin's default PIN, H4) -> forced PIN
//     change (every other API call 403s with pin_change_required)
// Verify comes first: PUT /api/auth/profile itself requires a verified phone.
// Both forced views offer sign-out, so neither is ever a trap. The server
// stays authoritative - this gate is UX, not security.
export default function AuthGate({ children }) {
    const s = useSession();
    const forced = s.user && !s.user.phone_verified ? 'verify'
        : s.user?.must_change_pin ? 'pin'
            : null;
    return (
        <>
            {children}
            {forced === 'verify' && <VerifyPhoneView />}
            {forced === 'pin' && <ProfileView forced />}
            {!forced && s.view === 'signin' && <SignInView />}
            {!forced && s.view === 'signup' && <SignUpView />}
            {!forced && s.view === 'profile' && <ProfileView />}
            {!forced && s.view === 'admin' && s.role === 'admin' && (
                <Suspense fallback={<div className="fixed inset-0 z-[60] bg-app flex items-center justify-center text-label-2 text-sm">Loading admin…</div>}>
                    <AdminPanel />
                </Suspense>
            )}
        </>
    );
}
