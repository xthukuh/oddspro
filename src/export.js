import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _date, _dtime } from './utils.js';
import { queryRecords, columnCatalog } from './db/records.js';

// `export [date]` action - temp CSV of the date's correlated records with the
// README column spec: api_id, start_time, fixture, provider, match_url,
// score, goals, [default market columns], [default STATS columns].
// Written to tmp/ (gitignored).

// Escape one CSV cell (RFC 4180: quote when needed, double inner quotes)
function _cell(value) {
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportRecords(date_ = null) {
    const dt = _dtime(_date(date_)).substring(0, 10);
    const catalog = await columnCatalog();
    const marketCols = catalog.markets.filter(c => c.default);
    const statCols = catalog.stats.filter(c => c.default);

    const header = [
        'api_id', 'start_time', 'fixture', 'provider', 'match_url', 'score', 'goals',
        ...marketCols.map(c => c.label),
        ...statCols.map(c => c.label),
    ];
    const lines = [header.map(_cell).join(',')];

    let page = 1, pages = 1, rows = 0;
    do {
        const res = await queryRecords({ date: dt, page, per_page: 500 });
        pages = res.pages;
        for (const r of res.data) {
            lines.push([
                r.api_id, r.start_time instanceof Date ? _dtime(r.start_time) : r.start_time,
                r.fixture, r.provider, r.match_url, r.score, r.goals,
                ...marketCols.map(c => r.markets[c.key]),
                ...statCols.map(c => c.key.startsWith('fs:') ? r.stats[c.key] : r[c.key]),
            ].map(_cell).join(','));
            rows++;
        }
    } while (++page <= pages);

    const file = path.join('tmp', `export-${dt}.csv`);
    await mkdir('tmp', { recursive: true });
    await writeFile(file, String.fromCharCode(0xFEFF) + lines.join('\r\n') + '\r\n', 'utf8'); // BOM for Excel
    return { date: dt, rows, file };
}
