// Backfill the CURRENT algorithm over past days (owner 2026-10-16: "backfill
// everything so I can walk into past days and see the new algo's accuracy";
// sole consumer of the output). Recomputes ONLY derived rows:
//   - fixture_predictions.tip_banker_market/_price/_prob/_cal (the Pick),
//     tip_banker_outcome reset and re-graded by the normal settle pass;
//   - daily_slips rows (Top picks + daily slip + stats shadow), backfilled=1,
//     settled by the normal settle pass.
// Real data (fixtures, matches, odds, stats, prematch, the stats tip) is
// never written. Hindsight-free: day D's Pick calibrator observes only final
// fixtures of the 90 days strictly before D (the live window), and every menu
// is built from prices last written BEFORE kickoff. The selection itself is
// the live builder's composeCard/cardLegs, so a backfilled day is chosen
// exactly as a live day would be (prices differ: live uses the morning price,
// the backfill the last pre-kickoff price - hence the backfilled label).
//
// Usage:
//   node scripts/backfill-algo.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] --dry-run
//   node scripts/backfill-algo.js [--from ...] [--to ...] --yes
//   node scripts/backfill-algo.js --restore tmp/backfill-algo-<stamp>.json --yes
// Default range: 2026-07-16 (14 days after the first odds) .. yesterday EAT.
// Every real run first writes tmp/backfill-algo-<stamp>.json (the rows it is
// about to change); --restore puts them back exactly.
import fs from 'node:fs';
import { db, closeDb } from '../src/db/connection.js';
import { config } from '../src/config.js';
import { loadSettledWindow, composeCard, cardLegs, _sotHistory, settleDailySlips, ALGO_VERSION } from '../src/daily-slip.js';
import { settleHotPicks } from '../src/hotpicks.js';
import { makePickCalibrator, fixturePick } from '../src/db/pick-rules.js';
import { tipOutcome } from '../src/db/tip-rules.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const WINDOW_DAYS = 90;
const FP_COLS = ['tip_banker_market', 'tip_banker_price', 'tip_banker_prob', 'tip_banker_cal', 'tip_banker_outcome'];
const SLIP_COLS = ['slip_date', 'status', 'mood', 'legs', 'combined_odds', 'legs_total', 'legs_hit', 'outcome',
    'algo_version', 'backfilled', 'computed_at', 'settled_at', 'cards_total', 'cards_won'];

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

async function restore(file) {
    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(`[backfill-algo] restore ${file}: ${snap.fp.length} prediction rows, ${snap.slips.length} slip rows, range ${snap.from}..${snap.to}`);
    if (!flag('--yes')) { console.log('dry run (add --yes to write)'); return; }
    await db.transaction(async trx => {
        for (const r of snap.fp) await trx('fixture_predictions').where('fixture_id', r.fixture_id).update(Object.fromEntries(FP_COLS.map(c => [c, r[c]])));
        await trx('daily_slips').whereBetween('slip_date', [snap.from, snap.to]).del();
        if (snap.slips.length) await trx('daily_slips').insert(snap.slips.map(r => ({ ...r, legs: typeof r.legs === 'string' ? r.legs : JSON.stringify(r.legs) })));
    });
    console.log('[backfill-algo] restored');
}

async function main() {
    if (val('--restore')) return restore(val('--restore'));
    const dry = flag('--dry-run');
    if (!dry && !flag('--yes')) throw new Error('refusing to write without --yes (or use --dry-run)');
    const [{ today }] = (await db.raw("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today"))[0];
    const from = val('--from') ?? '2026-07-16';
    const to = val('--to') ?? addDays(today, -1);
    if (!(from <= to) || to >= today) throw new Error(`bad range ${from}..${to} (must end before today ${today})`);
    console.log(`[backfill-algo] db ${config.DB_HOST}:${config.DB_PORT}/${config.DB_DATABASE}  range ${from}..${to}  ${dry ? 'DRY RUN' : 'WRITE'}  algo ${ALGO_VERSION}`);

    // 1. Settled fixtures + pre-kickoff menus for the calibration window and the range.
    const t0 = Date.now();
    const { fixtures, preMenus } = await loadSettledWindow(addDays(to, 1), daysBetween(addDays(from, -WINDOW_DAYS), addDays(to, 1)));
    console.log(`[backfill-algo] loaded ${fixtures.length} settled fixtures with menus in ${Math.round((Date.now() - t0) / 1000)}s`);
    const byDay = new Map();
    for (const f of fixtures) { let a = byDay.get(f.day); if (!a) byDay.set(f.day, a = []); a.push(f); }

    // 2. The live universe: fixtures the sweep scored (a fixture_predictions
    //    row, which hotpicks writes only for games with a pre-match snapshot).
    const universe = await db('fixture_predictions as fp').join('fixtures as f', 'f.id', 'fp.fixture_id')
        .whereRaw('DATE(f.kickoff) BETWEEN ? AND ?', [from, to])
        .select('fp.fixture_id', 'f.home_team_id', 'f.away_team_id', db.raw("DATE_FORMAT(f.kickoff, '%Y-%m-%d') as day"),
            ...FP_COLS.map(c => `fp.${c}`));
    const teamsById = new Map(universe.map(r => [r.fixture_id, r]));
    const universeByDay = new Map();
    for (const u of universe) { let a = universeByDay.get(u.day); if (!a) universeByDay.set(u.day, a = []); a.push(u); }
    const sot = await _sotHistory([...new Set(universe.flatMap(r => [r.home_team_id, r.away_team_id]))]);

    // 3. Backup before any write.
    const slipsBefore = await db('daily_slips').whereBetween('slip_date', [from, to])
        .select(...SLIP_COLS.filter(c => c !== 'slip_date'), db.raw("DATE_FORMAT(slip_date, '%Y-%m-%d') as slip_date"));
    let backupFile = null;
    if (!dry) {
        const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
        backupFile = `tmp/backfill-algo-${stamp}.json`;
        fs.mkdirSync('tmp', { recursive: true });
        fs.writeFileSync(backupFile, JSON.stringify({ from, to, fp: universe.map(r => Object.fromEntries(['fixture_id', ...FP_COLS].map(c => [c, r[c]]))), slips: slipsBefore }));
        console.log(`[backfill-algo] backup ${backupFile}: ${universe.length} prediction rows, ${slipsBefore.length} slip rows`);
    }

    // 4. Walk forward: day D sees cells from [D - 90, D - 1] only.
    const cells = new Map();          // running window: cell -> { n, r }
    const dayCells = new Map();       // day -> Map(cell -> { n, r }) for window removal
    const observeDay = (day, sign) => {
        let dc = dayCells.get(day);
        if (!dc) {
            const cal = makePickCalibrator({ shrinkK: 300 });
            for (const f of byDay.get(day) ?? []) {
                for (const leg of preMenus.get(f.id) ?? []) {
                    let outcome = null;
                    try { outcome = tipOutcome(leg.market, f.ft_home, f.ft_away); } catch { continue; }
                    cal.observe({ ...leg, outcome });
                }
            }
            dc = new Map(Object.entries(cal.export().cells));
            dayCells.set(day, dc);
        }
        for (const [k, c] of dc) {
            const cur = cells.get(k) ?? { n: 0, r: 0 };
            cur.n += sign * c.n; cur.r += sign * c.r;
            if (cur.n <= 0) cells.delete(k); else cells.set(k, cur);
        }
    };
    for (let d = addDays(from, -WINDOW_DAYS); d < from; d = addDays(d, 1)) observeDay(d, +1);

    const stats = { days: 0, picks: 0, slips: 0, shadow: 0 };
    for (let d = from; d <= to; d = addDays(d, 1)) {
        const cal = makePickCalibrator({ cells: Object.fromEntries(cells) });
        const games = [];
        const fpUpdates = [];
        for (const f of byDay.get(d) ?? []) {
            const u = teamsById.get(f.id);
            if (!u) continue;   // not in the live universe
            const pick = fixturePick(preMenus.get(f.id) ?? [], cal);
            fpUpdates.push({ fixture_id: f.id, pick });
            // Live builds cards only from games that carry a Pick (its
            // targets require tip_banker_cal), so the backfill does too.
            if (pick) games.push({
                id: f.id, kickoff: new Date(f.kickoff).toISOString(), pick,
                f: { home_name: f.home_name, away_name: f.away_name, league: f.league, home_team_id: u.home_team_id, away_team_id: u.away_team_id },
            });
        }
        // Universe fixtures of the day without a settled pre-kickoff menu
        // (no final score, no odds) get their old Banker cleared: no Pick
        // could have been made for them.
        const done = new Set(fpUpdates.map(x => x.fixture_id));
        for (const u of universeByDay.get(d) ?? []) if (!done.has(u.fixture_id)) fpUpdates.push({ fixture_id: u.fixture_id, pick: null });
        const card = composeCard({ games, menus: preMenus, pickCal: cal, sot });
        const legs = cardLegs(card).map(l => ({ ...l, backfilled: true }));
        const shown = legs.filter(l => l.kind !== 'shadow');
        stats.days++; stats.picks += fpUpdates.filter(x => x.pick).length;
        stats.slips += card.slip ? 1 : 0; stats.shadow += legs.length - shown.length;
        if (!dry) {
            await db.transaction(async trx => {
                for (const { fixture_id, pick } of fpUpdates) {
                    await trx('fixture_predictions').where('fixture_id', fixture_id).update({
                        tip_banker_market: pick?.market ?? null, tip_banker_price: pick?.price ?? null,
                        tip_banker_prob: pick?.prob ?? null, tip_banker_cal: pick?.calProb ?? null, tip_banker_outcome: null,
                    });
                }
                const row = {
                    slip_date: d,
                    status: shown.length ? 'published' : 'no_slip',
                    mood: card.top.length >= 3 && card.slip ? 'green' : shown.length ? 'amber' : 'red',
                    legs: JSON.stringify(shown.length ? legs : []),
                    combined_odds: card.slip ? card.slip.odds : null,
                    legs_total: shown.length, legs_hit: null, outcome: null,
                    algo_version: ALGO_VERSION, backfilled: true,
                    computed_at: db.fn.now(), settled_at: null,
                    cards_total: card.top.length + (card.slip ? 1 : 0), cards_won: null,
                };
                await trx('daily_slips').insert(row).onConflict('slip_date').merge(Object.keys(row).filter(k => k !== 'slip_date'));
            });
        }
        observeDay(d, +1);
        observeDay(addDays(d, -WINDOW_DAYS), -1);
    }
    console.log(`[backfill-algo] ${stats.days} days, ${stats.picks} picks, ${stats.slips} slips, ${stats.shadow} shadow legs ${dry ? '(dry run, nothing written)' : 'written'}`);
    if (dry) return;

    // 5. Grade through the normal settle passes.
    const s1 = await settleHotPicks();
    const s2 = await settleDailySlips();
    console.log(`[backfill-algo] settled: picks ${s1.bankers_settled}, slips ${s2.settled}`);

    // 6. Report.
    const rows = await db('daily_slips').whereBetween('slip_date', [from, to]).where('status', 'published').select('legs', 'outcome');
    let slipWon = 0, slipLost = 0, pickHit = 0, pickMiss = 0, shHit = 0, shMiss = 0, units = 0;
    for (const r of rows) {
        const L = typeof r.legs === 'string' ? JSON.parse(r.legs) : r.legs;
        const sl = L.filter(l => l.kind === 'slip');
        if (sl.length) {
            if (sl.every(l => l.outcome === 'hit')) { slipWon++; units += Number(sl[0].slip_odds) - 1; }
            else if (sl.some(l => l.outcome === 'miss')) { slipLost++; units -= 1; }
        }
        for (const l of L) {
            if (l.kind === 'pick') { if (l.outcome === 'hit') pickHit++; else if (l.outcome === 'miss') pickMiss++; }
            if (l.kind === 'shadow') { if (l.outcome === 'hit') shHit++; else if (l.outcome === 'miss') shMiss++; }
        }
    }
    const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '-');
    console.log(`[backfill-algo] daily slip: won ${slipWon} / lost ${slipLost} (${pct(slipWon, slipWon + slipLost)}), ${units >= 0 ? '+' : ''}${units.toFixed(2)}u at 1u a day`);
    console.log(`[backfill-algo] top picks: ${pickHit} won / ${pickMiss} lost (${pct(pickHit, pickHit + pickMiss)})`);
    console.log(`[backfill-algo] shadow:    ${shHit} won / ${shMiss} lost (${pct(shHit, shHit + shMiss)})`);
    console.log(`[backfill-algo] undo: node scripts/backfill-algo.js --restore ${backupFile} --yes`);
}

main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => closeDb());
