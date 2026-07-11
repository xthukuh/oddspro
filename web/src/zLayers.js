// Single source of truth for stacking order across the app. Higher = closer to
// the viewer. Follows the layering the UI needs (base → chrome → popups →
// modals → in-modal controls → tooltips). Values are literal Tailwind class
// strings so the JIT scanner picks them up from this file; import and spread
// them into className so every surface uses ONE agreed scale (no ad-hoc z-[..]).
//
//   0   base content / the data table
//   10  sticky body pinned cells      (DataTable)
//   20  sticky header row             (DataTable)
//   30  sticky corner (both axes)     (DataTable)
//   40  app chrome — nav bar + footer status bar
//   50  content & toolbar popups      (OverflowMenu, CalendarPopover, TipPopover, table tooltips' tap catcher)
//   55    their panels
//   60  modal scrim / backdrop        (Sheet, Betslip)
//   70  modal card
//   80  in-modal anchored dropdowns   (MultiSelect, ReorderList panels — must clear the card)
//   90  tooltips (always on top; pass-through)
export const Z = {
    stickyBody: 'z-10',
    stickyHeader: 'z-20',
    stickyCorner: 'z-30',
    chrome: 'z-40',
    popupCatcher: 'z-[50]',
    popup: 'z-[55]',
    modalScrim: 'z-[60]',
    modalCard: 'z-[70]',
    dropdown: 'z-[80]',
    tooltip: 'z-[90]',
    tooltipCatcher: 'z-[85]',
};
