import { useState } from 'react';

// Collapsible section with the app's ▸ disclosure idiom (BetslipPlayground
// uses the same inline pattern). The body is only MOUNTED while open -
// HelpModal relies on this so the demo-video iframe never loads until its
// section is expanded.
export default function CollapseSection({ title, defaultOpen = false, children }) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="border-t border-separator first:border-t-0">
            <button
                type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
                className="w-full min-h-[44px] flex items-center gap-2 py-2.5 text-left"
            >
                <span className={`text-label-3 text-xs transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
                <span className="text-sm font-semibold">{title}</span>
            </button>
            {open && <div className="pb-4">{children}</div>}
        </div>
    );
}
