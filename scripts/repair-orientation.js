// One-off repair for the home/away orientation flag over ALL history.
//
// The link pass re-validates a bounded recent window every run (the shared host
// punishes unbounded scans, and a fixture's sides flip around its kickoff, not
// years later). This script runs the SAME pass with no window, to stamp
// `matches.sides_swapped` on links made before the flag existed.
//
// Background: API-Football keeps home_team_id/away_team_id in its fixtures
// upsert merge list, so it can swap a fixture's sides after we linked it. The
// link stays correct, but the read layer pairs the bookmaker's team names with
// the canonical score, so those rows rendered results the wrong way round.
//
// Usage:
//   node scripts/repair-orientation.js          # dry run, prints what would change
//   node scripts/repair-orientation.js --yes    # apply
//
// Idempotent: a second run reports zero changes.

import { closeDb } from '../src/db/connection.js';
import { revalidateOrientation } from '../src/link.js';

const APPLY = process.argv.includes('--yes');

try {
    const c = await revalidateOrientation({ sinceDays: null, apply: APPLY });
    console.log(`\n[orientation] ${APPLY ? 'APPLIED' : 'DRY RUN'}: ${c.examined} links checked, `
        + `${c.swapped} marked swapped, ${c.straightened} straightened, `
        + `${c.unchanged} already correct, ${c.errors} errors.`);
    if (!APPLY && (c.swapped || c.straightened)) console.log('[orientation] re-run with --yes to apply.');
} catch (e) {
    console.error('[orientation] failed:', e);
    process.exitCode = 1;
} finally {
    await closeDb();
}
