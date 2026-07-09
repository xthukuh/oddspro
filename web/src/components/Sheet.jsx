import { useEffect } from 'react';

// Centered iOS sheet: blurred scrim, spring-in card, Escape + backdrop-click
// dismiss (inner clicks are swallowed). Matches the current modals' dismiss
// rules (× / Escape / backdrop). Consumers own the header and content.
export default function Sheet({ onClose, children, className = '', labelledBy }) {
    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-40 flex items-center justify-center p-4 sm:p-8 [animation:op-fade_0.2s_ease] bg-black/28 [backdrop-filter:blur(2px)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
        >
            <div
                onClick={e => e.stopPropagation()}
                className={`bg-surface text-label rounded-2xl shadow-2xl max-h-[92vh] w-full max-w-3xl overflow-hidden [animation:op-sheet-in_0.24s_cubic-bezier(0.32,0.72,0,1)] ${className}`}
            >
                {children}
            </div>
        </div>
    );
}

// Reusable round × close button for sheet headers.
export function SheetClose({ onClose }) {
    return (
        <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full bg-fill text-label-2 text-lg leading-none hover:bg-fill-hover"
        >
            &times;
        </button>
    );
}
