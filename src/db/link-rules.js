// Pure decision rules for the correlator (src/link.js). Zero imports, so the
// tests run offline with no config/.env/DB.
//
// Why this module exists: a bookmaker match and a canonical fixture are linked
// ONCE and never re-checked, so every mistake the linker makes is permanent.
// The rules that decide "should this link be written at all" therefore belong
// somewhere they can be exhaustively tested, not inline in the DB loop.

// How far a match's bookmaker-provided start_time may sit from the canonical
// kickoff before the two are considered different listings of the game. The
// linker's own candidate window is +/-30 min, so anything inside that is
// normal clock noise, not a reschedule.
export const CLAIM_DRIFT_MINUTES = 30;

const _ms = v => {
    const t = v instanceof Date ? v.getTime() : Date.parse(v);
    return Number.isFinite(t) ? t : null;
};

// Minutes between a match start_time and a fixture kickoff, or null when
// either side is unparseable (mysql2 hands back Date objects, the tests hand
// back ISO strings, and a NULL column is legitimate).
export function claimDriftMinutes(startTime, kickoff) {
    const a = _ms(startTime), b = _ms(kickoff);
    if (a == null || b == null) return null;
    return Math.abs(a - b) / 60000;
}

// Which match should hold `fixture_id` when a second one of the SAME provider
// wants to claim the same canonical fixture?
//
// This is the reschedule case, and it is a live corruption path when it goes
// unhandled: API-Football moves a fixture's kickoff, the bookmaker relists the
// game under a NEW provider_match_id at the new time, and the old listing keeps
// its link. The settle pass joins on `m.fixture_id = f.id`, so it writes the
// eventual score onto BOTH rows - and the stale one is displayed under its
// ORIGINAL date, showing a result for a game that had not been played yet.
// (Verified 2026-08-19: fixture 1493561, played 2026-08-06, put its 1-0 onto
// two 2026-07-05 rows; 103 duplicate claims warehouse-wide.)
//
//   existing - the match already holding the link ({ id, start_time }), or null
//   incoming - the match the linker wants to link now ({ id, start_time })
//   kickoff  - the fixture's canonical kickoff
//
// Returns 'link' (no contest), 'replace' (incoming is the better listing, evict
// the existing one) or 'skip' (existing stays; incoming is not linked).
//
// Total and deliberately conservative: an unparseable kickoff or start_time
// means we cannot tell which listing is right, and unlinking on a guess would
// destroy a good link, so an existing claim always survives.
export function claimVerdict({ existing, incoming, kickoff } = {}) {
    if (!existing || existing.id == null) return 'link';
    if (incoming && existing.id === incoming.id) return 'link'; // re-linking itself
    const dExisting = claimDriftMinutes(existing.start_time, kickoff);
    const dIncoming = claimDriftMinutes(incoming?.start_time, kickoff);
    if (dExisting == null || dIncoming == null) return 'skip';
    // Strictly closer wins. A tie keeps the incumbent: churn between two
    // equally-plausible listings would rewrite links on every pass.
    return dIncoming < dExisting ? 'replace' : 'skip';
}

// Is this link plainly contradicted by the clock? Used to report (not to
// block) - a link whose listing sits further from kickoff than the candidate
// window should never have been written, so it is worth counting.
export function claimIsDrifted(startTime, kickoff, limit = CLAIM_DRIFT_MINUTES) {
    const d = claimDriftMinutes(startTime, kickoff);
    return d != null && d > limit;
}
