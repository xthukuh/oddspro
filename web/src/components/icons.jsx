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
export const IconGear = (p) => (
    <svg {...S} {...p}><circle cx="10" cy="10" r="2.6" stroke="currentColor" strokeWidth="1.6"/><path d="M10 1.8v2.1M10 16.1v2.1M18.2 10h-2.1M3.9 10H1.8M15.8 4.2l-1.5 1.5M5.7 14.3l-1.5 1.5M15.8 15.8l-1.5-1.5M5.7 5.7L4.2 4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>
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
