// Read-only verification of the Sharp 4x card against a real warehouse.
// Builds the day's slip with buildDailySlip({ dryRun: true }) - the row is
// returned, never written - and prints the Sharp card. Before building, it
// proves the session cannot write: it reads @@tx_read_only and attempts a
// zero-row UPDATE that a read-only session must refuse.
//
// Usage: node scripts/sharp-dryrun.js [YYYY-MM-DD] [--require-read-only]
import { db, closeDb } from '../src/db/connection.js';
import { buildDailySlip } from '../src/daily-slip.js';

const date = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? null;
const requireRO = process.argv.includes('--require-read-only');

try {
    const [[ro]] = await db.raw('SELECT @@tx_read_only AS ro');
    let refused = null;
    try { await db.raw('UPDATE daily_slips SET id = id WHERE 1 = 0'); refused = false; } catch (e) { refused = e.code ?? e.message; }
    console.log(JSON.stringify({ tx_read_only: ro.ro, writeRefused: refused }));
    if (requireRO && (ro.ro !== 1 || !refused)) throw new Error('session is NOT read-only - refusing to continue');

    const t0 = Date.now();
    const r = await buildDailySlip(date, { dryRun: true });
    const legs = JSON.parse(r.row?.legs ?? '[]');
    const sharp = legs.filter(l => l.kind === 'sharp');
    console.log(JSON.stringify({
        date: r.date, status: r.row?.status, cards: r.row?.cards_total, legs: legs.length,
        kinds: legs.reduce((a, l) => ({ ...a, [l.kind]: (a[l.kind] ?? 0) + 1 }), {}),
        secs: (Date.now() - t0) / 1000,
        maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    }));
    for (const l of sharp) {
        console.log(`  ${l.home} v ${l.away} | ${l.label} @ ${l.price} | BetPawa ${(100 * l.book_prob).toFixed(1)}% -> ours ${(100 * l.cal_prob).toFixed(1)}% | kickoff ${l.kickoff}`);
    }
    if (sharp.length) console.log(`  slip ${sharp[0].slip_odds}x -> ${sharp[0].bonus_odds}x with Win Bonus (${(100 * sharp[0].bonus_pct).toFixed(0)}% bonus)`);
    else console.log('  no Sharp card for this date');
} finally {
    await closeDb();
}
