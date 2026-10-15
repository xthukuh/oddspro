// Backfill the Sharp 4x card onto past daily_slips rows, walk-forward.
//
// For each day D in the range: the calibrator observes ONLY final fixtures
// whose EAT day is in [D - 90, D) (results before D), and D's candidates are
// D's fixtures at their last BetPawa price written before kickoff. D's
// results are read only by the normal settle pass AFTER the card is stored.
// Two honest gaps versus a live call, both stated in the UI chip: the price
// is the last pre-kickoff price (a live build sees the morning price), and
// the candidate pool is fixtures that went on to finish (a postponed game
// would have voided anyway).
//
// Writes: appends one card (kind 'sharp', every leg backfilled: true) to the
// day's EXISTING row, bumps legs_total / cards_total, then runs
// settleDailySlips() to grade the new legs and recompute cards_won. The live
// cards, the day verdict and settled_at are never touched. A day that
// already carries a Sharp card is skipped (idempotent). Before writing, the
// original rows are saved to tmp/backfill-sharp-<stamp>.json;
// --restore <file> writes them back verbatim.
//
// Usage: node scripts/backfill-sharp.js [--days 14] [--to YYYY-MM-DD] [--yes]
//        node scripts/backfill-sharp.js --restore tmp/backfill-sharp-<stamp>.json --yes
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { loadSettledWindow, loadSharpCalibrator, sharpLegRecords, settleDailySlips } from '../src/daily-slip.js';
import { selectSharpCard } from '../src/db/sharp-rules.js';
import { contradicts } from '../src/db/ladder-rules.js';
import { fetchBetpawaBonusConfig } from '../src/betpawa-bonus.js';
import { BETPAWA_KE_BONUS } from '../src/db/betpawa-bonus-rules.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const YES = process.argv.includes('--yes');
const RESTORE = arg('restore', null);
const WINDOW = 90;

const dayAdd = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

async function restore(file) {
    const rows = JSON.parse(readFileSync(file, 'utf8'));
    console.log(`restore: ${rows.length} rows from ${file}${YES ? '' : ' (dry run, add --yes)'}`);
    if (!YES) return;
    for (const r of rows) {
        await db('daily_slips').where('id', r.id).update({
            legs: r.legs, legs_total: r.legs_total, cards_total: r.cards_total, cards_won: r.cards_won, legs_hit: r.legs_hit,
        });
    }
    console.log('restored');
}

async function backfill() {
    const [{ today }] = (await db.raw("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today"))[0];
    const to = arg('to', dayAdd(today, -1));
    const days = Number(arg('days', 14));
    const from = dayAdd(to, -(days - 1));
    const rows = await db('daily_slips')
        .whereRaw('slip_date BETWEEN ? AND ?', [from, to])
        .select('id', db.raw("DATE_FORMAT(slip_date, '%Y-%m-%d') as day"), 'legs', 'legs_total', 'cards_total', 'cards_won', 'legs_hit');
    const byDay = new Map(rows.map(r => [r.day, r]));
    console.log(`range ${from}..${to}: ${rows.length} existing rows${YES ? '' : ' (dry run, add --yes to write)'}`);

    // One settled window covering every training span and every target day.
    const window = await loadSettledWindow(dayAdd(to, 1), WINDOW + days);
    const bonusCfg = (await fetchBetpawaBonusConfig()) ?? BETPAWA_KE_BONUS;
    const plan = [];
    for (let d = from; d <= to; d = dayAdd(d, 1)) {
        const row = byDay.get(d);
        if (!row) { console.log(`${d}  no daily_slips row - skipped`); continue; }
        const legs = typeof row.legs === 'string' ? JSON.parse(row.legs) : (row.legs ?? []);
        if (legs.some(l => l.kind === 'sharp')) { console.log(`${d}  already has a Sharp card - skipped`); continue; }
        const lo = dayAdd(d, -WINDOW);
        const train = window.fixtures.filter(f => f.day < d && f.day >= lo);
        const cal = await loadSharpCalibrator(d, WINDOW, { fixtures: train, sharp: window.sharp });
        const target = window.fixtures.filter(f => f.day === d);
        const taken = new Map();
        for (const l of legs) { const a = taken.get(l.fixture_id) ?? []; a.push(l.market); taken.set(l.fixture_id, a); }
        const card = selectSharpCard(target.map(f => ({
            id: f.id,
            legs: (window.sharp.get(f.id) ?? []).filter(l => !(taken.get(f.id) ?? []).some(m => contradicts(m, l.market))),
        })), cal, {}, bonusCfg);
        if (!card) { console.log(`${d}  no Sharp card reachable`); continue; }
        const fxInfo = new Map(target.map(f => [f.id, { home_name: f.home_name, away_name: f.away_name, league: f.league, kickoff: f.kickoff }]));
        const cardIndex = Math.max(-1, ...legs.map(l => l.card ?? 0)) + 1;
        const add = sharpLegRecords(card, cal, fxInfo, cardIndex, { backfilled: true });
        plan.push({ row, legs, add });
        console.log(`${d}  ${card.slipOdds.toFixed(2)}x -> ${card.totalOdds.toFixed(2)}x  | `
            + add.map(l => `${l.home} v ${l.away} [${l.label} @${l.price}]`).join(' | '));
    }
    if (!YES || !plan.length) return;

    mkdirSync('tmp', { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const backup = `tmp/backfill-sharp-${stamp}.json`;
    writeFileSync(backup, JSON.stringify(plan.map(p => p.row), null, 1));
    console.log(`backup of ${plan.length} original rows: ${backup}`);
    for (const p of plan) {
        const legs = [...p.legs, ...p.add];
        await db('daily_slips').where('id', p.row.id).update({
            legs: JSON.stringify(legs), legs_total: legs.length, cards_total: (p.row.cards_total ?? 0) + 1,
        });
    }
    const s = await settleDailySlips();
    console.log(`written ${plan.length} rows; settle pass: ${JSON.stringify(s)}`);
    const after = await db('daily_slips').whereIn('id', plan.map(p => p.row.id))
        .select(db.raw("DATE_FORMAT(slip_date, '%Y-%m-%d') as day"), 'legs');
    let won = 0, settled = 0;
    for (const r of after) {
        const sl = JSON.parse(r.legs).filter(l => l.kind === 'sharp');
        const done = sl.every(l => l.outcome != null);
        const ok = done && sl.every(l => l.outcome !== 'miss');
        if (done) settled++; if (ok) won++;
        console.log(`${r.day}  ${done ? (ok ? 'WON ' : 'LOST') : 'open'}  ${sl.map(l => `${l.label}@${l.price} ${l.score ?? ''} ${l.outcome ?? ''}`).join(' | ')}`);
    }
    console.log(`Sharp backfill: ${won}/${settled} settled cards won`);
}

try {
    if (RESTORE) await restore(RESTORE); else await backfill();
} finally {
    await closeDb();
}
