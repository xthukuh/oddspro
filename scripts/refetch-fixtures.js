// Force-refetch specific API-Football fixtures and re-run the settle pass -
// the manual recovery tool for a fixture whose stored half-time/full-time
// pair is inconsistent (COALESCE(ft,goals) < ht on one or both sides), the
// exact shape that froze the live light pass for three days on 2026-08-16
// (fixture 1556592, ER_DATA_OUT_OF_RANGE against the UNSIGNED second-half
// columns - see src/apisports.js's settleApisportsResults comment). Most such
// fixtures turn out to be a transient API-Football data glitch that resolves
// itself on a later fetch; this script re-pulls the fixture directly and
// re-settles so a fix (if any) propagates into matches immediately, without
// waiting for the fixture to re-enter the light pass's polling window.
//
// Usage:
//   node scripts/refetch-fixtures.js --ids 1556592,1556600
//   node scripts/refetch-fixtures.js --inconsistent
//     (auto-selects every FINAL_STATUSES fixture where the stored full-time
//     score is less than the stored half-time score on either side)
import { db, closeDb } from '../src/db/connection.js';
import { FINAL_STATUSES, refetchFixtureIds, settleApisportsResults } from '../src/apisports.js';

function parseArgs(argv) {
    const out = { ids: null, inconsistent: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--ids') out.ids = argv[++i];
        else if (argv[i] === '--inconsistent') out.inconsistent = true;
    }
    return out;
}

async function inconsistentFixtureIds() {
    const finalsIn = FINAL_STATUSES.map(() => '?').join(',');
    const rows = await db.raw(
        `SELECT id FROM fixtures
         WHERE status IN (${finalsIn})
           AND (COALESCE(ft_home, goals_home) < ht_home
                OR COALESCE(ft_away, goals_away) < ht_away)`,
        FINAL_STATUSES
    );
    return rows[0].map(r => r.id);
}

async function printTable(ids, label) {
    if (!ids.length) {
        console.log(`${label}: (none)`);
        return;
    }
    const rows = await db('fixtures')
        .whereIn('id', ids)
        .select('id', 'status', 'ht_home', 'ht_away', 'ft_home', 'ft_away', 'goals_home', 'goals_away')
        .orderBy('id');
    console.log(`${label}:`);
    console.log('id'.padEnd(10) + 'status'.padEnd(8) + 'ht_home'.padEnd(9) + 'ht_away'.padEnd(9)
        + 'ft_home'.padEnd(9) + 'ft_away'.padEnd(9) + 'goals_home'.padEnd(12) + 'goals_away');
    for (const r of rows) {
        console.log(
            String(r.id).padEnd(10) + String(r.status).padEnd(8)
            + String(r.ht_home).padEnd(9) + String(r.ht_away).padEnd(9)
            + String(r.ft_home).padEnd(9) + String(r.ft_away).padEnd(9)
            + String(r.goals_home).padEnd(12) + String(r.goals_away)
        );
    }
    return rows;
}

try {
    const args = parseArgs(process.argv.slice(2));
    let ids = null;
    if (args.ids) {
        ids = args.ids.split(',').map(s => s.trim()).filter(Boolean).map(Number);
    } else if (args.inconsistent) {
        ids = await inconsistentFixtureIds();
    } else {
        console.error('Usage: node scripts/refetch-fixtures.js --ids a,b,c | --inconsistent');
        process.exitCode = 1;
    }

    if (ids && !ids.length) {
        console.log('No fixture ids to refetch.');
    } else if (ids) {
        console.log(`Refetching ${ids.length} fixture(s): ${ids.join(',')}`);
        const before = await printTable(ids, 'BEFORE');

        const { requested, saved } = await refetchFixtureIds(ids);
        console.log(`\napi-football: requested ${requested}, saved ${saved} fixture row(s).`);

        const settleResult = await settleApisportsResults();
        console.log(`settle: ${settleResult.settled} match(es) updated, ${settleResult.fallback_completed} fallback-completed.`);

        console.log();
        const after = await printTable(ids, 'AFTER');

        const beforeById = new Map(before.map(r => [r.id, r]));
        const changed = [];
        for (const r of after) {
            const b = beforeById.get(r.id);
            const same = b && ['status', 'ht_home', 'ht_away', 'ft_home', 'ft_away', 'goals_home', 'goals_away']
                .every(k => b[k] === r[k]);
            if (!same) changed.push(r.id);
        }
        console.log(`\nChanged: ${changed.length ? changed.join(',') : '(none)'}`);
        console.log(`Still inconsistent: ${(await inconsistentFixtureIds()).filter(id => ids.includes(id)).join(',') || '(none)'}`);
    }
} finally {
    await closeDb();
}
process.exit(process.exitCode ?? 0);
