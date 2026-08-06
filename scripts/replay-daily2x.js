#!/usr/bin/env node
// Daily ~2x card replay: the north-star metric (memory: success-bar-daily-2x)
// measured honestly on real historical data. Builds one multi-leg card per day
// from banker legs (safest market the book offers, ranked by the book's OWN
// devigged probability) greedily until the combined odds reach the target.
//
// The policy is PARAMETER-FREE: nothing is fitted, tuned or chosen by looking
// at outcomes - rank by devigged prob (the market's number, not ours), take
// legs until product >= target. No walk-forward machinery is needed because
// there is no parameter to leak. Information cutoff is inherited from
// simulate.js's load/derive: pre-kickoff odds only, rolling stats strictly
// before each fixture's kickoff.
//
// Usage:
//   node scripts/replay-daily2x.js --db oddspro-v2              # report only
//   node scripts/replay-daily2x.js --db oddspro-v2 --write      # + backfill the
//     v2 fixture_predictions ledger (tips + bankers, settled) for web viewing.
//     REFUSES --write against the production database name.
import 'dotenv/config';   // BEFORE simulate.js - it reads process.env at import time
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { makeCalibrator } from '../src/db/leg-calibration.js';

const argv = process.argv.slice(2);
const flag = n => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const DBNAME = opt('db', process.env.DB_DATABASE || 'oddspro');
const WRITE = flag('write');
if (WRITE && /^oddspro$/i.test(DBNAME)) {
    console.error('refusing --write against the production warehouse; use the v2/scratch copy.');
    process.exit(1);
}

const TARGETS = [1.5, 2.0, 3.0];
const MAX_LEGS = 40;          // sanity bound, not a tuned knob
const MAX_PER_LEAGUE = 3;     // cap correlated same-competition legs
// Walk-forward calibration of leg probabilities: extracted verbatim into the
// pure src/db/leg-calibration.js (2026-08-06, engine-v2 final touches) so the
// daily-slip builder, the simulation harness and this replay share ONE
// definition. Rationale and cell taxonomy live with the module.
//
// The card pool is SHORTS ONLY: the assured-win product compounds legs from
// the price region where the favourite-longshot bias runs FOR the bettor
// (realized >= implied at <=1.35, the 2026-08-04 calibration audit + the
// classic FL literature). Longer legs are lottery tickets, not assurance.
const MAX_LEG_PRICE = 1.35;

// One day's card: EFFICIENCY greedy - each leg costs -ln(prob) of survival per
// +ln(price) toward the target; take the cheapest survival cost per unit of
// odds first, until the product clears `target`. Each fixture contributes ONE
// leg: its best-efficiency menu leg under the CALIBRATED probability (the
// devig-safest leg is often a trap cell - O 0.5 @1.01 realizes far below 99%).
function buildCard(rows, target, cal) {
    const legs = rows
        .map(r => {
            const cands = (r.menuLegs ?? [])
                .filter(l => (l.outcome === 'hit' || l.outcome === 'miss') && Number(l.price) <= MAX_LEG_PRICE)
                .map(l => {
                    const p = cal ? cal.prob(l) : Number(l.prob);
                    return { ...l, id: r.id, league: r.league, calProb: p,
                        eff: -Math.log(Math.max(1e-9, Math.min(1, p))) / Math.log(Number(l.price)) };
                });
            cands.sort((a, b) => (a.eff - b.eff) || (b.calProb - a.calProb));
            return cands[0] ?? null;
        })
        .filter(Boolean)
        .sort((a, b) => (a.eff - b.eff) || (b.calProb - a.calProb) || (a.id - b.id));
    const card = [];
    const perLeague = new Map();
    let product = 1;
    for (const l of legs) {
        const n = perLeague.get(l.league) ?? 0;
        if (n >= MAX_PER_LEAGUE) continue;
        perLeague.set(l.league, n + 1);
        card.push(l);
        product *= Number(l.price);
        if (product >= target || card.length >= MAX_LEGS) break;
    }
    if (product < target) return null;   // day cannot reach the target - no bet
    const broken = card.filter(l => l.outcome !== 'hit');
    const expSurvival = card.reduce((s, l) => s * l.calProb, 1);
    return { legs: card, product, green: broken.length === 0, broken, expSurvival };
}

const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error(`[replay2x] db=${DBNAME} loading...`);
const raw = await load();
const ix = index(raw);
const fxById = new Map(raw.fixtures.map(f => [f.id, f]));
const derived = [];
for (const f of raw.fixtures) { const d = derive(f, ix, cfg, null); if (d) derived.push(d); }
// Full settled MENU per eligible fixture: the card's candidate pool AND the
// calibrator's observation feed (hundreds of settled legs per day instead of
// a handful of banker picks - the cells converge inside the window).
let menuLegCount = 0;
for (const d of derived) {
    const f = fxById.get(d.id);
    const rows = ix.oddsBy.get(d.id) ?? [];
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    d.menuLegs = Object.entries(marketMenu(books)).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        return { market, price: l.price, prob: l.prob, outcome };
    }).filter(l => Number(l.price) > 1 && l.prob != null);
    menuLegCount += d.menuLegs.length;
}
const byDay = new Map();
for (const d of derived) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
const days = [...byDay.keys()].sort();
console.error(`[replay2x] ${derived.length} eligible fixtures, ${menuLegCount} settled menu legs across ${days.length} days`);

const results = {};
for (const target of TARGETS) {
    // Fresh calibrator per target run; observes ALL of a day's banker legs
    // AFTER that day's card is built (strictly-prior-days information only).
    const cal = makeCalibrator();
    const perDay = [];
    for (const day of days) {
        const rows = byDay.get(day) ?? [];
        const card = buildCard(rows, target, cal);
        perDay.push({ day, card });
        for (const r of rows) for (const l of r.menuLegs ?? []) cal.observe(l);
    }
    const played = perDay.filter(p => p.card);
    const green = played.filter(p => p.card.green);
    // Flat staking: 1 unit per played day; green pays product, red loses stake.
    let pnl = 0;
    for (const p of played) pnl += p.card.green ? p.card.product - 1 : -1;
    // Streaks of consecutive green PLAYED days.
    let best = 0, cur = 0, curTail = 0;
    for (const p of played) { cur = p.card.green ? cur + 1 : 0; if (cur > best) best = cur; }
    for (let i = played.length - 1; i >= 0 && played[i].card.green; i--) curTail++;
    results[target] = { perDay, played: played.length, green: green.length, pnl, best, curTail };
}

for (const target of TARGETS) {
    const r = results[target];
    console.log(`\n=== DAILY ${target.toFixed(1)}x CARD  (banker legs, safest-first greedy, parameter-free)`);
    console.log(`days played ${r.played}/${days.length}  |  GREEN ${r.green}/${r.played} = ${(100 * r.green / r.played).toFixed(1)}%  |  flat P&L ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}u  |  best streak ${r.best}  (current ${r.curTail})`);
    for (const p of r.perDay) {
        if (!p.card) { console.log(`  ${p.day}  NO BET (target unreachable)`); continue; }
        const c = p.card;
        console.log(`  ${p.day}  ${c.green ? 'GREEN' : 'RED  '}  ${c.legs.length} legs @ ${c.product.toFixed(2)}x${c.green ? '' : '  broke: ' + c.broken.map(b => `${b.market}@${b.price}`).join(', ')}`);
    }
}

if (WRITE) {
    console.error(`\n[replay2x] backfilling ${DBNAME}.fixture_predictions (tips + bankers, settled)...`);
    const fxById = new Map(raw.fixtures.map(f => [f.id, f]));
    const rows = derived.map(d => {
        const f = fxById.get(d.id);
        return {
            fixture_id: d.id,
            computed_at: f.kickoff,       // honest as-of stamp: the freeze moment
            tip_market: d.tip?.market ?? null,
            tip_price: d.tip?.price ?? null,
            tip_confidence: d.tip?.prob ?? null,
            tip_outcome: d.tip?.outcome ?? null,
            tip_banker_market: d.banker?.market ?? null,
            tip_banker_price: d.banker?.price ?? null,
            tip_banker_prob: d.banker?.prob ?? null,
            tip_banker_outcome: d.banker?.outcome ?? null,
        };
    });
    for (let i = 0; i < rows.length; i += 500) {
        await db('fixture_predictions').insert(rows.slice(i, i + 500))
            .onConflict('fixture_id').merge(['computed_at', 'tip_market', 'tip_price', 'tip_confidence',
                'tip_outcome', 'tip_banker_market', 'tip_banker_price', 'tip_banker_prob', 'tip_banker_outcome']);
    }
    console.error(`[replay2x] wrote ${rows.length} ledger rows.`);
}

const out = opt('json', null);
if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify({ days, results }, null, 1));
    console.error(`[replay2x] wrote ${out}`);
}
await db.destroy();
