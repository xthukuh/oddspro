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

// How much better the flipped pairing must score before we believe a listing's
// sides are reversed. Deliberately wide: a genuine reversal scores near 0
// straight and near 1 flipped (measured 0.00 vs 1.00 on the real cases), so a
// large gap costs us nothing and keeps ordinary fuzzy noise out.
export const ORIENTATION_MARGIN = 0.30;

// Is this linked match listed with its home/away sides the opposite way round
// from the canonical fixture?
//
//   straight - 0.5*sim(matchHome, fixtureHome) + 0.5*sim(matchAway, fixtureAway)
//   flip     - 0.5*sim(matchHome, fixtureAway) + 0.5*sim(matchAway, fixtureHome)
//
// Returns 'swapped', 'straight' or 'unknown'. 'unknown' means the two pairings
// are too close to call, and the caller must LEAVE THE STORED FLAG ALONE rather
// than guess: flapping a display flag on fuzzy noise would be worse than the
// occasional stale one, and short or heavily abbreviated names ("Nottingham v
// Guimaraes") legitimately score low both ways.
//
// Total over non-finite input, since both scores come from a similarity
// function applied to provider-supplied text.
export function orientationVerdict(straight, flip, margin = ORIENTATION_MARGIN) {
    const a = Number(straight), b = Number(flip);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return 'unknown';
    if (b - a > margin) return 'swapped';
    if (a - b > margin) return 'straight';
    return 'unknown';
}

// Does the stored flag need writing? Returns the boolean to persist, or null
// when nothing should change - so the re-validation pass issues an UPDATE only
// for rows that actually moved, instead of rewriting every linked row (and
// bumping their `updated_at`, which the web surfaces as the odds refresh time).
export function orientationUpdate(verdict, current) {
    if (verdict === 'unknown') return null;
    const next = verdict === 'swapped';
    return next === Boolean(current) ? null : next;
}

// --- Team qualifiers (audit finding F4): MEASURED AND REFUTED, do not rebuild
//
// F4's proposed fix was a hard veto on a squad-qualifier mismatch (women vs
// men, reserve vs first team, U20 vs senior), on the reasoning that the
// difference is categorical rather than fuzzy. The mechanism it describes is
// real: `_tokenSim` returns `max(dice, 0.9 * overlap)`, so any strict token
// subset scores exactly 0.9, and "Arsenal Women" clears the 0.85 floor against
// "Arsenal" with no competition evidence at all.
//
// The veto was built and measured against all 18,022 live links before being
// wired in. It cannot ship, and the numbers are worth keeping so nobody
// rebuilds it:
//
//   Exact-tag veto on team names ............ rejects 958 links (5.3%)
//   Women-only, team OR competition evidence . rejects 57
//   Additionally on development/senior ....... rejects a further 994
//
// Nearly all are CORRECT links, because the two sources tag squads
// inconsistently and in different FIELDS:
//   - the bookmaker puts it in the competition ("U20 NSW NPL", "Liga Femenina")
//     and leaves the team name bare, while API-Football puts it in the team
//     name ("Manly Utd U20", "Washington Spirit W");
//   - API-Football is not even self-consistent: fixture "VIFK W v IF Gnistan"
//     tags one side of a women's fixture and not the other;
//   - whole women's leagues carry no marker at all (Damallsvenskan, WK-League);
//   - a bare "w" token is not a marker - "Springvale W. E." is White Eagles and
//     "Havant & W" is Waterlooville;
//   - a bare "2" token is not a reserve marker - it rejected an exact 1.00
//     name match because the league is called "China League 2".
//
// Against that, the confirmed error the veto was meant to catch is a single row
// in 18,022 (betika "North Lakes United v Caboolture FC", Queensland Premier
// League 1 Women, linked to the men's "Broadbeach United v Caboolture"), and it
// happened because API-Football did not carry that women's league for the date,
// so the men's fixture won the pool uncontested. A name veto is the wrong
// instrument for that: the fix would have to be in candidate SCOPING.
//
// This is the same lesson the codebase already recorded twice - competition
// similarity is a bonus and never a veto, and v1's AI contradiction vetoes were
// net-negative. Full evidence in
// docs/research/2026-08-19-linker-and-apisports-audit.md.
