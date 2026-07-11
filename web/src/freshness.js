// Pure freshness rules (zero imports - offline-tested from tests/, same
// out-of-root import idiom as ordering.js): decide whether a finished
// refresh job's scope covers what the table currently shows.

// job = { mode: 'manual'|'light'|'full', dates: ['YYYY-MM-DD', ...] } (the
// /api/refresh `last_success` entry). loadedDate = the table's date, or
// null/'' for the all-dates view (always reload - any run touches it).
export function shouldReloadForJob(job, loadedDate) {
    if (!job || typeof job !== 'object') return false;
    if (!loadedDate) return true;
    if (job.mode === 'full') return true;
    return Array.isArray(job.dates) && job.dates.includes(loadedDate);
}

// Decide whether the loaded date's data is stale enough to nudge a refresh
// (F2). Only today/future dates can go stale - past fixtures are settled and
// frozen, so their data never ages. `freshestAt` is the newest odds
// `updated_at` across the loaded rows (ms epoch or ISO string), or null when
// nothing is loaded yet. Returns false for past dates, empty selections, or the
// all-dates view; true only when live-day data exists and is older than
// `maxAgeMinutes`.
export function isDateStale({ freshestAt, isPast, isAllDates = false, now = Date.now(), maxAgeMinutes = 20 } = {}) {
    if (isAllDates || isPast) return false;   // frozen / mixed - no single-date staleness
    if (freshestAt == null) return false;     // nothing loaded - not "stale", just empty
    const ts = typeof freshestAt === 'number' ? freshestAt : new Date(freshestAt).getTime();
    if (!Number.isFinite(ts)) return false;
    return (now - ts) / 60000 > maxAgeMinutes;
}
