// M14 client maintenance store: the schedule cached from every /api/refresh
// poll (and every maintenance-503 body), plus the per-window banner dismissal.
// One localStorage key - device-local server state, excluded from BOTH the
// prefs sync (src/db/prefs-rules.js DEVICE_EXACT) and .oddspro config
// snapshots (configSnapshot.js isTransient): another device polls its own.
// State math lives in the shared pure module (src/db/maintenance-rules.js) -
// this file only persists.

const LS_KEY = 'oddspro.maintenance';

// { info: {state,start,end,start_ms,end_ms,message,signature}, dismissedSig }
export function loadMaintenance() {
    try {
        const v = JSON.parse(localStorage.getItem(LS_KEY));
        return v && typeof v === 'object' ? v : null;
    } catch {
        return null;
    }
}

export function saveMaintenance(value) {
    try {
        if (value == null) localStorage.removeItem(LS_KEY);
        else localStorage.setItem(LS_KEY, JSON.stringify(value));
    } catch { /* private mode */ }
}
