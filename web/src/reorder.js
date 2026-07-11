// Pure reorder helper behind ReorderList's "move to position #" input (kept
// separate from the component so it tests offline). `items` is the ordered list
// ReorderList renders - each entry has a `.key`; `pos` is the 1-based position
// the user typed. Returns a NEW array with the keyed item at that position, or
// the SAME array when the move is a no-op (unknown key or already there) so
// callers can skip a needless state write. `pos` is clamped to [1, length].
export function moveToPosition(items, key, pos) {
    const from = items.findIndex(it => it.key === key);
    if (from < 0) return items;
    const to = Math.max(0, Math.min(items.length - 1, Math.round(pos) - 1));
    if (to === from) return items;
    const next = items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved); // insert at the FINAL 0-based index (post-removal)
    return next;
}
