// Page controls + per-page selector + record count summary.

export default function Pagination({ page, pages, total, perPage, onPage, onPerPage }) {
    const from = total ? (page - 1) * perPage + 1 : 0;
    const to = Math.min(page * perPage, total);
    // compact page window around the current page
    const window_ = [...new Set([1, page - 1, page, page + 1, pages])]
        .filter(p => p >= 1 && p <= pages)
        .sort((a, b) => a - b);

    return (
        <div className="flex flex-wrap items-center gap-3 py-3 text-sm text-slate-600">
            <span>{from}&ndash;{to} of {total}</span>
            <div className="grow" />
            <label className="flex items-center gap-2">
                <span>Per page</span>
                <select
                    value={perPage}
                    onChange={e => onPerPage(Number(e.target.value))}
                    className="border border-slate-300 rounded px-2 py-1 bg-white"
                >
                    {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n}</option>)}
                </select>
            </label>
            <div className="flex items-center gap-1">
                <button
                    disabled={page <= 1}
                    onClick={() => onPage(page - 1)}
                    className="px-2 py-1 rounded border border-slate-300 bg-white disabled:opacity-40"
                >
                    &lsaquo;
                </button>
                {window_.map((p, i) => (
                    <span key={p} className="flex items-center gap-1">
                        {i > 0 && window_[i - 1] < p - 1 && <span className="text-slate-400">&hellip;</span>}
                        <button
                            onClick={() => onPage(p)}
                            className={`px-2.5 py-1 rounded border ${p === page
                                ? 'bg-sky-600 border-sky-600 text-white'
                                : 'border-slate-300 bg-white hover:bg-slate-50'}`}
                        >
                            {p}
                        </button>
                    </span>
                ))}
                <button
                    disabled={page >= pages}
                    onClick={() => onPage(page + 1)}
                    className="px-2 py-1 rounded border border-slate-300 bg-white disabled:opacity-40"
                >
                    &rsaquo;
                </button>
            </div>
        </div>
    );
}
