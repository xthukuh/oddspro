import { useEffect } from 'react';

// Close an anchored popup when the user taps/clicks anywhere outside `ref` (the
// wrapper holding BOTH the trigger and the panel). Uses a document-level
// `pointerdown` listener rather than a backdrop <div>, for two reasons:
//   1. The toolbar popups live inside the nav <header>, which has a
//      `backdrop-filter`. A filter/backdrop-filter ancestor becomes the
//      containing block for `position: fixed` descendants, so a `fixed inset-0`
//      backdrop only covers the header strip - a tap on the footer/table never
//      reaches it, and the popup wouldn't dismiss. A document listener has no
//      such stacking/containing-block dependency.
//   2. pointerdown fires reliably on touch (iOS Safari won't synthesize a
//      click on a bare non-interactive <div>).
// Escape stays in the components. Matches useAnchoredPanel's dismiss idiom.
export default function useOutsideDismiss(ref, open, onClose) {
    useEffect(() => {
        if (!open) return;
        const onDown = e => { if (!ref.current?.contains(e.target)) onClose(); };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
        // onClose/ref are captured fresh via closure (same pattern as
        // useAnchoredPanel); only `open` needs to re-run the effect.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
}
