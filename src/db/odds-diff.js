// Pure diff between a match's stored odds_markets rows and the latest
// scraper snapshot (stale odds retention). Zero imports by design so tests
// run without touching config/.env/knex.

// Identity of a market entry within one match. Matched on type_name (never
// type_id - betika reuses ids across markets). handicap is normalized
// numerically: mysql2 returns DECIMAL as a string ('2.5') while snapshots
// carry numbers (2.5). NUL delimiter - provider text may contain '|'.
export function oddsIdentity(row) {
    const h = row.handicap == null ? '' : Number(row.handicap).toFixed(1);
    return [row.type_name, row.name, h].join(String.fromCharCode(0));
}

// Compare existing DB rows ({id, type_name, name, handicap, is_stale})
// against the latest snapshot rows ({type_name, name, handicap, ...}):
//   deleteIds - existing rows (fresh or stale) whose identity IS in the
//               snapshot; the caller re-inserts them fresh (snapshot
//               replacement, and re-listed stale markets revive).
//   staleIds  - fresh existing rows missing from the snapshot; flagged
//               stale instead of deleted. Already-stale rows still missing
//               stay untouched (their updated_at marks when they went stale).
export function diffOddsRows(existingRows, snapshotRows) {
    const snapshot = new Set(snapshotRows.map(oddsIdentity));
    const staleIds = [], deleteIds = [];
    for (const row of existingRows) {
        if (snapshot.has(oddsIdentity(row))) deleteIds.push(row.id);
        else if (!row.is_stale) staleIds.push(row.id);
    }
    return { staleIds, deleteIds };
}

// A 200-with-empty-body detail response is structurally indistinguishable
// from a genuine "no markets right now" snapshot: parseBetpawaGame/
// parseBetikaGame both default to `markets: []` when the expected array is
// missing (degraded response, still a 200). Fed straight into diffOddsRows,
// an empty snapshot puts EVERY existing fresh row into staleIds - and since a
// frozen match is never revisited (completedMatchIds/oddsExcludeIds), if that
// glitch is the last fetch before kickoff, genuinely-live closing prices get
// permanently recorded as stale. An empty market list must mean "no
// snapshot", never "empty snapshot", whenever the match already had
// something real on file.
//
// Total: true only when the snapshot is empty AND at least one existing row
// is still fresh (not already stale) - a first sighting with zero markets
// (nothing existing yet) is fine to store as nothing, and a match whose rows
// were already all stale has nothing left to protect.
export function emptySnapshotIsSuspect(existingRows, snapshotRows) {
    if (Array.isArray(snapshotRows) && snapshotRows.length) return false;
    return Array.isArray(existingRows) && existingRows.some(row => !row.is_stale);
}
