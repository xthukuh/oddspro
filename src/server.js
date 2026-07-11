import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { queryRecords, columnCatalog } from './db/records.js';
import { hotpicksSummary, performanceSummary } from './hotpicks.js';
import { magicSortCached } from './magic.js';
import { runDateRefresh } from './pipeline.js';
import { refreshStatus, startJob, requestCancel, lastFreshAt, startAutoRefresh, stopAutoRefresh } from './auto-refresh.js';
import { closeDb } from './db/connection.js';

// Visualization API server (:3001). Serves the paginated/multi-sort/filtered
// records endpoint over the warehouse plus the column catalog for the web
// settings modal, and the built web/dist frontend when present.
// Start with `npm run serve`; the vite dev server proxies /api/* here.

const app = express();
app.disable('x-powered-by');

// Optional bearer-token guard: X-Requested-With (below) only stops a plain
// cross-origin form/navigation - once this server is on a public domain,
// anyone who finds the URL could POST /api/refresh directly (triggers live
// scrapes/API-Football calls). Unset by default - zero effect on today's
// LAN-only (API_HOST=127.0.0.1) deployment.
if (config.API_TOKEN) {
    app.use('/api', (req, res, next) => {
        if (req.get('authorization') === `Bearer ${config.API_TOKEN}`) return next();
        res.status(401).json({ error: 'Unauthorized' });
    });
}

// Parse a JSON-encoded query param (sort/filters), tolerating absence
function _json(value, fallback) {
    if (value == null || value === '') return fallback;
    try {
        return JSON.parse(value);
    } catch {
        throw new TypeError(`Invalid JSON query param: ${value}`);
    }
}

// GET /api/columns - column catalog (base + markets + stats) for settings UI
app.get('/api/columns', async (req, res, next) => {
    try {
        res.json(await columnCatalog());
    } catch (e) {
        next(e);
    }
});

// GET /api/records?date=YYYY-MM-DD&page=&per_page=&sort=[{key,dir}]&filters=[{key,op,value}]
// date defaults to today; pass date=all for every date.
app.get('/api/records', async (req, res, next) => {
    try {
        const { date, page, per_page, sort, filters, completed, providers } = req.query;
        res.json(await queryRecords({
            date: date === 'all' ? null : (date || new Date()),
            page,
            per_page: per_page === 'all' ? 'all' : per_page,
            sort: _json(sort, []),
            filters: _json(filters, []),
            completed: completed !== '0', // ?completed=0 hides concluded games
            providers: providers ? String(providers).split(',').filter(Boolean) : null,
        }));
    } catch (e) {
        next(e);
    }
});

// GET /api/hotpicks - over 2.5 hot-pick accuracy windows + upcoming hot list
app.get('/api/hotpicks', async (req, res, next) => {
    try {
        res.json(await hotpicksSummary());
    } catch (e) {
        next(e);
    }
});

// GET /api/performance - flat-stake ROI / hit-rate / bucket report for tips
// and hot picks (windows, confidence/market/edge buckets, AI-veto impact)
app.get('/api/performance', async (req, res, next) => {
    try {
        res.json(await performanceSummary());
    } catch (e) {
        next(e);
    }
});

// GET /api/magic-sort - top tip-ranking strategies by 4-leg slip survival
// (backtest over settled tips) + the live calibration the web table scores
// today's rows with. Cached per day; ?refresh=1 recomputes.
app.get('/api/magic-sort', async (req, res, next) => {
    try {
        res.json(await magicSortCached(req.query.refresh === '1'));
    } catch (e) {
        next(e);
    }
});

// Single-slot refresh job state lives in src/auto-refresh.js - one shared
// guard for manual AND scheduled runs: parallel refreshes would deadlock on
// InnoDB delete+insert gap locks (same rule as `_batch` DB-writing
// concurrency 1), and a second sweep of the same date is wasted server hits.

// Per-date MANUAL cooldown: date -> ms timestamp of its last finished manual
// run (success or failure - either way it already spent API quota/scrape
// hits). Blocks re-triggering the SAME date for REFRESH_COOLDOWN_MINUTES;
// other dates are unaffected. Auto runs stamp only the success freshness map
// (auto-refresh.js) - a 10-minute light cadence stamping THIS map would keep
// today permanently on manual cooldown.
const refreshCooldown = new Map();

// POST /api/refresh?date=YYYY-MM-DD - start refreshing a date's data
// (fixtures, results, odds, link, stats). 409 with the in-flight job when one
// is already running (manual or scheduled), 200 {fresh:true} when the date
// was successfully refreshed within REFRESH_CACHE_MINUTES (no re-run), 429
// while that date is on manual cooldown (carries retry_after_seconds).
app.post('/api/refresh', (req, res) => {
    // CSRF guard: custom headers force a CORS preflight cross-origin, which
    // this server never approves - only same-origin callers can set this.
    if (!req.get('x-requested-with')) {
        return res.status(403).json({ error: 'Missing X-Requested-With header.' });
    }
    const date = String(req.query.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date).getTime())) {
        return res.status(400).json({ error: `Invalid refresh date (expected YYYY-MM-DD): ${date}` });
    }
    if (refreshStatus().running) return res.status(409).json(refreshStatus());
    // Cache reuse: a recent successful run (auto or manual) already covered
    // this date - answer "fresh" so the client just reloads what it has.
    const cacheMs = config.REFRESH_CACHE_MINUTES * 60_000;
    const freshAt = lastFreshAt(date);
    if (cacheMs > 0 && freshAt && (Date.now() - freshAt) < cacheMs) {
        return res.json({
            ...refreshStatus(),
            fresh: true,
            last_refreshed_at: new Date(freshAt).toISOString(),
        });
    }
    const cooldownMs = config.REFRESH_COOLDOWN_MINUTES * 60_000;
    const lastFinished = refreshCooldown.get(date);
    if (cooldownMs > 0 && lastFinished && (Date.now() - lastFinished) < cooldownMs) {
        const retry_after_seconds = Math.ceil((cooldownMs - (Date.now() - lastFinished)) / 1000);
        return res.status(429).json({
            error: `Refresh cooldown active for ${date} - try again in ${Math.ceil(retry_after_seconds / 60)}m.`,
            retry_after_seconds,
        });
    }
    const started = startJob({
        mode: 'manual',
        dates: [date],
        run: (onStep, shouldCancel) => runDateRefresh(date, onStep, shouldCancel),
        // A cancelled run doesn't spend the cooldown, so "Resume" (re-POST) works
        // immediately; a completed/failed run already spent quota, so it does.
        onFinish: job => { if (!job.cancelled) refreshCooldown.set(date, Date.now()); },
    });
    // Race with a scheduler tick claiming the slot between the check above
    // and here - same answer as the up-front running check.
    if (!started) return res.status(409).json(refreshStatus());
    res.status(202).json(refreshStatus());
});

// POST /api/refresh/cancel - cooperatively cancel the in-flight refresh job
// (F3). Same CSRF guard as the trigger. 202 with the job state when a cancel
// was requested, 409 when nothing is running to cancel.
app.post('/api/refresh/cancel', (req, res) => {
    if (!req.get('x-requested-with')) {
        return res.status(403).json({ error: 'Missing X-Requested-With header.' });
    }
    if (!requestCancel()) return res.status(409).json({ error: 'No refresh is running.' });
    res.status(202).json(refreshStatus());
});

// GET /api/refresh - poll the refresh job state + freshness signal
// (data_version bumps on every successful run; last_success carries its
// mode/dates so clients reload only when their loaded date is in scope)
app.get('/api/refresh', (req, res) => res.json(refreshStatus()));

// Built frontend (npm run build:web) with SPA fallback for non-/api routes
const dist = path.resolve('web', 'dist');
if (existsSync(dist)) {
    app.use(express.static(dist));
    app.use((req, res, next) => {
        if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
        res.sendFile(path.join(dist, 'index.html'));
    });
}

// JSON error handler: client errors (bad sort/filter/JSON) are 400s
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err instanceof TypeError ? 400 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: String(err?.message ?? err) });
});

const server = app.listen(config.API_PORT, config.API_HOST, () => {
    console.debug(`[+] oddspro API listening on http://${config.API_HOST}:${config.API_PORT}`);
    startAutoRefresh();
});

// Graceful shutdown - stop the scheduler, close the HTTP server and the pool
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        stopAutoRefresh();
        server.close(() => closeDb().finally(() => process.exit(0)));
    });
}
