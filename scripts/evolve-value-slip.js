#!/usr/bin/env node
// VALUE-SEEKING evolution of the daily multi-bet (owner directive 2026-08-06:
// "the multi-bets should be valuable - run simulations with real risk;
// error-backprop past mistakes; repeat until an emergent is apparent").
// Fitness is PROFIT PER STAKED UNIT at real odds (green rate and streak are
// tiebreaks) - the opposite pole of the survival evolution. Deterministic
// coordinate-descent generations, walk-forward calibration (strictly prior
// days), TRAIN search + untouched TEST tail: ambition in the search space,
// honesty in the measurement.
//
// Construction: rank the day's qualifying legs, deal them greedily into
// cards that each CLOSE once combined odds reach targetOdds (the replay
// showcase's buildCard rule), up to maxCards cards/day.
//
// Usage: node scripts/evolve-value-slip.js --db oddspro [--json tmp/val.json]
import 'dotenv/config';
import { load, index, derive, db } from './simulate.js';
import { DEFAULT_TIP, buildTipBooks, tipOutcome } from '../src/db/tip-rules.js';
import { DEFAULT_LADDER, marketMenu } from '../src/db/ladder-rules.js';
import { DEFAULT_MODEL } from '../src/db/goal-model.js';
import { bandOf, groupOf } from '../src/db/leg-calibration.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const SHRINK_K = 50;
const MAX_GENERATIONS = 12;

// Start from the replay showcase's proven odds-bearing arm (calibrated
// 1.5x-target card: 61.8% green, +2.35u over 34 days) expressed here.
// Round 3 seed = the round-2 emergent (two 1.5x cards). The owner's ship
// mandate adds: max profit with the LEAST legs per card - avgLegs joins the
// fitness as the final tiebreak and 2-leg cards enter the space.
// --target <odds> pins the target for the whole run (the higher-value
// question: each target gets its own evolution instead of retreating to
// 1.5x); production decay is the seed calibrator since it carries the
// live +9.5%/unit value record.
const TARGET = Number(opt('target', 1.5));
const SEED = {
    targetOdds: TARGET, maxCards: 2, maxLegsPerCard: 6, maxPerLeague: 3,
    probFloor: 0.80, minLegPrice: 1.0, maxLegPrice: 1.35,
    rankBy: 'eff',             // 'eff' | 'prob' | 'value' (calProb x price - 1)
    edgeFloor: 0,              // round 2: only legs with calibrated edge >= this
    familyFilter: 'all',       // round 2: market-family tilt (audit structure)
    halfLifeDays: 30,          // error-feedback: recency decay (production parity)
    missCooldownDays: 0,       // error-feedback: bench a cell after a miss
};

const SPACE = {
    targetOdds: [TARGET],      // pinned per run via --target
    maxCards: [1, 2, 3],
    maxLegsPerCard: [2, 3, 4, 6, 8],
    probFloor: [0.70, 0.75, 0.80, 0.85, 0.88, 0.90],
    minLegPrice: [1.0, 1.10, 1.20],
    maxLegPrice: [1.35, 1.60, 2.20, 3.50],
    rankBy: ['eff', 'prob', 'value'],
    edgeFloor: [0, 0.02, 0.05, 0.10],
    familyFilter: ['all', 'no-overs', 'safe-sides'],
    halfLifeDays: [0, 14, 30],
    missCooldownDays: [0, 3, 7],
};

// Family tilts from the 2026-08-04 calibration audit (every Over-side key
// carries negative edge; Unders and result-side markets positive).
const OVER_GROUPS = new Set(['over', 'tt-over', 'O0.5']);
const SAFE_GROUPS = new Set(['under', 'tt-under', 'dc', 'dnb', '1x2']);
const familyOk = (config, group) => config.familyFilter === 'no-overs' ? !OVER_GROUPS.has(group)
    : config.familyFilter === 'safe-sides' ? SAFE_GROUPS.has(group) : true;

const cfg = { tip: { ...DEFAULT_TIP }, ladder: { ...DEFAULT_LADDER }, model: { ...DEFAULT_MODEL }, h2hWindow: 5 };
console.error('[value-evolve] loading...');
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
        return { market, price: l.price, prob: l.prob, outcome };
    }).filter(l => Number(l.price) > 1 && l.prob != null && (l.outcome === 'hit' || l.outcome === 'miss'));
}
const byDay = new Map();
for (const d of derived) { let l = byDay.get(d.day); if (!l) byDay.set(d.day, l = []); l.push(d); }
const days = [...byDay.keys()].sort();
const TRAIN_END = Math.floor(days.length * 2 / 3);
const trainDays = days.slice(0, TRAIN_END);
const testDays = days.slice(TRAIN_END);
console.error(`[value-evolve] ${derived.length} fixtures / ${days.length} days; train ${trainDays.length} test ${testDays.length}`);

const dayNum = d => Date.parse(`${d}T00:00:00Z`) / 86400000;
const cellOf = l => `${groupOf(l.market)}|${bandOf(Number(l.price))}`;

function replay(config, evalDays) {
    const cells = new Map();   // key -> {n, hit, day, lastMissDay}
    const perDay = [];
    const decayed = (c, day) => {
        if (!config.halfLifeDays || day == null || c.day == null || day <= c.day) return c;
        const f = 0.5 ** ((day - c.day) / config.halfLifeDays);
        return { ...c, n: c.n * f, hit: c.hit * f, day };
    };
    for (const day of days) {
        const dn = dayNum(day);
        const rows = byDay.get(day) ?? [];
        if (evalDays.includes(day)) {
            // Best qualifying leg per fixture under the config's ranking.
            const picked = [];
            for (const r of rows) {
                let best = null;
                for (const l of r.menuLegs) {
                    const price = Number(l.price);
                    if (!(price > 1) || price > config.maxLegPrice) continue;
                    if (config.minLegPrice > 1 && price < config.minLegPrice) continue;
                    if (!familyOk(config, groupOf(l.market))) continue;
                    const c0 = cells.get(cellOf(l));
                    const c = c0 ? decayed(c0, dn) : null;
                    if (config.missCooldownDays > 0 && c?.lastMissDay != null
                        && dn - c.lastMissDay <= config.missCooldownDays) continue;
                    const calProb = c && c.n > 0 ? (c.hit + SHRINK_K * l.prob) / (c.n + SHRINK_K) : l.prob;
                    if (calProb < config.probFloor) continue;
                    if (config.edgeFloor > 0 && calProb * price - 1 < config.edgeFloor) continue;
                    const eff = -Math.log(Math.max(1e-9, Math.min(1, calProb))) / Math.log(price);
                    const score = config.rankBy === 'eff' ? -eff
                        : config.rankBy === 'value' ? calProb * price - 1
                        : calProb;
                    const cand = { ...l, league: r.league, calProb, score };
                    if (!best || cand.score > best.score) best = cand;
                }
                if (best) picked.push(best);
            }
            picked.sort((a, b) => (b.score - a.score) || (a.price - b.price));
            // Deal ranked legs into target-closing cards.
            const cards = [];
            const perLeague = new Map();
            let cur = [], prod = 1;
            for (const l of picked) {
                if (cards.length >= config.maxCards) break;
                const n = perLeague.get(l.league) ?? 0;
                if (n >= config.maxPerLeague) continue;
                perLeague.set(l.league, n + 1);
                cur.push(l); prod *= Number(l.price);
                if (prod >= config.targetOdds || cur.length >= config.maxLegsPerCard) {
                    if (prod >= config.targetOdds) cards.push({ legs: cur, product: prod });
                    cur = []; prod = 1;   // an unclosable card is discarded, never bet
                }
            }
            if (cards.length) {
                let pnl = 0, green = 0;
                for (const c of cards) {
                    const won = c.legs.every(l => l.outcome === 'hit');
                    pnl += won ? c.product - 1 : -1;
                    if (won) green++;
                }
                perDay.push({ day, cards: cards.length, cardsWon: green, staked: cards.length, pnl,
                    legsTotal: cards.reduce((s, c) => s + c.legs.length, 0),
                    avgOdds: cards.reduce((s, c) => s + c.product, 0) / cards.length });
            } else {
                perDay.push({ day, cards: 0 });
            }
        }
        for (const r of rows) for (const l of r.menuLegs) {
            const k = cellOf(l);
            let c = cells.get(k) ?? { n: 0, hit: 0, day: null, lastMissDay: null };
            c = decayed(c, dn);
            c.n++; if (l.outcome === 'hit') c.hit++; else c.lastMissDay = dn;
            c.day = Math.max(c.day ?? dn, dn);
            cells.set(k, c);
        }
    }
    const played = perDay.filter(p => p.cards > 0);
    const staked = played.reduce((s, p) => s + p.staked, 0);
    const pnl = played.reduce((s, p) => s + p.pnl, 0);
    const cardsWon = played.reduce((s, p) => s + p.cardsWon, 0);
    const cards = played.reduce((s, p) => s + p.cards, 0);
    let best = 0, cur = 0;
    for (const p of played) {              // streak of days with >= 1 winning card
        cur = p.cardsWon > 0 ? cur + 1 : 0; if (cur > best) best = cur;
    }
    return {
        played: played.length, cards, cardsWon,
        cardRate: cards ? cardsWon / cards : 0,
        roi: staked ? pnl / staked : -1,
        pnl, best,
        avgOdds: cards ? played.reduce((s, p) => s + p.avgOdds * p.cards, 0) / cards : 0,
        avgLegs: cards ? played.reduce((s, p) => s + (p.legsTotal ?? 0), 0) / cards : 0,
    };
}

// FITNESS (round 2, anti-mirage): the train window is split in half and a
// config's primary score is its WORST-half ROI - profit must hold in both
// sub-regimes, not be donated by one hot week (round 1's +28.8% train
// champion collapsed to -41.6% on test; this is the structural fix). Then
// card rate, then any-win day streak.
const trainA = trainDays.slice(0, Math.floor(trainDays.length / 2));
const trainB = trainDays.slice(Math.floor(trainDays.length / 2));
const fitnessCmp = (a, b) => (b.minRoi - a.minRoi) || (b.cardRate - a.cardRate) || (b.best - a.best)
    || ((a.avgLegs ?? 9) - (b.avgLegs ?? 9));   // least legs per card wins ties (ship mandate)
const fmt = r => `${r.cardsWon}/${r.cards} cards=${(100 * r.cardRate).toFixed(1)}% roi ${r.roi >= 0 ? '+' : ''}${(100 * r.roi).toFixed(1)}% pnl ${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}u dayStk${r.best} @${r.avgOdds.toFixed(2)}x over ${r.played}d`;
const cfgKey = c => JSON.stringify(c);

const minPlayed = Math.ceil(trainDays.length * 2 / 3);
const seen = new Map();
const evalTrain = c => {
    const k = cfgKey(c);
    if (!seen.has(k)) {
        const whole = replay(c, trainDays);
        const a = replay(c, trainA), b = replay(c, trainB);
        seen.set(k, { ...whole, minRoi: Math.min(a.roi, b.roi), roiA: a.roi, roiB: b.roi });
    }
    return seen.get(k);
};

let champion = { ...SEED };
let champFit = evalTrain(champion);
console.log(`gen 0 (seed 1.5x-eff): ${fmt(champFit)}`);
let stable = 0;
for (let gen = 1; gen <= MAX_GENERATIONS && stable < 2; gen++) {
    let bestCfg = champion, bestFit = champFit;
    for (const [knob, values] of Object.entries(SPACE)) {
        for (const v of values) {
            if (champion[knob] === v) continue;
            const cand = { ...champion, [knob]: v };
            const fit = evalTrain(cand);
            if (fit.played < minPlayed) continue;
            if (fitnessCmp(fit, bestFit) < 0) { bestCfg = cand; bestFit = fit; }
        }
    }
    if (cfgKey(bestCfg) === cfgKey(champion)) {
        stable++;
        console.log(`gen ${gen}: stable ${stable}/2`);
    } else {
        stable = 0;
        const diff = Object.keys(bestCfg).filter(k => bestCfg[k] !== champion[k])
            .map(k => `${k}: ${champion[k]} -> ${bestCfg[k]}`).join(', ');
        champion = bestCfg; champFit = bestFit;
        console.log(`gen ${gen}: ${diff}  =>  ${fmt(champFit)}`);
    }
}

console.log(`\nchampion: ${cfgKey(champion)}`);
console.log(`TRAIN seed     ${fmt(replay(SEED, trainDays))}`);
console.log(`TRAIN champion ${fmt(champFit)}`);
console.log(`TEST  seed     ${fmt(replay(SEED, testDays))}`);
console.log(`TEST  champion ${fmt(replay(champion, testDays))}`);
console.log(`FULL  seed     ${fmt(replay(SEED, days))}`);
console.log(`FULL  champion ${fmt(replay(champion, days))}`);

// Per-target arms of the champion (the owner reads the risk ladder off this).
console.log('\nchampion re-targeted (FULL window):');
for (const t of SPACE.targetOdds) {
    console.log(`  target ${t.toFixed(1)}x: ${fmt(replay({ ...champion, targetOdds: t }, days))}`);
}

const out = opt('json', null);
if (out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(out, JSON.stringify({ champion, evaluated: seen.size,
        train: champFit, test: replay(champion, testDays), full: replay(champion, days) }, null, 1));
    console.error(`[value-evolve] wrote ${out}`);
}
await db.destroy();
