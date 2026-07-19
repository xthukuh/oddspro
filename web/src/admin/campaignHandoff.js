// Users -> Messaging selection handoff (M9). The admin panel renders its
// sections as siblings with no shared state container, so the multi-select in
// UsersSection parks its picked ids here and MessagingSection claims them on
// mount.
//
// Deliberately module-level (not localStorage/prefs): a handoff is a single
// gesture inside one page session. Surviving a reload would let a forgotten
// selection silently become the audience of a later, unrelated campaign -
// exactly the kind of surprise a broadcast tool must not have.

let pending = null;   // { ids: number[], labels: string[] } | null

export function stageSelection(ids, labels = []) {
    const list = [...new Set(ids)].filter(n => Number.isInteger(n) && n > 0);
    pending = list.length ? { ids: list, labels } : null;
    return pending;
}

// Read AND clear: claiming is one-shot, so revisiting Messaging later does not
// silently re-apply a selection the admin has moved on from.
export function claimSelection() {
    const held = pending;
    pending = null;
    return held;
}

export function hasStagedSelection() {
    return pending != null;
}
