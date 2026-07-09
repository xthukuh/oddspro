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
