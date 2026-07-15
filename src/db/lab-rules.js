// Pure data-viz-lab rules (zero imports, offline-testable). The admin lab
// explores "which pre-match features correlate with which outcomes" over
// SETTLED fixtures: src/lab.js loads flat rows (SQL only), these rules derive
// feature/outcome values, bin numerics, and aggregate into small pre-binned
// {x, y?, color?, rate, count} cells the API ships to the browser - raw rows
// never leave the server.
//
// Data-integrity ground rules baked into the catalog:
//   - rank/form/H2H come from the FROZEN fixture_prematch snapshot, never live
//     standings - live tables already contain the match being studied (leakage).
//   - a cell below minCount reports rate:null (count kept): thin bins render
//     greyed instead of screaming "100% hit rate" over 3 samples.
//   - mysql2 returns DECIMAL columns as strings ('0.5500') - every numeric
//     path coerces with Number() and treats non-finite as missing.

// Feature catalog: what the X / Y / color pickers offer. `bin` (numbers only)
// is {width, min?, max?} - binValue() clamps into [min, max). Shipped verbatim
// by GET /api/admin/lab/features, so entries stay plain JSON data.
export const LAB_FEATURES = [
    { key: 'league', label: 'League', type: 'category' },
    { key: 'country', label: 'Country', type: 'category' },
    { key: 'tip_market', label: 'Tip market', type: 'category' },
    { key: 'kickoff_hour', label: 'Kickoff hour (EAT)', type: 'number', bin: { width: 2, min: 0, max: 24 } },
    { key: 'rank_diff', label: 'Rank diff (home − away)', type: 'number', bin: { width: 5 } },
    { key: 'form_diff', label: 'Form points diff (home − away)', type: 'number', bin: { width: 3 } },
    { key: 'h2h_avg_goals', label: 'H2H avg goals / meeting', type: 'number', bin: { width: 0.5, min: 0 } },
    { key: 'implied_over', label: 'Implied P(over 2.5), devigged', type: 'number', bin: { width: 0.1, min: 0, max: 1 } },
    { key: 'tip_confidence', label: 'Tip confidence', type: 'number', bin: { width: 0.05, min: 0, max: 1 } },
    { key: 'tip_price', label: 'Tip price', type: 'number', bin: { width: 0.25, min: 1 } },
    { key: 'home_odds', label: 'Home win odds (1)', type: 'number', bin: { width: 0.5, min: 1 } },
    { key: 'away_odds', label: 'Away win odds (2)', type: 'number', bin: { width: 0.5, min: 1 } },
    { key: 'shots_total', label: 'Shots on goal (both teams)', type: 'number', bin: { width: 4, min: 0 } },
    { key: 'corners_total', label: 'Corners (both teams)', type: 'number', bin: { width: 2, min: 0 } },
];

// Outcome catalog: the binary event whose empirical rate colors the chart.
export const LAB_OUTCOMES = [
    { key: 'over25', label: 'Over 2.5 goals' },
    { key: 'btts', label: 'Both teams scored' },
    { key: 'tip_hit', label: 'Tip hit (settled tips only)' },
    { key: 'home_win', label: 'Home win' },
    { key: 'draw', label: 'Draw' },
    { key: 'away_win', label: 'Away win' },
];

const FEATURE_BY_KEY = new Map(LAB_FEATURES.map(f => [f.key, f]));
const OUTCOME_BY_KEY = new Map(LAB_OUTCOMES.map(o => [o.key, o]));

export function labFeature(key) {
    return FEATURE_BY_KEY.get(key) ?? null;
}

export function labOutcome(key) {
    return OUTCOME_BY_KEY.get(key) ?? null;
}

// Number-or-missing: mysql2 DECIMALs arrive as strings; anything non-finite
// (null, '', junk) is missing data, never 0.
function _num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// Total points over a W/D/L form string ('WWDLW' -> 10). Non-result chars are
// ignored (API pads with '-'); a string with NO results at all is missing.
export function formPoints(form) {
    if (form == null) return null;
    let points = 0;
    let games = 0;
    for (const ch of String(form).toUpperCase()) {
        if (ch === 'W') { points += 3; games++; }
        else if (ch === 'D') { points += 1; games++; }
        else if (ch === 'L') { games++; }
    }
    return games ? points : null;
}

// Feature value for one loader row -> number | string | null (missing).
export function featureValue(row, key) {
    const f = labFeature(key);
    if (!f) throw new TypeError(`Unknown lab feature: ${key}`);
    switch (key) {
        case 'rank_diff': {
            const h = _num(row.home_rank);
            const a = _num(row.away_rank);
            return h != null && a != null ? h - a : null;
        }
        case 'form_diff': {
            const h = formPoints(row.home_form);
            const a = formPoints(row.away_form);
            return h != null && a != null ? h - a : null;
        }
        case 'h2h_avg_goals': {
            const n = _num(row.h2h_n);
            const hg = _num(row.h2h_home_goals);
            const ag = _num(row.h2h_away_goals);
            return n > 0 && hg != null && ag != null ? (hg + ag) / n : null;
        }
        default:
            if (f.type === 'category') return row[key] == null ? null : String(row[key]);
            return _num(row[key]);
    }
}

// Outcome value for one row -> 1 | 0 | null (not settled / not applicable).
export function outcomeValue(row, key) {
    if (!labOutcome(key)) throw new TypeError(`Unknown lab outcome: ${key}`);
    if (key === 'tip_hit') {
        return row.tip_outcome === 'hit' ? 1 : row.tip_outcome === 'miss' ? 0 : null;
    }
    const h = _num(row.ft_home);
    const a = _num(row.ft_away);
    if (h == null || a == null) return null;
    switch (key) {
        case 'over25': return h + a >= 3 ? 1 : 0;
        case 'btts': return h >= 1 && a >= 1 ? 1 : 0;
        case 'home_win': return h > a ? 1 : 0;
        case 'draw': return h === a ? 1 : 0;
        case 'away_win': return a > h ? 1 : 0;
        /* c8 ignore next */
        default: return null; // unreachable - catalog keys are exhaustive above
    }
}

// Bin a numeric value -> its bin's start. No bin spec = category passthrough.
// Clamps into [min, max) so out-of-range values land in the edge bins; the
// epsilon + rounding keep float widths (0.05, 0.1) from drifting bin starts.
export function binValue(value, bin) {
    if (!bin) return value;
    const n = _num(value);
    if (n == null) return null;
    const base = bin.min ?? 0;
    let start = Math.floor((n - base) / bin.width + 1e-9) * bin.width + base;
    if (bin.min != null && start < bin.min) start = bin.min;
    if (bin.max != null && start >= bin.max) start = bin.max - bin.width;
    return Math.round(start * 1e6) / 1e6;
}

const FILTER_OPS = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like']);

// Filter rows on feature values: [{key, op, value}] with eq/ne/gt/gte/lt/lte
// (+ case-insensitive `like` contains for categories). A row whose feature is
// missing never matches any condition. Bad keys/ops/values throw TypeError
// (the server maps it to a 400, same idiom as records.js#_coerce).
export function applyLabFilters(rows, filters = []) {
    if (!Array.isArray(filters) || !filters.length) return rows;
    const preds = filters.map(({ key, op, value }) => {
        const f = labFeature(key);
        if (!f) throw new TypeError(`Unknown lab filter feature: ${key}`);
        if (!FILTER_OPS.has(op)) throw new TypeError(`Unknown lab filter op: ${op}`);
        if (f.type === 'number' && op !== 'like') {
            const want = Number(value);
            if (Number.isNaN(want)) throw new TypeError(`Invalid numeric filter value for ${key}: ${JSON.stringify(value)}`);
            return row => {
                const v = featureValue(row, key);
                if (v == null) return false;
                switch (op) {
                    case 'eq': return v === want;
                    case 'ne': return v !== want;
                    case 'gt': return v > want;
                    case 'gte': return v >= want;
                    case 'lt': return v < want;
                    case 'lte': return v <= want;
                    /* c8 ignore next */
                    default: return false;
                }
            };
        }
        const want = String(value);
        const wantLc = want.toLowerCase();
        return row => {
            const v = featureValue(row, key);
            if (v == null) return false;
            const s = String(v);
            if (op === 'like') return s.toLowerCase().includes(wantLc);
            if (op === 'eq') return s === want;
            if (op === 'ne') return s !== want;
            return false; // ordering ops are meaningless on categories
        };
    });
    return rows.filter(row => preds.every(p => p(row)));
}

// Fold a high-cardinality category axis: keep the top-N values by row count,
// everything else becomes '(other)'. Returns the identity mapper for numeric
// axes / within-budget categories.
function _categoryFolder(rows, key, spec, outcome, topCategories) {
    if (spec.bin) return v => v;
    const counts = new Map();
    for (const row of rows) {
        if (outcomeValue(row, outcome) == null) continue;
        const v = featureValue(row, key);
        if (v == null) continue;
        counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (counts.size <= topCategories) return v => v;
    const keep = new Set([...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, topCategories)
        .map(([v]) => v));
    return v => (keep.has(v) ? v : '(other)');
}

// Axis sorter: numeric bins ascending; categories by cell count descending
// (stable for equal counts, '(other)' last) - the natural bar-chart order.
function _cellSorter(spec) {
    if (!spec || spec.bin) return (a, b) => a.v - b.v;
    return (a, b) => {
        if (a.v === '(other)') return 1;
        if (b.v === '(other)') return -1;
        return b.count - a.count || String(a.v).localeCompare(String(b.v));
    };
}

// The lab's core: group rows by binned x (and optional y / color axes), and
// report the outcome's empirical rate per cell. Cells below minCount keep
// their count but report rate:null (the guardrail - see module header).
//   -> { cells: [{x, y?, color?, count, hits, rate}], rows_used, rows_skipped,
//        min_count }
export function aggregateOutcomeRate(rows, { xKey, yKey = null, colorKey = null, outcome, minCount = 10, topCategories = 12 } = {}) {
    const xSpec = labFeature(xKey);
    if (!xSpec) throw new TypeError(`Unknown lab feature: ${xKey}`);
    const ySpec = yKey ? labFeature(yKey) : null;
    if (yKey && !ySpec) throw new TypeError(`Unknown lab feature: ${yKey}`);
    const colorSpec = colorKey ? labFeature(colorKey) : null;
    if (colorKey && !colorSpec) throw new TypeError(`Unknown lab feature: ${colorKey}`);
    if (!labOutcome(outcome)) throw new TypeError(`Unknown lab outcome: ${outcome}`);

    const axes = [{ key: xKey, spec: xSpec, prop: 'x' }];
    if (ySpec) axes.push({ key: yKey, spec: ySpec, prop: 'y' });
    if (colorSpec) axes.push({ key: colorKey, spec: colorSpec, prop: 'color' });
    for (const axis of axes) {
        axis.fold = _categoryFolder(rows, axis.key, axis.spec, outcome, topCategories);
    }

    const cells = new Map();
    let used = 0;
    let skipped = 0;
    for (const row of rows) {
        const out = outcomeValue(row, outcome);
        const vals = out == null ? null : axes.map(a => a.fold(binValue(featureValue(row, a.key), a.spec.bin)));
        if (vals == null || vals.some(v => v == null)) { skipped++; continue; }
        used++;
        const id = vals.join(' ');
        let cell = cells.get(id);
        if (!cell) {
            cell = { count: 0, hits: 0 };
            axes.forEach((a, i) => { cell[a.prop] = vals[i]; });
            cells.set(id, cell);
        }
        cell.count++;
        cell.hits += out;
    }

    const sorters = axes.map(a => ({ prop: a.prop, cmp: _cellSorter(a.spec) }));
    const list = [...cells.values()]
        .map(c => ({ ...c, rate: c.count >= minCount ? c.hits / c.count : null }))
        .sort((a, b) => {
            for (const { prop, cmp } of sorters) {
                const d = cmp({ v: a[prop], count: a.count }, { v: b[prop], count: b.count });
                if (d) return d;
            }
            return 0;
        });
    // Cell field order (x, y, color, count, hits, rate) for stable JSON.
    const cellsOut = list.map(c => {
        const out = {};
        for (const a of axes) out[a.prop] = c[a.prop];
        out.count = c.count;
        out.hits = c.hits;
        out.rate = c.rate;
        return out;
    });
    return { cells: cellsOut, rows_used: used, rows_skipped: skipped, min_count: minCount };
}
