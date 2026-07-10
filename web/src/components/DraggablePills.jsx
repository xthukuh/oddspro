import { useRef, useState } from 'react';

// Reusable draggable pill strip - the ONE reorder control shared by both the
// "Column order" and "Sort priority" settings. Pointer-based (not HTML5 DnD, which
// is dead on touch), so it reorders with mouse, touch and pen alike: press a pill
// and drag it over its neighbours; the list reorders live. `onReorder` receives the
// new item array.
//   items    : array of items (columns or sort-chain entries)
//   idOf     : item -> stable string id
//   onReorder: (nextItems) => void
//   children : (item, dragging) => pill inner content (owns its own styling)
// A control inside a pill (e.g. a remove ×) should stopPropagation on pointerdown
// so pressing it never starts a drag.
export default function DraggablePills({ items, idOf, onReorder, children, className = '' }) {
    const [dragId, setDragId] = useState(null);
    const refs = useRef(new Map());          // id -> element
    const orderRef = useRef(items);
    orderRef.current = items;

    // Which pill sits under the pointer (rect hit-test; pointer capture keeps
    // events flowing to us even when the finger leaves the pressed pill).
    const pillAt = (x, y) => {
        for (const [id, el] of refs.current) {
            if (!el) continue;
            const r = el.getBoundingClientRect();
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return id;
        }
        return null;
    };

    const onMove = e => {
        if (dragId == null) return;
        const overId = pillAt(e.clientX, e.clientY);
        if (!overId || overId === dragId) return;
        const cur = orderRef.current;
        const from = cur.findIndex(it => idOf(it) === dragId);
        const to = cur.findIndex(it => idOf(it) === overId);
        if (from < 0 || to < 0 || from === to) return;
        const next = cur.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        onReorder(next);
    };

    const end = () => setDragId(null);

    return (
        <div
            className={`flex flex-wrap gap-1.5 ${className}`}
            onPointerMove={onMove}
            onPointerUp={end}
            onPointerCancel={end}
        >
            {items.map(it => {
                const id = idOf(it);
                return (
                    <div
                        key={id}
                        ref={el => { if (el) refs.current.set(id, el); else refs.current.delete(id); }}
                        onPointerDown={e => { e.currentTarget.setPointerCapture?.(e.pointerId); setDragId(id); }}
                        style={{ touchAction: 'none' }}
                        className={`cursor-grab select-none ${dragId === id ? 'opacity-50' : ''}`}
                    >
                        {children(it, dragId === id)}
                    </div>
                );
            })}
        </div>
    );
}
