import { useEffect } from 'react';
import { Z } from '../zLayers.js';
import { IconPin } from './icons.jsx';

// iOS sheet anchored to the top-right toolbar (where the actions live) rather
// than dead-centre: blurred scrim, drop-in card, Escape + backdrop-click dismiss
// (inner clicks are swallowed). Consumers own the header and content. The card
// clears the nav bar and caps its height so its footer never falls off-screen.
//
// `dismissable` (default true): when false the backdrop click no longer closes
// the sheet - this backs the standardized "pin view" toggle (see PinToggle).
// Escape and the × always close regardless, so a pinned sheet is never a trap.
export default function Sheet({ onClose, children, className = '', labelledBy, dismissable = true }) {
    useEffect(() => {
        const onKey = e => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    return (
        <div
            onClick={dismissable ? onClose : undefined}
            className={`fixed inset-0 ${Z.modalScrim} flex items-start justify-end p-2 sm:p-3 [animation:op-fade_0.2s_ease] bg-black/15 [backdrop-filter:blur(0.5px)]`}
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

// "Pin view" toggle for sheet headers - filled pin = pinned (background clicks
// won't dismiss). Drop it in the header just before SheetClose and wire it to a
// `pinned` state whose value is passed to Sheet as `dismissable={!pinned}`.
export function PinToggle({ pinned, onToggle }) {
    return (
        <button
            onClick={onToggle}
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin view' : 'Pin view'}
            title={pinned ? 'Pinned - clicks outside won’t close this' : 'Pin - keep open when clicking outside'}
            className={`cursor-pointer shrink-0 w-8 h-8 inline-flex items-center justify-center rounded-full hover:bg-fill ${pinned ? 'bg-accent-soft text-accent' : 'bg-fill text-label-2'}`}
        >
            <IconPin filled={pinned} width="15" height="15" />
        </button>
    );
}
