import { useEffect } from 'react';

// iOS sheet anchored to the top-right toolbar (where the actions live) rather
// than dead-centre: blurred scrim, drop-in card, Escape + backdrop-click dismiss
// (inner clicks are swallowed). Consumers own the header and content. The card
// clears the nav bar and caps its height so its footer never falls off-screen.
export default function Sheet({ onClose, children, className = '', labelledBy }) {
    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div
            onClick={onClose}
            className="fixed inset-0 z-40 flex items-start justify-end p-2 sm:p-3 [animation:op-fade_0.2s_ease] bg-black/15 [backdrop-filter:blur(0.5px)]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
        >
            <div
                onClick={e => e.stopPropagation()}
                className={`mt-11 sm:mt-12 bg-surface text-label rounded-2xl shadow-2xl max-h-[calc(100dvh-4.5rem)] w-full max-w-3xl overflow-hidden [animation:op-pop_0.18s_cubic-bezier(0.32,0.72,0,1)] ${className}`}
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
