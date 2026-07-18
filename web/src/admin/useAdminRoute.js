import { useEffect, useRef, useState } from 'react';

// Admin hash routing (admin program M5): `#admin` or `#admin/<section>` deep
// links into the admin panel. This module is deliberately tiny and chart-free:
// SessionProvider imports parseAdminHash at boot (the only main-bundle touch),
// while the hook itself rides the lazy admin chunk with AdminPanel.
//
// The codebase is router-free by design - the ONLY routed surface is the admin
// area, so this stays a purpose-built hook rather than a router dependency.

export const ADMIN_SECTIONS = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'settings', label: 'Settings' },
    { id: 'users', label: 'Users' },
    { id: 'messaging', label: 'Messaging' },
    { id: 'lab', label: 'Data lab' },
    { id: 'performance', label: 'Performance' },
    { id: 'database', label: 'Database' },
    { id: 'about', label: 'About' },
];
const IDS = new Set(ADMIN_SECTIONS.map(s => s.id));
export const DEFAULT_SECTION = 'dashboard';

// '#admin' -> 'dashboard'; '#admin/users' -> 'users'; an unknown section falls
// back to the default (a stale deep link should not bounce the admin out);
// any non-admin hash -> null.
export function parseAdminHash(hash) {
    const m = /^#admin(?:\/([a-z-]*))?$/.exec(hash || '');
    if (!m) return null;
    return IDS.has(m[1]) ? m[1] : DEFAULT_SECTION;
}

export function adminHash(section) {
    return `#admin/${IDS.has(section) ? section : DEFAULT_SECTION}`;
}

// Owns the `#admin/...` hash while the panel is mounted: claims/normalizes it
// on mount, follows hashchange (back button walks visited sections; a hash
// that stops being admin-shaped exits via onExit), and clears it on unmount so
// closing the panel leaves a clean URL. navigate() goes through location.hash
// so the browser records a history entry per section visit.
export function useAdminRoute(onExit) {
    const exitRef = useRef(onExit);
    exitRef.current = onExit;
    const [section, setSection] = useState(() => parseAdminHash(window.location.hash) ?? DEFAULT_SECTION);

    // Keep the URL in sync with the current section. replaceState (not a hash
    // assignment) so claiming/normalizing never pushes a history entry - and
    // so a StrictMode dev remount re-claims the hash its twin's cleanup wiped.
    useEffect(() => {
        const want = adminHash(section);
        if (window.location.hash !== want) history.replaceState(null, '', want);
    }, [section]);

    useEffect(() => {
        const onHash = () => {
            const s = parseAdminHash(window.location.hash);
            if (s == null) exitRef.current?.();
            else setSection(s);
        };
        window.addEventListener('hashchange', onHash);
        return () => {
            window.removeEventListener('hashchange', onHash);
            if (parseAdminHash(window.location.hash) != null) {
                history.replaceState(null, '', window.location.pathname + window.location.search);
            }
        };
    }, []);

    const navigate = s => { window.location.hash = adminHash(s); };
    return [section, navigate];
}
