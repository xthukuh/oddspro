// Sharp 4x backtest over tmp/sharp/fx.ndjson, driving the PRODUCTION pure
// modules (src/db/sharp-rules.js + betpawa-bonus-rules.js) so the replay and
// the live builder share one definition.
//
// Walk-forward: day D's card is selected with a calibrator that has observed
// only fixtures whose EAT kickoff day is strictly before D; results are read
// only to settle D after selection. Prices are the last pre-kickoff BetPawa
// price (rows updated at/after kickoff were dropped by sharp-prep.js).
//
// Usage: node scripts/sharp-backtest.js [--last 14] [--json out.json] [--warmup 21]
import { readFileSync, writeFileSync } from 'node:fs';
import { tipOutcome } from '../src/db/tip-rules.js';
import { tipMarketLabel } from '../src/db/magic-rules.js';
import { makeSharpCalibrator, selectSharpCard, SHARP_DEFAULTS } from '../src/db/sharp-rules.js';
import { betpawaWinBonus } from '../src/db/betpawa-bonus-rules.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const LAST = Number(arg('last', 14));
const WARMUP = Number(arg('warmup', 21));
const OUT = arg('json', null);
const WHT = 0.20;

const fx = readFileSync(arg('file', 'tmp/sharp/fx.ndjson'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
fx.sort((a, b) => (a.ko < b.ko ? -1 : a.ko > b.ko ? 1 : a.id - b.id));
const days = [...new Set(fx.map(f => f.day))].sort();
const byDay = new Map(days.map(d => [d, []]));
for (const f of fx) {
    f.legs = Object.entries(f.prov.betpawa ?? {})
        .filter(([m]) => f.bpq?.[m] > 0)
        .map(([market, price]) => ({ market, price, q: f.bpq[market] }));
    byDay.get(f.day).push(f);
}

const cal = makeSharpCalibrator();
const cards = [];
for (let i = 0; i < days.length; i++) {
    const d = days[i], dayFx = byDay.get(d);
    if (i >= WARMUP) {
        const card = selectSharpCard(dayFx, cal);
        if (card) {
            const fxById = new Map(dayFx.map(f => [f.id, f]));
            const legs = card.legs.map(l => {
                const f = fxById.get(l.fixture);
                return {
                    fixture: l.fixture, match: `${f.hn} v ${f.an}`, league: f.league, kickoff: f.ko,
                    market: l.market, label: tipMarketLabel(l.market), price: l.price,
                    q: +l.q.toFixed(4), P: +l.P.toFixed(4), score: `${f.ft[0]}-${f.ft[1]}`,
                    outcome: tipOutcome(l.market, f.ft[0], f.ft[1]),
                };
            });
            const won = legs.every(l => l.outcome !== 'miss');
            const live = card.legs.filter((l, j) => legs[j].outcome !== 'void');
            const paid = won ? betpawaWinBonus(live.map(l => ({ price: l.price, winProbability: l.q }))).totalOdds : 0;
            cards.push({
                day: d, legs, slipOdds: +card.slipOdds.toFixed(3), totalOdds: +card.totalOdds.toFixed(3),
                bonusPct: card.bonus.pct, predProb: +card.predProb.toFixed(4), bookProb: +card.bookProb.toFixed(4),
                won, paid: +paid.toFixed(3),
            });
        } else {
            cards.push({ day: d, noCard: true, fixtures: dayFx.length });
        }
    }
    for (const f of dayFx) {
        for (const l of f.legs) {
            let outcome; try { outcome = tipOutcome(l.market, f.ft[0], f.ft[1]); } catch { continue; }
            cal.observe({ ...l, outcome });
        }
    }
}

function stats(list) {
    const pub = list.filter(c => !c.noCard);
    const n = pub.length, w = pub.filter(c => c.won).length;
    let run = 0, worst = 0, wrun = 0, bestWin = 0;
    for (const c of pub) { run = c.won ? 0 : run + 1; worst = Math.max(worst, run); wrun = c.won ? wrun + 1 : 0; bestWin = Math.max(bestWin, wrun); }
    const ret = pub.reduce((a, c) => a + c.paid, 0);
    const net = pub.reduce((a, c) => a + (c.won ? 1 + (1 - WHT) * (c.paid - 1) : 0), 0);
    return {
        days: list.length, published: n, won: w, winRate: n ? +(w / n).toFixed(4) : null,
        predicted: n ? +(pub.reduce((a, c) => a + c.predProb, 0) / n).toFixed(4) : null,
        bookPredicted: n ? +(pub.reduce((a, c) => a + c.bookProb, 0) / n).toFixed(4) : null,
        avgOdds: n ? +(pub.reduce((a, c) => a + c.totalOdds, 0) / n).toFixed(3) : null,
        unitsGross: +(ret - n).toFixed(2), roiGross: n ? +(ret / n - 1).toFixed(4) : null,
        unitsNetWHT: +(net - n).toFixed(2), roiNetWHT: n ? +(net / n - 1).toFixed(4) : null,
        longestLosingRun: worst, longestWinRun: bestWin,
    };
}
const half = Math.floor(cards.length / 2);
const summary = {
    params: SHARP_DEFAULTS,
    all: stats(cards), h1: stats(cards.slice(0, half)), h2: stats(cards.slice(half)),
    last: stats(cards.slice(-LAST)),
};
console.log(JSON.stringify(summary, null, 1));
console.log(`\nLast ${LAST} days (walk-forward, results read only after selection):`);
for (const c of cards.slice(-LAST)) {
    if (c.noCard) { console.log(`${c.day}  no card`); continue; }
    console.log(`${c.day}  ${c.won ? 'WON ' : 'LOST'}  ${c.slipOdds.toFixed(2)}x -> ${c.totalOdds.toFixed(2)}x with bonus  | `
        + c.legs.map(l => `${l.match} [${l.label} @${l.price}] ${l.score} ${l.outcome}`).join(' | '));
}
if (OUT) writeFileSync(OUT, JSON.stringify({ summary, cards }, null, 1));
