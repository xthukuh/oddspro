import Tooltip from './Tooltip.jsx';
import { noticesForDate, coverageStatus, noticeLabel } from '../../../src/db/notice-rules.js';

// One-line data-quality strip, between the table and the status bar. Shown
// whenever the loaded day is inside a notice span, and NOT dismissible: it
// explains why rows are missing, so hiding it would hide the explanation at
// exactly the moment it is needed.
//
// Copy discipline (spec section 3.8): the strip carries a short sentence and
// nothing else. No counts, no percentages, no timestamps. Numbers live in the
// API `evidence` block for machines and in the admin card for the owner.
export default function CoverageRibbon({ notices, date }) {
    const hits = noticesForDate(notices, date);
    if (!hits.length) return null;
    const status = coverageStatus(hits);
    const tone = status === 'outage'
        ? 'border-hot/50 bg-hot/10 text-hot'
        : 'border-warn/50 bg-warn/10 text-warn';
    return (
        <div className={`shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1 border-t text-[11px] ${tone}`} role="status">
            {hits.map(n => (
                <Tooltip key={n.id ?? `${n.kind}${n.date_from}`}
                    content={`${n.note}${n.status === 'unconfirmed' ? '\nNot yet reviewed.' : ''}`}>
                    <span className="whitespace-nowrap">⚠ {noticeLabel(n)} this day.</span>
                </Tooltip>
            ))}
        </div>
    );
}
