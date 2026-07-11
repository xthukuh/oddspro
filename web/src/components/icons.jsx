// iOS line icons for the toolbar; currentColor so they inherit label/accent.
const S = { width: 21, height: 21, viewBox: '0 0 20 20', fill: 'none' };

export const IconRefresh = (p) => (
    <svg {...S} {...p}><path d="M16.5 5.5A7 7 0 1 0 17.4 12" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"/><path d="M16.8 2.5V6H13.3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
// Activity indicator swapped in while refreshing (faint ring + bright arc, spun).
export const IconSpinner = (p) => (
    <svg {...S} {...p}><circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.8"/><path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
);
export const IconMagic = (p) => (
    <svg {...S} {...p}><path d="M10 1.5l1.7 4.6 4.8 1.7-4.8 1.7L10 14l-1.7-4.5L3.5 7.8l4.8-1.7L10 1.5z" fill="currentColor"/><path d="M16 12.5l.7 1.9 1.8.7-1.8.7-.7 1.9-.7-1.9-1.8-.7 1.8-.7.7-1.9z" fill="currentColor"/></svg>
);
export const IconSlips = (p) => (
    <svg {...S} {...p}><rect x="4" y="2" width="12" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6"/><path d="M7 6.5h6M7 10h6M7 13.5h3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
);
export const IconFilter = (p) => (
    <svg {...S} {...p}><path d="M3 5.5h14M5.5 10h9M8 14.5h4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
);
export const IconHelp = (p) => (
    <svg {...S} {...p}><circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.6"/><path d="M7.7 7.5a2.3 2.3 0 1 1 3.1 2.2c-.6.3-.9.7-.9 1.4v.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/><circle cx="10" cy="14.3" r="0.9" fill="currentColor"/></svg>
);
// Classic toothed cog (evenodd punches the centre hole) - reads unambiguously
// as "settings", unlike the previous sun-spoke gear. Uses a 24-box path.
export const IconGear = (p) => (
    <svg {...S} viewBox="0 0 24 24" {...p}>
        <path fillRule="evenodd" clipRule="evenodd" fill="currentColor" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
    </svg>
);
export const IconChevronLeft = (p) => (
    <svg width="10" height="17" viewBox="0 0 10 17" fill="none" {...p}><path d="M8.5 1.5L2 8.5L8.5 15.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
export const IconChevronRight = (p) => (
    <svg width="10" height="17" viewBox="0 0 10 17" fill="none" {...p}><path d="M1.5 1.5L8 8.5L1.5 15.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
export const IconChevronDown = (p) => (
    <svg width="11" height="7" viewBox="0 0 12 8" fill="none" {...p}><path d="M1 1.5L6 6.5L11 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
);
// Hamburger (three EQUAL bars) for the mobile overflow trigger — deliberately
// distinct from IconFilter's three DECREASING bars (they never sit adjacent:
// the filter action collapses INTO this menu below sm).
export const IconMenu = (p) => (
    <svg {...S} {...p}><path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/></svg>
);
// Push-pin toggle for the "pin view" modal control (filled = pinned, so a
// background click won't dismiss). Emoji 📌/📍 in the spec were only examples.
export const IconPin = ({ filled, ...p }) => (
    <svg {...S} viewBox="0 0 24 24" {...p}>
        <path d="M16 9V4l1 0c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1l1 0v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
            fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={filled ? 0 : 1.5} strokeLinejoin="round"/>
    </svg>
);
