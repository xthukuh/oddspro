#!/usr/bin/env node
// Daily MultiBet simulation grid + hindsight-free backfill (engine-v2 final
// touches, plan Task 7). Replays the banker-style UNCAPPED construction
// (src/db/daily-slip-rules.js) over real historical days with the replay
// showcase's information discipline: pre-kickoff odds only (simulate.js
// load/derive), walk-forward calibration observing STRICTLY prior days,
// settled hit/miss menu legs only (a leg that cannot be graded cannot be
// simulated). Deterministic end to end - no RNG, so the grid cannot be
// re-rolled until it looks good.
//
// Usage:
//   node scripts/simulate-daily-slip.js --db oddspro            # grid report
//   node scripts/simulate-daily-slip.js --db oddspro --json tmp/grid.json
//   node scripts/simulate-daily-slip.js --write-daily --yes     # backfill the
//     daily_slips timeline (walk-forward, backfilled=1) with the CURRENT
//     baked DEFAULT_DAILY_SLIP. Deliberately targets the configured DB: the
//     timeline lives in production; --yes required.
//
// Winner rule (disclosed a priori): among parameter cells that PUBLISH on at
// least 2/3 of eligible days (a daily product that rarely publishes is not a
// daily product), rank by green-day rate, then best streak, then flat P&L.
import 'dotenv/config';   // BEFORE simulate.js - it reads process.env at import time
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { makeCalibrator } from '../src/db/leg-calibration.js';
import { DEFAULT_DAILY_SLIP, DEFAULT_GROUPING, DEFAULT_VALUE_CARDS, selectDailyLegs, groupCards, valueCards, dayMood, slipOutcomeRollup } from '../src/db/daily-slip-rules.js';
import { tipMarketLabel } from '../src/db/magic-rules.js';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WRITE_DAILY = flag('write-daily');
if (WRITE_DAILY && !flag('yes')) {
    console.error('refusing --write-daily without --yes (writes the production daily_slips timeline).');
    process.exit(1);
}

// The grid, round 2 (disclosed): round 1 (floors 0.88-0.96, no depth cap)
// showed unlimited depth collapses survival (floor 0.90 = 11% green at 55+
// legs; floor 0.96 = 60% at ~19) and that maxLegPrice is inert below the
// floor region (a 0.96-floor leg is never priced 1.6). Round 2 adds the
// maxLegs depth cap (the replay's top-10 banker construction) and drops the
// inert price axis. Every cell is reported.
// Round 8 (owner order 2026-08-06: cap safe legs at MIN price 1.2 - no more
// 1.01 junk on the safety cards). The 0.95 floor is IMPOSSIBLE at 1.2+
// prices (round-3 finding: no calibrated 94%+ above 1.08), so the floor and
// ranking axes reopen to find the best safe construction in the new price
// regime. Production calibrator (decay 30) throughout; split-2x2 grouping.
const GRID = {
    probFloor: [0.75, 0.78, 0.80, 0.82, 0.85, 0.88],
    rankBy: ['streak', 'prob', 'eff'],
};
const PINNED = { minLegPrice: 1.2, maxLegPrice: 1.35 };

const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[dailyslip-sim] loading...');
const raw = await load();
const ix = index(raw);
const fxById = new Map(raw.fixtures.map(f => [f.id, f]));
const derived = [];
for (const f of raw.fixtures) { const d = derive(f, ix, cfg, null); if (d) derived.push(d); }

// Settled menu legs per fixture (the candidate pool AND the calibration feed;
// hit/miss only - voids and unsettled legs can neither be graded nor teach).
let menuLegCount = 0;
for (const d of derived) {
    const f = fxById.get(d.id);
    const rows = ix.oddsBy.get(d.id) ?? [];
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    d.menuLegs = Object.entries(marketMenu(books)).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        // league + day ride each leg so the v2 error-feedback calibrator
        // options (leagueK / halfLifeDays) see them; inert when both are off.
        return { market, price: l.price, prob: l.prob, outcome, league: d.league ?? null, day: d.day };
    }).filter(l => Number(l.price) > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
    menuLegCount += d.menuLegs.length;
}
const byDay = new Map();
for (const d of derived) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
const days = [...byDay.keys()].sort();
console.error(`[dailyslip-sim] ${derived.length} eligible fixtures, ${menuLegCount} settled menu legs across ${days.length} days`);

// One walk-forward pass under one parameter set. Returns per-day records and
// the summary scores.
function runParams(params, calOpts = {}) {
    const cal = makeCalibrator(calOpts);
    const perDay = [];
    for (const day of days) {
        const rows = byDay.get(day) ?? [];
        const fixtures = rows.map(r => ({ id: r.id, league: r.league, menuLegs: r.menuLegs }));
        const outcomeOf = new Map();
        for (const r of rows) for (const l of r.menuLegs) outcomeOf.set(`${r.id}|${l.market}`, l.outcome);
        const pool = selectDailyLegs(fixtures, cal, params);
        const cards = groupCards(pool, params.grouping ?? DEFAULT_GROUPING);
        const taken = cards.flat().map(l => ({ ...l, kind: 'safe' }));
        const slip = taken.length >= 2 ? {
            legs: taken, pool: pool.length, cards: cards.length,
            combinedOdds: taken.reduce((p, l) => p * l.price, 1),
            mood: dayMood(pool, params),
        } : null;
        // Value arm (v1.4, backfill parity with the live builder): eff-ranked
        // pool, target-closing cards, outcomes attached from the settled menu.
        if (params.withValue && slip) {
            const vPool = selectDailyLegs(fixtures, cal, DEFAULT_VALUE_CARDS);
            slip.vCards = valueCards(vPool, DEFAULT_VALUE_CARDS, cards.length)
                .map(c => c.map(l => ({ ...l, outcome: outcomeOf.get(`${l.id}|${l.market}`) ?? null })));
        }
        if (slip) {
            const outcomes = slip.legs.map(l => outcomeOf.get(`${l.id}|${l.market}`) ?? null);
            const roll = slipOutcomeRollup(outcomes);
            const byCard = new Map();
            slip.legs.forEach((l, i) => {
                let list = byCard.get(l.card ?? 0); if (!list) byCard.set(l.card ?? 0, list = []);
                list.push(outcomes[i]);
            });
            const cardsWon = [...byCard.values()].filter(o => o.every(x => x === 'hit')).length;
            perDay.push({ day, slip, outcomes, outcome: roll.outcome, legsHit: roll.legsHit,
                cardsWon, cardsTotal: byCard.size });
        } else {
            perDay.push({ day, slip: null });
        }
        for (const r of rows) for (const l of r.menuLegs) cal.observe(l);   // AFTER the day's card
    }
    const played = perDay.filter(p => p.slip && p.outcome != null && p.outcome !== 'void');
    const green = played.filter(p => p.outcome === 'won');
    let pnl = 0, best = 0, cur = 0;
    for (const p of played) {
        pnl += p.outcome === 'won' ? p.slip.combinedOdds - 1 : -1;
        cur = p.outcome === 'won' ? cur + 1 : 0;
        if (cur > best) best = cur;
    }
    const avgLegs = played.length ? played.reduce((s, p) => s + p.slip.legs.length, 0) / played.length : 0;
    const avgOdds = played.length ? played.reduce((s, p) => s + p.slip.combinedOdds, 0) / played.length : 0;
    return {
        params, perDay,
        played: played.length, green: green.length,
        greenRate: played.length ? green.length / played.length : 0,
        best, pnl, avgLegs, avgOdds,
        noSlipDays: perDay.filter(p => !p.slip).length,
    };
}

if (!WRITE_DAILY) {
    const results = [];
    for (const probFloor of GRID.probFloor)
        for (const rankBy of GRID.rankBy) {
            const r = runParams({ ...DEFAULT_DAILY_SLIP, ...PINNED, probFloor, rankBy }, { halfLifeDays: 30 });
            r.calOpts = { probFloor, rankBy };
            results.push(r);
        }

    const minPlayed = Math.ceil(days.length * 2 / 3);
    const eligible = results.filter(r => r.played >= minPlayed);
    const rank = (a, b) => (b.greenRate - a.greenRate) || (b.best - a.best) || (b.pnl - a.pnl);
    eligible.sort(rank);
    results.sort(rank);

    console.log(`\n=== DAILY MULTIBET GRID  (${days.length} days; publish floor ${minPlayed} days; winner rule: green rate > best streak > P&L)`);
    console.log('floor  rank    |  played  green(strict)  anyGreen   bestStk   P&L      avgLegs  avgOdds');
    for (const r of results) {
        const c = r.calOpts;
        const any = r.perDay.filter(p => p.cardsWon > 0).length;
        const star = eligible[0] === r ? '  <== WINNER' : (r.played < minPlayed ? '  (under publish floor)' : '');
        console.log(`${c.probFloor.toFixed(2)}   ${c.rankBy.padEnd(6)} |  ${String(r.played).padStart(4)}   ${String(r.green).padStart(4)} ${(100 * r.greenRate).toFixed(1).padStart(6)}%   ${String(any).padStart(3)} ${(100 * any / Math.max(1, r.played)).toFixed(1).padStart(5)}%   ${String(r.best).padStart(4)}   ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2).padStart(7)}u   ${r.avgLegs.toFixed(1).padStart(5)}   ${r.avgOdds.toFixed(2).padStart(6)}x${star}`);
    }

    const w = eligible[0];
    if (w) {
        console.log(`\nWinner: halfLifeDays ${w.calOpts.halfLifeDays}, leagueK ${w.calOpts.leagueK} (construction pinned at the baked winner)`);
        console.log(`  ${w.green}/${w.played} green = ${(100 * w.greenRate).toFixed(1)}%, best streak ${w.best}, P&L ${w.pnl >= 0 ? '+' : ''}${w.pnl.toFixed(2)}u, avg ${w.avgLegs.toFixed(1)} legs @ ${w.avgOdds.toFixed(2)}x`);
        // Mood literal suggestions: terciles of the winner's published days.
        const pub = w.perDay.filter(p => p.slip);
        const legsN = pub.map(p => p.slip.pool ?? p.slip.legs.length).sort((a, b) => a - b);   // POOL depth drives mood
        const means = pub.map(p => p.slip.legs.reduce((s, l) => s + l.calProb, 0) / p.slip.legs.length).sort((a, b) => a - b);
        const q = (arr, f) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * f))] : 0;
        console.log(`  mood tercile suggestion: green {legs: ${q(legsN, 2 / 3)}, meanProb: ${q(means, 2 / 3).toFixed(3)}}, amber {legs: ${q(legsN, 1 / 3)}, meanProb: ${q(means, 1 / 3).toFixed(3)}}`);
    } else {
        console.log('\nNo parameter cell met the publish floor - report every cell above and decide.');
    }

    const out = opt('json', null);
    if (out) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(out, JSON.stringify({ days: days.length, results: results.map(({ perDay, ...r }) => r) }, null, 1));
        console.error(`[dailyslip-sim] wrote ${out}`);
    }
}

if (WRITE_DAILY) {
    // Backfill the daily_slips timeline with the CURRENT baked defaults -
    // what ships is what gets battle-tested. Walk-forward calibration, one
    // row per historical day (today stays owned by the live builder),
    // backfilled=1, computed_at = the day's first taken-leg kickoff (the
    // honest as-of stamp: everything the slip used was known before it).
    const [[{ today }]] = await db.raw("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today");
    // Backfill with the PRODUCTION calibrator config (decay baked in v1.1) so
    // the timeline shows exactly what the live builder would have published.
    const run = runParams({ ...DEFAULT_DAILY_SLIP, withValue: true }, { halfLifeDays: 30 });
    const rows = [];
    for (const p of run.perDay) {
        if (p.day >= today) continue;
        if (!p.slip) {
            rows.push({
                slip_date: p.day, status: 'no_slip', mood: 'red', legs: '[]',
                combined_odds: null, legs_total: 0, legs_hit: null,
                cards_total: 0, cards_won: null, outcome: null,
                algo_version: `${opt('algo', 'v1')}-backfill`, backfilled: 1,
                computed_at: `${p.day} 00:00:00`, settled_at: db.fn.now(),
            });
            continue;
        }
        const _mapLeg = (l, outcome) => {
            const f = fxById.get(l.id);
            const kick = f.kickoff instanceof Date ? f.kickoff.toISOString() : f.kickoff;
            const noun = l.kind === 'value' ? 'Value pick' : 'Safest qualifying pick';
            return {
                fixture_id: l.id,
                home: f.home_name, away: f.away_name, league: l.league,
                kickoff: kick,
                market: l.market, label: tipMarketLabel(l.market),
                price: l.price, prices: {},
                prob: l.prob, cal_prob: l.calProb, cell: l.cell, cell_key: l.cellKey,
                card: l.card ?? 0, kind: l.kind ?? 'safe',
                reasoning: l.cell
                    ? `${noun}: ${tipMarketLabel(l.market)} at ${l.price.toFixed(2)}, calibrated ${(100 * l.calProb).toFixed(1)}% from ${l.cell.n} settled legs in its price/market cell (${l.cell.hit} hit).`
                    : `${noun}: ${tipMarketLabel(l.market)} at ${l.price.toFixed(2)}, book devig ${(100 * l.calProb).toFixed(1)}% (no cell evidence yet).`,
                outcome,
            };
        };
        const legs = [
            ...p.slip.legs.map((l, i) => _mapLeg(l, p.outcomes[i])),
            ...(p.slip.vCards ?? []).flat().map(l => _mapLeg(l, l.outcome)),
        ];
        const kicks = legs.map(l => l.kickoff).sort();
        // Day outcome = the SAFE arm's strict result (live-builder parity);
        // value cards score through cards_won only.
        const roll = slipOutcomeRollup(legs.filter(l => l.kind !== 'value').map(l => l.outcome));
        const byCard = new Map();
        for (const l of legs) {
            let list = byCard.get(l.card ?? 0); if (!list) byCard.set(l.card ?? 0, list = []);
            list.push(l.outcome);
        }
        rows.push({
            slip_date: p.day, status: 'published', mood: p.slip.mood,
            legs: JSON.stringify(legs),
            combined_odds: Math.round(p.slip.combinedOdds * 100) / 100,
            legs_total: legs.length,
            legs_hit: legs.filter(l => l.outcome === 'hit').length,
            outcome: roll.outcome,
            cards_total: byCard.size,
            cards_won: [...byCard.values()].filter(list => slipOutcomeRollup(list).outcome === 'won').length,
            algo_version: `${opt('algo', 'v1')}-backfill`, backfilled: 1,
            computed_at: new Date(kicks[0]), settled_at: db.fn.now(),
        });
    }
    console.error(`[dailyslip-sim] backfilling ${rows.length} daily_slips rows (walk-forward, settled)...`);
    for (let i = 0; i < rows.length; i += 100) {
        await db('daily_slips').insert(rows.slice(i, i + 100)).onConflict('slip_date')
            .merge(['status', 'mood', 'legs', 'combined_odds', 'legs_total', 'legs_hit',
                'cards_total', 'cards_won', 'outcome', 'algo_version', 'backfilled',
                'computed_at', 'settled_at']);
    }
    const green = rows.filter(r => r.outcome === 'won').length;
    const played = rows.filter(r => r.outcome === 'won' || r.outcome === 'lost').length;
    console.log(`[dailyslip-sim] backfilled ${rows.length} days: ${green}/${played} green (${played ? (100 * green / played).toFixed(1) : 0}%).`);
}

await db.destroy();
