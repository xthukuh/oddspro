import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { queryRecords, columnCatalog } from './db/records.js';
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
        const { date, page, per_page, sort, filters } = req.query;
        res.json(await queryRecords({
            date: date === 'all' ? null : (date || new Date()),
            page,
            per_page,
            sort: _json(sort, []),
            filters: _json(filters, []),
        }));
    } catch (e) {
        next(e);
    }
});

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

const server = app.listen(config.API_PORT, () => {
    console.debug(`[+] oddspro API listening on http://localhost:${config.API_PORT}`);
});

// Graceful shutdown - close the HTTP server and the knex pool
for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        server.close(() => closeDb().finally(() => process.exit(0)));
    });
}
