// Active sort chain as removable pills, in priority order (column sorts +
// magic strategies together). x removes one entry; "Clear all" empties the
// chain. Reordering lives in the Settings "Sort priority" drag list. Renders
// nothing when no sort is active, so it costs no vertical space by default.
const _key = e => (e.type === 'magic' ? `magic:${e.id}` : `col:${e.key}`);

export default function SortPills({ chain, entryLabel, onRemove, onClear }) {
    if (!chain?.length) return null;
    return (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 py-0.5">
            <span className="text-xs text-label-2 mr-1">Sorted by</span>
            {chain.map((e, i) => (
                <span
                    key={_key(e)}
                    className="inline-flex items-center gap-1 rounded-[10px] border border-separator bg-surface pl-2 pr-1 py-0.5 text-xs"
                >
                    <span className="text-label-3 tabular-nums">{i + 1}</span>
                    <span className="font-semibold">{entryLabel(e)}</span>
                    {e.type === 'column' && <span className="text-accent">{e.dir === 'asc' ? '▲' : '▼'}</span>}
                    <button
                        onClick={() => onRemove(e)}
                        title="Remove this sort"
                        className="cursor-pointer text-label-3 hover:text-miss px-0.5 leading-none"
                    >
                        &times;
                    </button>
                </span>
            ))}
            <button
                onClick={onClear}
                title="Clear all sorts"
                className="cursor-pointer ml-1 text-xs text-label-2 hover:text-miss hover:underline"
            >
                Clear all
            </button>
        </div>
    );
}
