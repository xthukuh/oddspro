// Client-side sort registry: the table holds the whole selection
// (per_page=all), so every column - including the JS-derived stat columns
// the server can't ORDER BY - sorts instantly in the browser.
//
// sortValue(row, col) -> number | string | null. A null always sorts last
// regardless of direction: missing data never tops a ranking.

// "WWDLW" -> league form points (W=3, D=1)
function _formPoints(v) {
    if (typeof v !== 'string' || !v) return null;
    let pts = 0;
    for (const c of v) pts += c === 'W' ? 3 : c === 'D' ? 1 : 0;
    return pts;
}

// "2W-1D-0L" (home-team perspective) -> points (3w + d)
function _h2hPoints(v) {
    const m = typeof v === 'string' ? v.match(/^(\d+)W-(\d+)D-(\d+)L$/) : null;
    return m ? Number(m[1]) * 3 + Number(m[2]) : null;
}

// Rolling-goals compact string "gf/ga (avg)" -> the avg-total number. The
// format is owned by formatGoals (src/db/prematch-calc.js) - keep in sync.
function _goalsAvg(v) {
    const m = typeof v === 'string' ? v.match(/\((\d+(?:\.\d+)?)\)$/) : null;
    return m ? Number(m[1]) : null;
}

// Post-match stat "H / A" -> numeric sum (parseFloat handles "55%")
function _statSum(v) {
    if (typeof v !== 'string') return null;
    const nums = v.split('/').map(s => parseFloat(s)).filter(n => !Number.isNaN(n));
    return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

// "2-1" -> total goals
function _scoreTotal(v) {
    const m = typeof v === 'string' ? v.match(/^(\d+)-(\d+)$/) : null;
    return m ? Number(m[1]) + Number(m[2]) : null;
}

const _num = v => (v == null || v === '' ? null : Number(v));
const _date = v => (v == null ? null : Date.parse(v));
const _str = v => (v == null || v === '' ? null : String(v).toLowerCase());

// Per-column extractors; market and fs: columns fall through to the group
// handling in sortValue.
const VALUES = {
    // Synthetic "No" column: its load-order anchor position, stamped on the row
    // by DataTable (null when unstamped -> sorts last, like any missing value).
    no: r => _num(r._no),
    // Synthetic "Select" column: the row's checkbox state (stamped boolean);
    // sorts checked-first under descending. Non-boolean -> null (sorts last).
    select: r => (r.select == null ? null : (r.select ? 1 : 0)),
    api_id: r => _num(r.api_id),
    start_time: r => _date(r.start_time),
    fixture: r => _str(r.fixture),
    provider: r => _str(r.provider),
    score: r => _scoreTotal(r.score),
    goals: r => _num(r.goals),
    // Hot picks outrank plain tips so descending puts the best on top
    tip: r => (r.tip_confidence == null && !r.hot
        ? null
        : (Number(r.tip_confidence) || 0) + (r.hot ? 1 : 0)),
    // The chosen tip's overall confidence as an integer win % (0-100), matching
    // the % the tip cell displays — a filter-only field (no hot bonus, no table
    // column) so users can screen by "win % ≥ 70".
    tip_confidence: r => (r.tip_confidence == null ? null : Math.round(Number(r.tip_confidence) * 100)),
    status: r => _str(r.status),
    updated_at: r => _date(r.updated_at),
    locked_at: r => _date(r.locked_at),
    league: r => _str(r.league),
    season: r => _num(r.season),
    round: r => _str(r.round),
    home_rank: r => _num(r.home_rank),
    away_rank: r => _num(r.away_rank),
    home_form: r => _formPoints(r.home_form),
    away_form: r => _formPoints(r.away_form),
    h2h: r => _h2hPoints(r.h2h),
    h2h_count: r => _num(r.h2h_count),
    home_goals_h2h: r => _goalsAvg(r.home_goals_h2h),
    away_goals_h2h: r => _goalsAvg(r.away_goals_h2h),
    home_goals_oth: r => _goalsAvg(r.home_goals_oth),
    away_goals_oth: r => _goalsAvg(r.away_goals_oth),
};

export function sortValue(row, col) {
    const fn = VALUES[col.key];
    if (fn) return fn(row);
    // Fresh prices only - parity with the old server sort (is_stale = 0):
    // frozen/vanished odds aren't actionable, so they rank as missing.
    if (col.group === 'market') return row.markets?.[col.key] ?? null;
    if (col.key.startsWith('fs:')) return _statSum(row.stats?.[col.key]);
    return row[col.key] ?? null;
}

// Sorted copy honoring the multi-sort chain. Native sort is spec-stable
// (ES2019+), so ties keep the server's start_time/api_id/provider order.
export function sortRows(rows, sort, columns) {
    if (!Array.isArray(sort) || !sort.length) return rows;
    const byKey = new Map(columns.map(c => [c.key, c]));
    const chain = sort.map(s => ({
        col: byKey.get(s.key) ?? { key: s.key },
        dir: s.dir === 'asc' ? 1 : -1,
    }));
    return [...rows].sort((a, b) => {
        for (const { col, dir } of chain) {
            const va = sortValue(a, col), vb = sortValue(b, col);
            if (va == null && vb == null) continue;
            if (va == null) return 1; // nulls last, either direction
            if (vb == null) return -1;
            const cmp = typeof va === 'number' && typeof vb === 'number'
                ? va - vb
                : String(va).localeCompare(String(vb));
            if (cmp) return cmp * dir;
        }
        return 0;
    });
}
