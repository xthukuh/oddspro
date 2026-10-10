// Pure diff between a match's stored odds_markets rows and the latest
// scraper snapshot (stale odds retention), plus the change-log events the
// odds history records for the same comparison. Zero imports by design so
// tests run without touching config/.env/knex.

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

// Price in integer cents, or NaN for junk. mysql2 returns a DECIMAL(8,2) as a
// string ('1.85') while a scraped snapshot carries a number (1.85), and float
// equality on either is a trap - cents make "did the price move" exact.
export function priceCents(value) {
    if (value == null || value === '') return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function _handicapOut(h) {
    return h == null || h === '' || !Number.isFinite(Number(h)) ? null : Number(Number(h).toFixed(1));
}

// Change-log events for one observation of one match (odds history, spec
// docs/dev/specs/2026-10-10-1600-odds-history-targets.md). Compares the stored
// odds_markets rows ({type_name, name, handicap, price, is_stale}) with the
// new snapshot rows ({type_name, name, handicap, price}) and returns ONLY what
// moved, as [{type_name, name, handicap, odds, prev_odds, event}]:
//   first_seen - identity never on file          odds=new, prev=null
//   changed    - fresh on file, different price   odds=new, prev=old
//   revived    - stale on file, back in snapshot  odds=new, prev=last-seen
//   stale      - fresh on file, missing now       odds=last-seen, prev=null
// An unchanged fresh price and a still-missing stale market write nothing.
//
// `baseline: true` is the resync form, used when odds_markets moved without
// the log seeing it (pre-existing match, history switched off for a while, a
// post-kickoff write): EVERY snapshot identity is emitted as `baseline` and
// EVERY on-file identity absent from the snapshot as `stale`, so replaying the
// log from this point is exact again whatever it missed before.
//
// A snapshot that lists the same identity twice keeps its FIRST occurrence;
// on-file duplicates prefer a fresh row. Rows whose price is not a finite
// number are skipped (store.js already drops them before this point).
export function diffOddsChanges(existingRows, snapshotRows, { baseline = false } = {}) {
    const onFile = new Map();
    for (const row of Array.isArray(existingRows) ? existingRows : []) {
        const id = oddsIdentity(row);
        const prev = onFile.get(id);
        if (!prev || (prev.is_stale && !row.is_stale)) onFile.set(id, row);
    }
    const seen = new Set();
    const out = [];
    for (const row of Array.isArray(snapshotRows) ? snapshotRows : []) {
        const id = oddsIdentity(row);
        if (seen.has(id)) continue;
        const cents = priceCents(row.price);
        if (!Number.isFinite(cents)) continue;
        seen.add(id);
        const old = onFile.get(id);
        const oldCents = old ? priceCents(old.price) : NaN;
        const base = { type_name: row.type_name, name: row.name, handicap: _handicapOut(row.handicap), odds: cents / 100 };
        if (baseline) {
            out.push({ ...base, prev_odds: Number.isFinite(oldCents) ? oldCents / 100 : null, event: 'baseline' });
        } else if (!old) {
            out.push({ ...base, prev_odds: null, event: 'first_seen' });
        } else if (old.is_stale) {
            out.push({ ...base, prev_odds: Number.isFinite(oldCents) ? oldCents / 100 : null, event: 'revived' });
        } else if (oldCents !== cents) {
            out.push({ ...base, prev_odds: Number.isFinite(oldCents) ? oldCents / 100 : null, event: 'changed' });
        }
    }
    for (const [id, old] of onFile) {
        if (seen.has(id)) continue;
        if (old.is_stale && !baseline) continue;
        const oldCents = priceCents(old.price);
        if (!Number.isFinite(oldCents)) continue;
        out.push({
            type_name: old.type_name, name: old.name, handicap: _handicapOut(old.handicap),
            odds: oldCents / 100, prev_odds: null, event: 'stale',
        });
    }
    return out;
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
