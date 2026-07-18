import { useEffect, useState } from 'react';

// Theme flag for chart colors that must resolve to literal hex/rgba (SVG
// attributes can't hold var()): tracks the app's data-theme override AND the
// OS scheme while mounted, so an admin flipping theme mid-session never gets
// light marks on a dark chart. Shared by DataLab and DashboardSection (M5) -
// extracted verbatim from DataLab so there is exactly one copy.
export default function useDark() {
    const calc = () => {
        const forced = document.documentElement.dataset.theme;
        if (forced) return forced === 'dark';
        return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    };
    const [dark, setDark] = useState(calc);
    useEffect(() => {
        const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
        const update = () => setDark(calc());
        mq?.addEventListener('change', update);
        const mo = new MutationObserver(update);
        mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        return () => { mq?.removeEventListener('change', update); mo.disconnect(); };
    }, []);
    return dark;
}
