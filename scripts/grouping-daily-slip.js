#!/usr/bin/env node
// Multi-card day groupings (owner directive 2026-08-06: "a day can have
// multiple multi bets so various groupings can be tried to increase
// survivability"). Deterministic walk-forward replay under the baked v1.2
// selection (floor 0.95, streak-first); only the day-level GROUPING of the
// ranked pool varies. Metrics: any-green (>=1 card wins - the survivability
// a multi-card day buys), all-green (strict), flat P&L per STAKED UNIT
// (1u per card - more cards = more stakes, the honesty term).
//
// Usage: node scripts/grouping-daily-slip.js --db oddspro
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { makeCalibrator } from '../src/db/leg-calibration.js';
import { DEFAULT_DAILY_SLIP, selectDailyLegs } from '../src/db/daily-slip-rules.js';

// Groupings over the ranked qualifying pool. `interleave` deals ranks round-
// robin (balanced cards); `tiered` cuts contiguous rank blocks (a safest card
// and a riskier card). Cards under 2 legs are not formed.
const GROUPINGS = [
    { id: 'single-5 (incumbent)', take: 5, cards: 1, mode: 'interleave' },
    { id: 'split-2x2 (top 4)', take: 4, cards: 2, mode: 'interleave' },
    { id: 'split-2x3 (top 6)', take: 6, cards: 2, mode: 'interleave' },
    { id: 'tiered-3+3 (top 6)', take: 6, cards: 2, mode: 'tiered' },
    { id: 'split-3x2 (top 6)', take: 6, cards: 3, mode: 'interleave' },
    { id: 'tiered-2+2+2', take: 6, cards: 3, mode: 'tiered' },
];

const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[grouping] loading...');
const raw = await load();
const ix = index(raw);
const fxById = new Map(raw.fixtures.map(f => [f.id, f]));
const derived = [];
for (const f of raw.fixtures) { const d = derive(f, ix, cfg, null); if (d) derived.push(d); }
for (const d of derived) {
    const f = fxById.get(d.id);
    const rows = ix.oddsBy.get(d.id) ?? [];
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    d.menuLegs = Object.entries(marketMenu(books)).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        return { market, price: l.price, prob: l.prob, outcome, league: d.league ?? null, day: d.day };
    }).filter(l => Number(l.price) > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
}
const byDay = new Map();
for (const d of derived) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
const days = [...byDay.keys()].sort();
console.error(`[grouping] ${derived.length} fixtures over ${days.length} days (v1.2 selection, decay on)`);

// One walk-forward pass produces each day's RANKED pool once; groupings then
// slice it. Outcome lookup by fixture|market.
const cal = makeCalibrator({ halfLifeDays: 30 });
const perDayPools = [];
for (const day of days) {
    const rows = byDay.get(day) ?? [];
    const fixtures = rows.map(r => ({ id: r.id, league: r.league, menuLegs: r.menuLegs }));
    const outcomeOf = new Map();
    for (const r of rows) for (const l of r.menuLegs) outcomeOf.set(`${r.id}|${l.market}`, l.outcome);
    const pool = selectDailyLegs(fixtures, cal, { ...DEFAULT_DAILY_SLIP, maxLegs: 0 })
        .map(l => ({ ...l, outcome: outcomeOf.get(`${l.id}|${l.market}`) ?? null }))
        .filter(l => l.outcome === 'hit' || l.outcome === 'miss');
    perDayPools.push({ day, pool });
    for (const r of rows) for (const l of r.menuLegs) cal.observe(l);
}

function formCards(pool, g) {
    const taken = pool.slice(0, g.take);
    if (taken.length < 2) return [];
    const k = Math.min(g.cards, Math.floor(taken.length / 2));
    if (k < 1) return [];
    const cards = Array.from({ length: k }, () => []);
    if (g.mode === 'tiered') {
        const size = Math.ceil(taken.length / k);
        taken.forEach((l, i) => cards[Math.min(k - 1, Math.floor(i / size))].push(l));
    } else {
        taken.forEach((l, i) => cards[i % k].push(l));
    }
    return cards.filter(c => c.length >= 2);
}

console.log(`\n=== DAY GROUPINGS  (${days.length} days; v1.2 selection; 1u staked per card)`);
console.log('grouping              | days  anyGreen    allGreen    anyStk  P&L/unit  cards/day  odds/card');
for (const g of GROUPINGS) {
    let played = 0, any = 0, all = 0, staked = 0, ret = 0, anyBest = 0, anyCur = 0;
    let cardCount = 0, oddsSum = 0;
    for (const { pool } of perDayPools) {
        const cards = formCards(pool, g);
        if (!cards.length) continue;
        played++;
        cardCount += cards.length;
        let dayAny = false, dayAll = true;
        for (const c of cards) {
            const product = c.reduce((p, l) => p * l.price, 1);
            oddsSum += product;
            staked += 1;
            const green = c.every(l => l.outcome === 'hit');
            if (green) { ret += product; dayAny = true; } else dayAll = false;
        }
        if (dayAny) { any++; anyCur++; if (anyCur > anyBest) anyBest = anyCur; } else anyCur = 0;
        if (dayAll) all++;
    }
    const pnl = ret - staked;
    console.log(`${g.id.padEnd(21)} |  ${String(played).padStart(3)}   ${String(any).padStart(3)} ${(100 * any / played).toFixed(1).padStart(5)}%   ${String(all).padStart(3)} ${(100 * all / played).toFixed(1).padStart(5)}%   ${String(anyBest).padStart(4)}   ${(pnl / staked >= 0 ? '+' : '')}${(100 * pnl / staked).toFixed(1).padStart(5)}%   ${(cardCount / played).toFixed(1).padStart(6)}   ${(oddsSum / cardCount).toFixed(2).padStart(6)}x`);
}
await db.destroy();
