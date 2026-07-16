import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { signup, login, verifyOtp, resendOtp, changePhone, logout as apiLogout, fetchMe, updateProfile } from '../api.js';
import { getSessionToken, setSessionToken, clearSessionToken } from './sessionToken.js';
import { syncOnLogin, pushPrefs, syncNow, clearCursor, startAutoSync } from './prefsSync.js';

// Session context for the whole SPA (main.jsx wraps <App/> in this). Holds the
// signed-in user + token, hydrates a stored token via GET /api/auth/me on
// mount, and exposes the auth actions the views/menus call. Also owns which
// auth view is open (`view`: null | 'signin' | 'signup' | 'profile') - the
// codebase is router-free, so AuthGate renders these as conditional
// full-screen views by wrapping the app.
//
// Guests are first-class: no token -> user:null, isGuest:true, and the app
// renders exactly as before. The server stays authoritative for everything
// (requireVerified / must_change_pin guards) - this context only mirrors it.
const SessionContext = createContext(null);

// eslint-disable-next-line react-refresh/only-export-components
export function useSession() {
    return useContext(SessionContext);
}

export default function SessionProvider({ children }) {
    const [token, setToken] = useState(() => getSessionToken());
    const [user, setUser] = useState(null);
    // 'loading' only while hydrating a STORED token; guests are 'ready' at once.
    const [status, setStatus] = useState(() => (getSessionToken() ? 'loading' : 'ready'));
    const [view, setView] = useState(null);
    // Last OTP-send response ({ sent, retry_after_seconds?, error? }) from
    // signup/change-phone/resend - the verify view seeds its resend-cooldown
    // countdown and its "code sent" / "send failed" notice from it.
    const [otpHint, setOtpHint] = useState(null);
    const hydratedRef = useRef(false); // StrictMode mounts effects twice - hydrate once

    useEffect(() => {
        if (hydratedRef.current) return;
        hydratedRef.current = true;
        if (!getSessionToken()) return;
        (async () => {
            try {
                const { user: u } = await fetchMe();
                setUser(u);
                // Prefs sync (Phase 7): a restored session IS a login from this
                // device's viewpoint - pull the server copy if it moved (fire
                // and forget; sync is best-effort and never blocks hydration).
                syncOnLogin(u.id);
            } catch (e) {
                // Only a session rejection clears the token (revoked/expired).
                // Other failures (network, human gate, 5xx) keep it - the user
                // browses as a guest this load and hydration retries next load.
                if (e?.status === 401 && e?.body?.auth_required) {
                    clearSessionToken();
                    setToken(null);
                }
            } finally {
                setStatus('ready');
            }
        })();
    }, []);

    // Store + adopt a fresh session (signup/login responses). The token goes to
    // localStorage FIRST so _authHeaders picks it up for the very next call.
    function adopt({ token: t, user: u }) {
        setSessionToken(t);
        setToken(t);
        setUser(u);
    }

    // Interval auto-sync while signed in (prefsSync no-ops without a network
    // call while the local fingerprint is clean). Stops on logout/user switch.
    useEffect(() => {
        if (!user?.id) return;
        return startAutoSync(user.id);
    }, [user?.id]);

    const value = useMemo(() => ({
        user,
        token,
        status,
        isGuest: !user,
        role: user?.role ?? null,
        view,
        otpHint,
        openAuth: v => setView(v),
        closeAuth: () => setView(null),

        // data: { name, phone, phone_region, phone_code, pin, pin_confirm }
        // -> { user, otp } (otp.sent:false = account created, SMS failed; the
        // verify screen offers resend - never treat it as a failed signup)
        signUp: async data => {
            const res = await signup(data);
            setOtpHint(res.otp ?? null);
            adopt(res);
            setView(null); // AuthGate now forces the verify view (unverified)
            return res;
        },
        // -> user (phone_verified may be false; AuthGate forces verify then)
        signIn: async data => {
            const res = await login(data);
            adopt(res);
            setView(null);
            // Pull this account's synced prefs (or seed them on first login).
            // Fire and forget: a real pull swaps localStorage and reloads.
            syncOnLogin(res.user.id);
            return res.user;
        },
        verifyOtp: async code => {
            const { user: u } = await verifyOtp(code);
            setUser(u);
            // The signup path reaches here without a login pull - first verify
            // seeds the server row from local state (no-op when already synced).
            syncOnLogin(u.id);
            return u;
        },
        resendOtp: async () => {
            const res = await resendOtp();
            setOtpHint(res);
            return res;
        },
        changePhone: async data => {
            const res = await changePhone(data);
            setOtpHint(res.otp ?? null);
            setUser(res.user);
            return res;
        },
        updateProfile: async data => {
            const { user: u } = await updateProfile(data);
            setUser(u);
            return u;
        },
        // Local sign-out always succeeds: revoke server-side best-effort (the
        // token may already be revoked/expired - that must not trap the user).
        logout: async ({ all = false } = {}) => {
            // Final prefs push while the session token still works (prefsSync
            // never throws; a lost race silently adopts the winner).
            if (user?.id) await pushPrefs(user.id);
            try { await apiLogout(all); } catch { /* already signed out server-side */ }
            clearSessionToken();
            clearCursor(); // the next account on this device must not inherit the clock
            setToken(null);
            setUser(null);
            setView(null);
            setOtpHint(null);
        },
        // Manual "Sync now" (avatar/overflow menus): push if dirty, else pull
        // if the server moved. -> { action: 'push'|'pull'|'none'|'error' }
        syncPrefs: async () => (user?.id ? syncNow(user.id) : { action: 'none' }),
        // Re-hydrate from the server (e.g. after an out-of-band change).
        refresh: async () => {
            try {
                const { user: u } = await fetchMe();
                setUser(u);
                return u;
            } catch (e) {
                if (e?.status === 401 && e?.body?.auth_required) {
                    clearSessionToken();
                    setToken(null);
                    setUser(null);
                }
                return null;
            }
        },
    }), [user, token, status, view, otpHint]);

    return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}
