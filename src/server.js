import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { queryRecords, columnCatalog } from './db/records.js';
import { hotpicksSummary, performanceSummary } from './hotpicks.js';
import { magicSortCached } from './magic.js';
import { runDateRefresh } from './pipeline.js';
import { closeDb } from './db/connection.js';

// Visualization API server (:3001). Serves the paginated/multi-sort/filtered
// records endpoint over the warehouse plus the column catalog for the web
// settings modal, and the built web/dist frontend when present.
// Start with `npm run serve`; the vite dev server proxies /api/* here.

const app = express();
app.disable('x-powered-by');

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

// Single-slot refresh job state - one refresh at a time: parallel refreshes
// would deadlock on InnoDB delete+insert gap locks (same rule as `_batch`
// DB-writing concurrency 1), and a second sweep of the same date is wasted
// server hits anyway.
const refreshJob = {
    running: false,
    date: null,
    step: null,
    started_at: null,
    finished_at: null,
    error: null,
    summary: null,
};

// POST /api/refresh?date=YYYY-MM-DD - start refreshing a date's data
// (fixtures, results, odds, link, stats). 409 with the in-flight job when one
// is already running; the response is always the current job state.
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
    if (refreshJob.running) return res.status(409).json(refreshJob);
    Object.assign(refreshJob, {
        running: true,
        date,
        step: 'starting',
        started_at: new Date().toISOString(),
        finished_at: null,
        error: null,
        summary: null,
    });
    runDateRefresh(date, step => { refreshJob.step = step; })
        .then(summary => { refreshJob.summary = summary; })
        .catch(e => {
            refreshJob.error = String(e?.message ?? e);
            console.error(e);
        })
        .finally(() => {
            refreshJob.running = false;
            refreshJob.step = null;
            refreshJob.finished_at = new Date().toISOString();
        });
    res.status(202).json(refreshJob);
});

// GET /api/refresh - poll the refresh job state
app.get('/api/refresh', (req, res) => res.json(refreshJob));

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
});

// Graceful shutdown - close the HTTP server and the knex pool
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => closeDb().finally(() => process.exit(0)));
    });
}
