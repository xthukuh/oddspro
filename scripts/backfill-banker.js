#!/usr/bin/env node
// DEV / LOCALHOST ONLY. Populates tip_banker_* on HISTORICAL fixtures so the
// Banker column has something to render when you point a local instance at a
// restored warehouse.
//
// Production deliberately does NOT do this: updateHotPicks only writes rows for
// kickoff > NOW() (the freeze invariant, docs/engine/02-DATA-PIPELINE.md). A
// restored dump has no upcoming fixtures, so the column would be empty.
//
// It runs through the SAME pure functions the pipeline uses (buildTipBooks ->
// marketMenu -> bankerPick), so what you see is what the engine would have
// produced, not a reconstruction.
//
//   node scripts/backfill-banker.js                  # dry run, prints counts
//   node scripts/backfill-banker.js --write          # actually writes
//   node scripts/backfill-banker.js --write --db oddspro_local
//
// Refuses to run against a database whose name looks like production.
import { db, closeDb } from '../src/db/connection.js';
import { config } from '../src/config.js';
import { buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { marketMenu, bankerPick } from '../src/db/ladder-rules.js';

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const name = config.DB_DATABASE;
if (/^oddspro$/i.test(name) && process.env.ALLOW_PROD_BACKFILL !== '1') {
    console.error(`refusing to touch "${name}". This script is for a local copy.`);
    console.error('Point DB_DATABASE at a scratch database, or set ALLOW_PROD_BACKFILL=1 if you really mean it.');
    process.exit(1);
}

const fixtures = await db('fixtures as f')
    .join('fixture_predictions as p', 'p.fixture_id', 'f.id')
    .leftJoin('teams as th', 'th.id', 'f.home_team_id')
    .leftJoin('teams as ta', 'ta.id', 'f.away_team_id')
    .select('f.id', 'f.ft_home', 'f.ft_away', 'th.name as home_name', 'ta.name as away_name');

const oddsRows = await db('odds_markets as om')
    .join('matches as m', 'm.id', 'om.match_id')
    .whereNotNull('m.fixture_id').where('om.is_stale', 0)
    .select('m.fixture_id', 'm.provider', 'om.type_name', 'om.name', 'om.handicap', 'om.price');

const byFixture = new Map();
for (const r of oddsRows) {
    let l = byFixture.get(r.fixture_id);
    if (!l) byFixture.set(r.fixture_id, l = []);
    l.push(r);
}

const updates = [];
for (const f of fixtures) {
    const rows = byFixture.get(f.id);
    if (!rows?.length) continue;
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name });
    const pick = bankerPick(marketMenu(books), { bankerFloor: config.TIP_BANKER_FLOOR });
    if (!pick) continue;
    let outcome = null;
    if (f.ft_home != null && f.ft_away != null) {
        try { outcome = tipOutcome(pick.market, f.ft_home, f.ft_away); } catch { outcome = null; }
    }
    updates.push({ id: f.id, market: pick.market, price: pick.price, prob: pick.prob, outcome });
}

console.log(`database        ${name}`);
console.log(`fixtures        ${fixtures.length}`);
console.log(`bankers found   ${updates.length}`);
console.log(`settleable      ${updates.filter(u => u.outcome).length}`);

if (!WRITE) {
    console.log('\ndry run. re-run with --write to persist.');
} else {
    let n = 0;
    for (const u of updates) {
        await db('fixture_predictions').where('fixture_id', u.id).update({
            tip_banker_market: u.market, tip_banker_price: u.price,
            tip_banker_prob: u.prob, tip_banker_outcome: u.outcome,
        });
        if (++n % 500 === 0) process.stdout.write('.');
    }
    console.log(`\nwrote ${n} rows.`);
}
await closeDb();
