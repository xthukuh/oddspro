import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankedView, rankedSignature, RANKED_STRATEGY } from '../src/db/ranked-rules.js';
import { safeSelection, sureBetsSelection, DEFAULT_SURE_BETS } from '../src/db/magic-rules.js';
import { orderRows, rankedApplies, orderByRanked, rankedScores, rowsForFixtures } from '../web/src/ordering.js';
import { scoreTip } from '../src/db/magic-rules.js';

// A day of two-provider fixtures with Picks (the banker strategy's input)
// and blended tips (the Safe gates' input). Prices and chances vary so the
// orderings are non-trivial; fixture 5 has no Pick and sinks.
const bd = (p, n = 6) => ({ market_prob: p, stats_prob: p + 0.02, api_prob: p - 0.01, samples: { home_n: n, away_n: n, h2h_n: 3 } });
function dayRows() {
    const fx = [
        { api: 1, cal: 0.61, tp: 1.3, conf: 0.8 },
        { api: 2, cal: 0.66, tp: 1.25, conf: 0.84 },
        { api: 3, cal: 0.58, tp: 1.6, conf: 0.6 },
        { api: 4, cal: 0.66, tp: 1.2, conf: 0.86 },
        { api: 5, cal: null, tp: 1.4, conf: 0.7 },
        { api: 6, cal: 0.55, tp: 1.35, conf: 0.78 },
    ];
    let id = 100;
    const rows = [];
    for (const f of fx) {
        for (const provider of ['betpawa', 'betika']) {
            rows.push({
                match_id: id++, api_id: f.api, provider, start_time: '2026-10-17T12:00:00.000Z',
                tip_market: 'U 3.5', tip_price: f.tp, tip_confidence: f.conf, tip_breakdown: bd(f.conf),
                ...(f.cal == null ? {} : {
                    tip_banker_market: '1X', tip_banker_price: 1.6, tip_banker_prob: f.cal - 0.02, tip_banker_cal: f.cal,
                }),
            });
        }
    }
    return rows;
}
const MAGIC = { generated_at: '2026-10-18T10:00:00.000Z', calibration: { markets: { 'U 3.5': { n: 60, hits: 50 } } }, safe: { maxPerDay: 2 } };

test('the delivered order equals the browser orderRows for the default chain, on the whole day and on subsets', () => {
    const rows = dayRows();
    const ranked = rankedView(rows, MAGIC);
    const chain = [{ type: 'magic', id: RANKED_STRATEGY }];
    assert.equal(rankedApplies(chain, ranked), true);
    const ids = rs => rs.map(r => r.match_id);
    assert.deepEqual(ids(orderByRanked(rows, ranked)), ids(orderRows(rows, chain, [], MAGIC.calibration)));
    // a client filter / one-of-each subset keeps the same relative order
    const subset = rows.filter(r => r.provider === 'betika' || r.api_id === 3);
    assert.deepEqual(ids(orderByRanked(subset, ranked)), ids(orderRows(subset, chain, [], MAGIC.calibration)));
    // the tipless-Pick fixture sinks in both
    assert.deepEqual(ids(orderByRanked(rows, ranked)).slice(-2), [108, 109]);
});

test('delivered scores equal scoreTip per row', () => {
    const rows = dayRows();
    const ranked = rankedView(rows, MAGIC);
    const scores = rankedScores(ranked);
    for (const r of rows) assert.equal(scores.get(r.match_id), scoreTip(r, RANKED_STRATEGY, MAGIC.calibration));
});

test('safe and sure memberships map back to the same rows the browser selection returns', () => {
    const rows = dayRows();
    const ranked = rankedView(rows, MAGIC);
    assert.deepEqual(rowsForFixtures(rows, ranked.safe), safeSelection(rows, MAGIC.calibration, MAGIC.safe));
    const sure = sureBetsSelection(rows, MAGIC.calibration, DEFAULT_SURE_BETS);
    assert.deepEqual(ranked.sure.map(e => e.api_id), sure.map(e => e.row.api_id));
    assert.deepEqual(ranked.sure.map(e => e.prob), sure.map(e => e.prob));
    assert.ok(ranked.safe.length > 0 && ranked.safe.length <= 2, 'the served cap applies');
});

test('a locked membership is null, never an empty list', () => {
    const ranked = rankedView(dayRows(), MAGIC, { allowSafe: false, allowSure: false });
    assert.equal(ranked.safe, null);
    assert.equal(ranked.sure, null);
    assert.equal(ranked.order.length, 12);
});

test('rankedApplies only for exactly the ranked strategy', () => {
    const ranked = rankedView(dayRows(), MAGIC);
    assert.equal(rankedApplies([], ranked), false);
    assert.equal(rankedApplies([{ type: 'magic', id: 'value' }], ranked), false);
    assert.equal(rankedApplies([{ type: 'magic', id: 'banker' }, { type: 'column', key: 'goals', dir: 'desc' }], ranked), false);
    assert.equal(rankedApplies([{ type: 'magic', id: 'banker' }], null), false);
});

test('rankedSignature moves with the calibration, the safe policy and the gates', () => {
    const base = rankedSignature(MAGIC);
    assert.equal(rankedSignature(null), 'pending');
    assert.notEqual(rankedSignature({ ...MAGIC, generated_at: 'x' }), base);
    assert.notEqual(rankedSignature({ ...MAGIC, safe: { maxPerDay: 3 } }), base);
    assert.notEqual(rankedSignature(MAGIC, { allowSafe: false }), base);
    assert.notEqual(rankedSignature(MAGIC, { allowSure: false }), base);
});
