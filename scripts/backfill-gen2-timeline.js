// Gen-2 timeline backfill: replay the PRODUCTION ladder (selectLadderCards +
// DEFAULT_GEN2 + the production calibrator with errorBoost) walk-forward over
// history and rewrite the backfilled daily_slips timeline - what ships is
// what gets battle-tested. Honesty: pre-kickoff odds only, tip-eligible picks
// only, cells observe a day AFTER its cards are built, computed_at = first
// taken-leg kickoff, rows marked backfilled=1. Today stays owned by the live
// builder.
//
//   node scripts/backfill-gen2-timeline.js          # dry-run report
//   node scripts/backfill-gen2-timeline.js --yes    # write daily_slips
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { makeCalibrator, cellKey } from '../src/db/leg-calibration.js';
import { DEFAULT_GEN2, selectLadderCards, slipOutcomeRollup } from '../src/db/daily-slip-rules.js';
import { DEFAULT_HUNT, makeHuntState, observeHuntLeg, selectHunterPicks, huntDayNum } from '../src/db/value-hunt.js';
import { fitGoalModel, modelMarkets } from '../src/db/goal-model.js';
import { tipMarketLabel } from '../src/db/magic-rules.js';
import { ALGO_VERSION } from '../src/daily-slip.js';

const confirmed = process.argv.includes('--yes');

const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[gen2-backfill] loading...');
const raw = await load();
const ix = index(raw);
const eligible = new Set();
const tipByFixture = new Map();
for (const f of raw.fixtures) {
    const d = derive(f, ix, cfg, null);
    if (!d) continue;
    eligible.add(d.id);
    if (d.tip) tipByFixture.set(d.id, d.tip.market);
}
const fxById = new Map(raw.fixtures.map(f => [f.id, f]));
const byDay = new Map();
for (const f of raw.fixtures) {
    const rows = ix.oddsBy.get(f.id);
    if (!rows?.length) continue;
    const books = buildTipBooks(rows, { homeName: f.home_name, awayName: f.away_name }, cfg.tip);
    const menuLegs = Object.entries(marketMenu(books)).map(([market, l]) => {
        let outcome = null;
        try { outcome = tipOutcome(market, f.ft_home, f.ft_away); } catch { outcome = null; }
        return { market, price: Number(l.price), prob: l.prob, outcome };
    }).filter(l => l.price > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
    if (!menuLegs.length) continue;
    let list = byDay.get(f.day); if (!list) byDay.set(f.day, list = []);
    list.push({
        id: f.id, day: f.day, league: f.league ?? '', menuLegs,
        eligible: eligible.has(f.id), tipMarket: tipByFixture.get(f.id) ?? null,
        fx: { impliedOver: menuLegs.find(l => l.market === 'O 2.5')?.prob ?? null },
        home_team_id: f.home_team_id, away_team_id: f.away_team_id, league_id: f.league_id,
    });
}
const days = [...byDay.keys()].sort();
const [[{ today }]] = await db.raw("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') as today");

const cal = makeCalibrator({ halfLifeDays: 30 });
const huntState = makeHuntState();
console.error('[gen2-backfill] fitting per-day goal models...');
const modelByDay = new Map(days.map(day => [day, fitGoalModel(raw.history, Date.parse(`${day}T00:00:00+03:00`), cfg.model)]));
const rows = [];
let green = 0, played = 0;
for (const day of days) {
    const dayRows = byDay.get(day) ?? [];
    let cards = null;
    let hunters = [];
    if (day < today) {
        cards = selectLadderCards(dayRows, cal, DEFAULT_GEN2);
        const model = modelByDay.get(day);
        const usedFixtures = new Set(cards.flatMap(c => c.legs.map(l => l.fixture)));
        const huntRows = dayRows.map(r => ({
            ...r,
            modelProbs: (() => { try { return modelMarkets(model, r.home_team_id, r.away_team_id, r.league_id); } catch { return null; } })(),
        }));
        hunters = selectHunterPicks(huntRows, huntState, huntDayNum(day), DEFAULT_HUNT, usedFixtures);
        const legs = cards.flatMap((card, i) => card.legs.map(l => {
            const f = fxById.get(l.fixture);
            const menu = dayRows.find(r => r.id === l.fixture);
            const outcome = menu?.menuLegs.find(m => m.market === l.market)?.outcome ?? null;
            const score = f.ft_home != null && f.ft_away != null ? `${f.ft_home}-${f.ft_away}` : null;
            return {
                fixture_id: l.fixture,
                home: f.home_name, away: f.away_name, league: l.league,
                kickoff: f.kickoff instanceof Date ? f.kickoff.toISOString() : f.kickoff,
                market: l.market, label: tipMarketLabel(l.market),
                price: l.price, prices: {}, links: {},
                prob: l.prob, cal_prob: l.calProb, cell: l.cell, cell_key: cellKey(l),
                card: i, kind: card.tier, tier_label: card.label,
                reasoning: l.cell
                    ? `${card.label} pick: ${tipMarketLabel(l.market)} at ${l.price.toFixed(2)}, calibrated ${(100 * l.calProb).toFixed(1)}% from ${l.cell.n.toFixed(0)} settled legs in its cell.`
                    : `${card.label} pick: ${tipMarketLabel(l.market)} at ${l.price.toFixed(2)}, book devig ${(100 * l.calProb).toFixed(1)}% (no cell evidence yet).`,
                outcome, score,
            };
        })).concat(hunters.map(h => {
            const f = fxById.get(h.fixture);
            const outcome = dayRows.find(r => r.id === h.fixture)?.menuLegs.find(m => m.market === h.market)?.outcome ?? null;
            return {
                fixture_id: h.fixture,
                home: f.home_name, away: f.away_name, league: h.league,
                kickoff: f.kickoff instanceof Date ? f.kickoff.toISOString() : f.kickoff,
                market: h.market, label: tipMarketLabel(h.market),
                price: h.price, prices: {}, links: {},
                prob: h.prob, cal_prob: h.p, cell: null, cell_key: null,
                card: cards.length, kind: 'hunter', tier_label: 'Hunter singles',
                hunt_ev: +h.ev.toFixed(3), hunt_band: h.band,
                reasoning: `Hunter single (${h.band} band): ${tipMarketLabel(h.market)} at ${h.price.toFixed(2)}, claimed edge ${(100 * h.ev).toFixed(0)}%.`,
                outcome, score: f.ft_home != null ? `${f.ft_home}-${f.ft_away}` : null,
            };
        }));
        if (!legs.length) {
            rows.push({
                slip_date: day, status: 'no_slip', mood: 'red', legs: '[]',
                combined_odds: null, legs_total: 0, legs_hit: null,
                cards_total: 0, cards_won: null, outcome: null,
                algo_version: `${ALGO_VERSION}-backfill`, backfilled: 1,
                computed_at: `${day} 00:00:00`, settled_at: db.fn.now(),
            });
        } else {
            const anchor = cards.find(c => c.tier === 'anchor');
            const anchorLegs = legs.filter(l => l.kind === 'anchor');
            const roll = slipOutcomeRollup((anchorLegs.length ? anchorLegs : legs).map(l => l.outcome));
            const byCard = new Map();
            for (const l of legs) {
                if (l.kind === 'hunter') continue;   // singles, never a parlay rollup
                let list = byCard.get(l.card); if (!list) byCard.set(l.card, list = []);
                list.push(l.outcome);
            }
            const kicks = legs.map(l => l.kickoff).sort();
            if (roll.outcome === 'won') green++;
            if (roll.outcome === 'won' || roll.outcome === 'lost') played++;
            rows.push({
                slip_date: day, status: 'published',
                mood: cards.length >= 3 && anchor ? 'green' : (anchor ? 'amber' : 'red'),
                legs: JSON.stringify(legs),
                combined_odds: Math.round(((anchor ?? cards[0])?.product ?? 1) * 100) / 100,
                legs_total: legs.length,
                legs_hit: legs.filter(l => l.outcome === 'hit').length,
                outcome: roll.outcome,
                cards_total: cards.length + (hunters.length ? 1 : 0),
                cards_won: [...byCard.values()].filter(list => slipOutcomeRollup(list).outcome === 'won').length,
                algo_version: `${ALGO_VERSION}-backfill`, backfilled: 1,
                computed_at: new Date(kicks[0]), settled_at: db.fn.now(),
            });
        }
    }
    // Walk-forward feed AFTER the day's cards; errorBoost on taken misses.
    for (const r of dayRows) for (const l of r.menuLegs) {
        cal.observe({ ...l, day, league: r.league });
        observeHuntLeg(huntState, l, r.fx, day);
    }
    if (cards && DEFAULT_GEN2.errorBoost > 0) {
        for (const card of cards) for (const l of card.legs) {
            const outcome = byDay.get(day)?.find(r => r.id === l.fixture)?.menuLegs.find(m => m.market === l.market)?.outcome;
            if (outcome !== 'miss') continue;
            for (let i = 0; i < DEFAULT_GEN2.errorBoost; i++) cal.observe({ market: l.market, price: l.price, prob: l.prob, outcome: 'miss', day, league: l.league });
        }
    }
}

let hN = 0, hHit = 0, hPnl = 0;
for (const r of rows) {
    if (r.status !== 'published') continue;
    for (const l of JSON.parse(r.legs)) {
        if (l.kind !== 'hunter' || (l.outcome !== 'hit' && l.outcome !== 'miss')) continue;
        hN++;
        if (l.outcome === 'hit') { hHit++; hPnl += l.price - 1; } else hPnl -= 1;
    }
}
console.log(`[gen2-backfill] hunter singles: ${hN} legs, ${hN ? (100 * hHit / hN).toFixed(1) : 0}% hit, P&L ${hPnl.toFixed(1)}u (flat 1u).`);

const anyGreenDays = rows.filter(r => {
    if (r.status !== 'published') return false;
    return (r.cards_won ?? 0) > 0;
}).length;
console.log(`[gen2-backfill] ${rows.length} days: anchor-strict green ${green}/${played} (${played ? (100 * green / played).toFixed(1) : 0}%), any-card green ${anyGreenDays}/${rows.filter(r => r.status === 'published').length}.`);
if (!confirmed) {
    console.log('Dry-run. Re-run with --yes to rewrite the backfilled daily_slips timeline (today stays live-owned).');
} else {
    for (let i = 0; i < rows.length; i += 100) {
        await db('daily_slips').insert(rows.slice(i, i + 100)).onConflict('slip_date')
            .merge(['status', 'mood', 'legs', 'combined_odds', 'legs_total', 'legs_hit',
                'cards_total', 'cards_won', 'outcome', 'algo_version', 'backfilled',
                'computed_at', 'settled_at']);
    }
    console.log(`[gen2-backfill] wrote ${rows.length} rows (algo ${ALGO_VERSION}-backfill).`);
}
await db.destroy();
