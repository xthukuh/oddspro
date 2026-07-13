// Active view-modifier pills: a visible, removable summary of every setting that
// hides or reduces the table rows - the "hide" toggles, Safe-only, One-of-each,
// Upcoming-only, and active advanced filters. It WARNS the user that what they
// see is a subset (the "all tips are hits" surprise was really Hide-miss silently
// on). Renders nothing when the view is unmodified, so it costs no space then.
export default function ViewPills({
    showCompleted, hideHits, hideMiss, noMiss, safeOnly, oneEach, filterCount,
    hideSelected, hideUnselected,
    onShowCompleted, onHideHits, onHideMiss, onNoMiss, onSafeOnly, onOneEach,
    onHideSelected, onHideUnselected,
    onOpenFilters, onClearFilters,
}) {
    const items = [];
    if (!showCompleted) items.push(['completed', 'Upcoming only', 'Completed games are hidden', () => onShowCompleted(true)]);
    if (hideHits) items.push(['hideHits', 'Hide hits', 'Winning tips are hidden', () => onHideHits(false)]);
    if (hideMiss) items.push(['hideMiss', 'Hide miss', 'Losing tips are hidden', () => onHideMiss(false)]);
    if (noMiss) items.push(['noMiss', 'No miss', 'Any market that lost today is hidden', () => onNoMiss(false)]);
    if (safeOnly) items.push(['safeOnly', '🛡 Safe only', 'Only the day’s safe picks are shown', () => onSafeOnly(false)]);
    if (oneEach) items.push(['oneEach', 'One of each', 'One row per game (top provider only)', () => onOneEach(false)]);
    if (hideSelected) items.push(['hideSelected', 'Hide selected', 'Checked rows are hidden', () => onHideSelected(false)]);
    if (hideUnselected) items.push(['hideUnselected', 'Hide unselected', 'Only checked rows are shown', () => onHideUnselected(false)]);
    if (!items.length && !filterCount) return null;
    const pill = 'inline-flex items-center gap-1 rounded-[10px] border border-hot/50 bg-hot/10 text-hot pl-2 pr-1 py-0.5 text-xs';
    return (
        <div className="flex flex-wrap items-center gap-1.5 shrink-0 py-0.5">
            <span className="text-xs text-hot mr-0.5" title="These options hide or reduce rows - what you see is a subset of the day">
                ⚠ Showing a subset:
            </span>
            {items.map(([key, label, hint, clear]) => (
                <span key={key} className={pill} title={hint}>
                    <span className="font-semibold">{label}</span>
                    <button onClick={clear} title={`Turn off ${label}`} className="cursor-pointer hover:text-miss px-0.5 leading-none">&times;</button>
                </span>
            ))}
            {filterCount > 0 && (
                <span className={pill} title="Advanced filters are narrowing the rows">
                    <button onClick={onOpenFilters} title="Edit filters" className="cursor-pointer font-semibold hover:underline">
                        {filterCount} filter{filterCount > 1 ? 's' : ''}
                    </button>
                    <button onClick={onClearFilters} title="Clear all filters" className="cursor-pointer hover:text-miss px-0.5 leading-none">&times;</button>
                </span>
            )}
        </div>
    );
}
