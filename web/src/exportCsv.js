// Client-side CSV export for the "With selected" action. Pure (no DOM), so
// node:test covers the escaping and the full-record schema offline; App owns the
// Blob download. "Full record details incl. hidden info columns" - every field
// the row carries (including the ones folded out of the table into tooltips: id,
// updated/locked times, canonical team names) plus every catalog market column
// and post-match stat.

// RFC-4180 escaping: quote a field holding a comma, quote, CR or LF; double any
// inner quote. null/undefined render empty. Rows joined with CRLF (Excel-safe).
function escapeCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvString(headers, rows) {
    return [headers, ...rows].map(r => r.map(escapeCell).join(',')).join('\r\n');
}

// Ordered [label, getter] pairs for the fixed part of a record. Markets and
// post-match stats are appended dynamically from the catalog so the export
// stays in step with newly-integrated bookmakers / stat types.
const FIXED_COLUMNS = [
    ['ID', r => r.api_id],
    ['Start', r => r.start_time],
    ['League', r => r.league],
    ['Season', r => r.season],
    ['Round', r => r.round],
    ['Home Team', r => r.home_team],
    ['Away Team', r => r.away_team],
    ['Fixture', r => r.fixture],
    ['Canonical', r => r.fixture_api],
    ['Provider', r => r.provider],
    ['Status', r => r.status],
    ['Elapsed', r => r.elapsed],
    ['Score', r => r.score],
    ['Goals', r => r.goals],
    ['Available', r => (r.available ? 'yes' : 'no')],
    ['Updated', r => r.updated_at],
    ['Locked', r => r.locked_at],
    ['Home Rank', r => r.home_rank],
    ['Home Form', r => r.home_form],
    ['Away Rank', r => r.away_rank],
    ['Away Form', r => r.away_form],
    ['H2H', r => r.h2h],
    ['Meetings', r => r.h2h_count],
    ['H Goals vs Opp', r => r.home_goals_h2h],
    ['A Goals vs Opp', r => r.away_goals_h2h],
    ['H Goals vs Others', r => r.home_goals_oth],
    ['A Goals vs Others', r => r.away_goals_oth],
    ['Hot', r => (r.hot ? 'yes' : '')],
    ['Hot Score', r => r.hot_score],
    ['Hot Outcome', r => r.hot_outcome],
    ['Tip', r => r.tip_market],
    ['Tip Price', r => r.tip_price],
    ['Tip %', r => (r.tip_confidence == null ? '' : Math.round(r.tip_confidence * 100))],
    ['Tip Outcome', r => r.tip_outcome],
    ['Tip Skip', r => r.tip_skip_reason],
    ['Tip AI Verdict', r => r.tip_ai_verdict],
    ['Match URL', r => r.match_url],
];

// Build the full column list (fixed + every catalog market + every post-match
// fs:* stat). A market cell prefers the fresh price, falling back to the
// last-seen stale one (matches the table).
function recordColumns(catalog) {
    const marketCols = (catalog?.markets ?? []).map(c => [
        c.key,
        r => r.markets?.[c.key] ?? r.markets_stale?.[c.key] ?? '',
    ]);
    const statCols = (catalog?.stats ?? [])
        .filter(c => c.key.startsWith('fs:'))
        .map(c => [c.label ?? c.key, r => r.stats?.[c.key] ?? '']);
    return [...FIXED_COLUMNS, ...marketCols, ...statCols];
}

// Full-record CSV for the given records. Header-only when records is empty.
export function buildRecordCsv(records, catalog) {
    const cols = recordColumns(catalog);
    const headers = cols.map(c => c[0]);
    const rows = (records ?? []).map(r => cols.map(c => c[1](r)));
    return toCsvString(headers, rows);
}
