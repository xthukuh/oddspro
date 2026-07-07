// Active sort chain as removable pills, in priority order (column sorts +
// magic strategies together). x removes one entry; "Clear all" empties the
// chain. Reordering lives in the Settings "Sort priority" drag list. Renders
// nothing when no sort is active, so it costs no vertical space by default.
const _key = e => (e.type === 'magic' ? `magic:${e.id}` : `col:${e.key}`);

export default function SortPills({ chain, entryLabel, onRemove, onClear }) {
    if (!chain?.length) return null;
    return (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200 bg-white px-2 py-2 md:px-4">
            <span className="text-xs text-slate-400 mr-1">Sorted by</span>
            {chain.map((e, i) => (
                <span
                    key={_key(e)}
                    className="inline-flex items-center gap-1 rounded border border-slate-300 bg-slate-50 pl-2 pr-1 py-0.5 text-xs"
                >
                    <span className="text-slate-400 tabular-nums">{i + 1}</span>
                    <span className="font-medium">{entryLabel(e)}</span>
                    {e.type === 'column' && <span className="text-sky-600">{e.dir === 'asc' ? '▲' : '▼'}</span>}
                    <button
                        onClick={() => onRemove(e)}
                        title="Remove this sort"
                        className="cursor-pointer text-slate-400 hover:text-red-600 px-0.5 leading-none"
                    >
                        &times;
                    </button>
                </span>
            ))}
            <button
                onClick={onClear}
                title="Clear all sorts"
                className="cursor-pointer ml-1 text-xs text-slate-500 hover:text-red-600 hover:underline"
            >
                Clear all
            </button>
        </div>
    );
}
