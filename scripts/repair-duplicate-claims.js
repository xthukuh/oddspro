// Repair the reschedule-orphan corruption found by the 2026-08-19 link.js audit.
//
// One canonical fixture may be held by at most one match per provider. When
// API-Football reschedules a fixture the bookmaker relists the game under a new
// provider_match_id, and before src/db/link-rules.js's claimVerdict guard the
// OLD listing kept its fixture_id too. The settle pass joins on
// `m.fixture_id = f.id`, so it wrote the eventual score onto every claimant -
// and the stale one is displayed under its ORIGINAL date, showing a result for
// a game that was never played that day.
//
// This script keeps, per (provider, fixture_id), the listing whose start_time
// is closest to the canonical kickoff and unlinks the rest, clearing the scores
// they inherited. completed_at is deliberately left alone: it is a one-way door
// (see the fetch-throttling invariant) and reopening a dead provider_match_id
// would only buy pointless odds requests.
//
// Usage:
//   node scripts/repair-duplicate-claims.js              # dry run, prints the plan
//   node scripts/repair-duplicate-claims.js --yes        # apply
//   node scripts/repair-duplicate-claims.js --yes --limit 20
//
// Idempotent: a second run finds nothing to do.

import { db, closeDb } from '../src/db/connection.js';
import { claimVerdict, claimDriftMinutes } from '../src/db/link-rules.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--yes');
const LIMIT = (() => {
    const i = args.indexOf('--limit');
    return i >= 0 ? Math.max(1, parseInt(args[i + 1], 10) || 0) : null;
})();

const CLEARED = {
    fixture_id: null,
    home_score_fulltime: null, away_score_fulltime: null,
    home_score_first_half: null, away_score_first_half: null,
    home_score_second_half: null, away_score_second_half: null,
};

async function main() {
    // Every (provider, fixture_id) held by more than one match.
    const dupes = await db('matches')
        .whereNotNull('fixture_id')
        .select('provider', 'fixture_id')
        .groupBy('provider', 'fixture_id')
        .havingRaw('COUNT(*) > 1');

    if (!dupes.length) {
        console.log('[repair] no duplicate fixture claims - nothing to do.');
        return;
    }
    console.log(`[repair] ${dupes.length} duplicate (provider, fixture_id) claims found.`);

    const groups = LIMIT ? dupes.slice(0, LIMIT) : dupes;
    let evicted = 0, scored = 0, undecidable = 0;

    for (const g of groups) {
        const rows = await db('matches as m')
            .join('fixtures as f', 'f.id', 'm.fixture_id')
            .where('m.provider', g.provider).where('m.fixture_id', g.fixture_id)
            .select('m.id', 'm.provider_match_id', 'm.start_time', 'f.kickoff',
                'm.home_score_fulltime as hs', 'm.away_score_fulltime as as_')
            .orderBy('m.id');

        // The winner is the listing closest to the canonical kickoff. Reuse the
        // SAME pure rule the linker now applies, so a repaired warehouse and a
        // live pass can never disagree about who should hold the link.
        let winner = null;
        for (const r of rows) {
            if (!winner) { winner = r; continue; }
            const v = claimVerdict({ existing: winner, incoming: r, kickoff: r.kickoff });
            if (v === 'replace') winner = r;
        }
        const losers = rows.filter(r => r.id !== winner.id);
        // If no start_time/kickoff is parseable the rule refuses to choose;
        // leave the group alone rather than unlink on a guess.
        if (claimDriftMinutes(winner.start_time, winner.kickoff) == null) {
            undecidable++;
            console.log(`[repair] ${g.provider} fixture ${g.fixture_id}: unparseable clocks, skipped`);
            continue;
        }

        for (const l of losers) {
            const drift = claimDriftMinutes(l.start_time, l.kickoff);
            const hadScore = l.hs != null || l.as_ != null;
            if (hadScore) scored++;
            evicted++;
            console.log(`[repair] ${g.provider} fixture ${g.fixture_id}: unlink match ${l.id} `
                + `(pm ${l.provider_match_id}, ${drift == null ? 'unknown' : Math.round(drift)} min from kickoff`
                + `${hadScore ? `, clearing score ${l.hs}-${l.as_}` : ''}) `
                + `- keeping ${winner.id}`);
            if (APPLY) await db('matches').where('id', l.id).update(CLEARED);
        }
    }

    console.log(`\n[repair] ${APPLY ? 'APPLIED' : 'DRY RUN'}: ${evicted} matches unlinked `
        + `(${scored} of them carried a score from the wrong fixture), `
        + `${groups.length} groups examined, ${undecidable} skipped as undecidable.`);
    if (!APPLY) console.log('[repair] re-run with --yes to apply.');
}

main()
    .catch(e => { console.error('[repair] failed:', e); process.exitCode = 1; })
    .finally(closeDb);
