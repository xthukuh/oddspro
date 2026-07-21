import { lazy, Suspense } from 'react';
import { useSession } from './SessionProvider.jsx';

// Lazy: the admin panel pulls recharts (~heavy) - keep it out of the guest
// bundle; vite splits the dynamic import into its own chunk fetched on first
// open. Role-gated below (UX only - every admin API re-checks the session).
const AdminPanel = lazy(() => import('../admin/AdminPanel.jsx'));

// Lazy for the same reason: all five auth views are overlays nothing renders
// until the user asks for them, and four of them pull PhoneField ->
// react-phone-number-input + libphonenumber-js (~339 KB pre-min, ~17-20% of
// the guest entry chunk) that 100% of guests parsed and almost none used.
// Vite groups them into a shared chunk fetched on the first overlay open.
const SignInView = lazy(() => import('./SignInView.jsx'));
const SignUpView = lazy(() => import('./SignUpView.jsx'));
const VerifyPhoneView = lazy(() => import('./VerifyPhoneView.jsx'));
const ProfileView = lazy(() => import('./ProfileView.jsx'));
const ForgotPinView = lazy(() => import('./ForgotPinView.jsx'));

// One overlay renders at a time, so a single boundary covers them all. The
// fallback mirrors the admin one (full-bleed app surface) - the forced views
// are the only ones that appear unprompted, and a blank overlay would read as
// a broken screen rather than a loading one.
const overlayFallback = (
    <div className="fixed inset-0 z-[60] bg-app flex items-center justify-center text-label-2 text-sm">Loading…</div>
);

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
            <Suspense fallback={overlayFallback}>
                {forced === 'verify' && <VerifyPhoneView />}
                {forced === 'pin' && <ProfileView forced />}
                {!forced && s.view === 'signin' && <SignInView />}
                {!forced && s.view === 'signup' && <SignUpView />}
                {!forced && s.view === 'forgot' && <ForgotPinView />}
                {!forced && s.view === 'profile' && <ProfileView />}
                {!forced && s.view === 'admin' && s.role === 'admin' && <AdminPanel />}
                {/* A guest on an #admin deep link (M5) signs in first; SessionProvider
                    keeps view='admin' when the signed-in account is an admin. */}
                {!forced && s.view === 'admin' && s.isGuest && s.status === 'ready' && <SignInView />}
            </Suspense>
        </>
    );
}
