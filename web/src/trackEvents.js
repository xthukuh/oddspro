// Feature-event vocabulary (admin program M3). The ONE place that owns the
// closed set of event names the UI emits via track() - handlers never inline
// a string, so a typo can't silently die in sanitizeEvents' name gate. Every
// value must satisfy src/db/track-rules.js EVENT_NAME_RE (lowercase snake,
// <=48 chars) - asserted offline by tests/track-events.test.js.
export const EV = {
    MAGIC_SORT_TOGGLE: 'magic_sort_toggle', // value: strategy id
    SAFE_ONLY: 'safe_only',                 // value: on|off
    SURE_BETS: 'sure_bets',                 // value: on|off
    ONE_OF_EACH: 'one_of_each',             // value: on|off
    RISK_GATE: 'risk_gate',                 // value: on|off
    FILTERS_APPLY: 'filters_apply',         // value: top-level condition count (0 = cleared)
    BETSLIP_OPEN: 'betslip_open',
    BETSLIP_BUILD: 'betslip_build',         // value: legs in the built slip(s)
    SETTINGS_OPEN: 'settings_open',
    HELP_OPEN: 'help_open',
    CSV_EXPORT: 'csv_export',               // value: exported row count
    REFRESH_CLICK: 'refresh_click',
    CALENDAR_NAV: 'calendar_nav',           // value: prev|next|date
    TIP_POPOVER: 'tip_popover',             // value: tip market key
};

// Boolean toggle -> 'on'/'off' so all toggle events share one value shape.
export const onOff = v => (v ? 'on' : 'off');
