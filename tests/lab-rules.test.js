// Data-viz lab rules (src/db/lab-rules.js). Pure, offline - feature/outcome
// catalogs, derivations from flat loader rows, numeric binning, the pre-binned
// outcome-rate aggregation with its minCount guardrail, and the lab filters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    LAB_FEATURES, LAB_OUTCOMES, labFeature, labOutcome, formPoints,
    featureValue, outcomeValue, binValue, applyLabFilters, aggregateOutcomeRate,
} from '../src/db/lab-rules.js';

// Minimal settled-fixture row as src/lab.js emits it. mysql2 returns DECIMAL
// columns as strings - the numeric fixtures here deliberately mix types.
function row(over = {}) {
    return {
        league: 'Premier League', country: 'England', tip_market: 'O 2.5',
        kickoff_hour: 18, home_rank: 3, away_rank: 15,
        home_form: 'WWDLW', away_form: 'LLDWL',
        h2h_n: 4, h2h_home_goals: 6, h2h_away_goals: 2,
        implied_over: '0.5500', tip_confidence: '0.7200', tip_price: '1.55',
        tip_outcome: 'hit', ft_home: 2, ft_away: 1,
        home_odds: '1.80', away_odds: '4.20', shots_total: '9', corners_total: '11',
        ...over,
    };
}

test('catalogs: unique keys, labelled, typed, JSON-safe plain data', () => {
    const fKeys = LAB_FEATURES.map(f => f.key);
    assert.equal(new Set(fKeys).size, fKeys.length);
    const oKeys = LAB_OUTCOMES.map(o => o.key);
    assert.equal(new Set(oKeys).size, oKeys.length);
    for (const f of LAB_FEATURES) {
        assert.ok(f.key && f.label, `${f.key} needs key+label`);
        assert.ok(['number', 'category'].includes(f.type), `${f.key} type`);
        if (f.type === 'number') assert.ok(f.bin?.width > 0, `${f.key} needs bin.width`);
        else assert.equal(f.bin, undefined, `${f.key} category has no bin`);
    }
    for (const o of LAB_OUTCOMES) assert.ok(o.key && o.label);
    // The features endpoint ships these verbatim - no functions/undefined holes.
    assert.deepEqual(JSON.parse(JSON.stringify(LAB_FEATURES)), LAB_FEATURES);
    assert.deepEqual(JSON.parse(JSON.stringify(LAB_OUTCOMES)), LAB_OUTCOMES);
    assert.equal(labFeature('rank_diff')?.type, 'number');
    assert.equal(labFeature('nope'), null);
    assert.equal(labOutcome('over25')?.key, 'over25');
    assert.equal(labOutcome('nope'), null);
});

test('formPoints: W/D/L points, tolerant of case/junk, null only when no games', () => {
    assert.equal(formPoints('WWDLW'), 10);
    assert.equal(formPoints('LLLLL'), 0); // zero points is a VALUE, not missing
    assert.equal(formPoints('wdl'), 4);
    assert.equal(formPoints('W-D?'), 4); // non-WDL chars ignored
    assert.equal(formPoints(''), null);
    assert.equal(formPoints(null), null);
    assert.equal(formPoints('--'), null);
});

test('featureValue: direct columns, decimal-string coercion, categories', () => {
    const r = row();
    assert.equal(featureValue(r, 'league'), 'Premier League');
    assert.equal(featureValue(r, 'tip_market'), 'O 2.5');
    assert.equal(featureValue(r, 'kickoff_hour'), 18);
    assert.equal(featureValue(r, 'implied_over'), 0.55); // '0.5500' -> number
    assert.equal(featureValue(r, 'tip_price'), 1.55);
    assert.equal(featureValue(r, 'home_odds'), 1.8);
    assert.equal(featureValue(r, 'shots_total'), 9);
    assert.equal(featureValue(row({ league: null }), 'league'), null);
    assert.equal(featureValue(row({ tip_price: null }), 'tip_price'), null);
    assert.throws(() => featureValue(r, 'nope'), TypeError);
});

test('featureValue: derived rank_diff / form_diff / h2h_avg_goals', () => {
    assert.equal(featureValue(row(), 'rank_diff'), -12); // 3 - 15: negative = home better
    assert.equal(featureValue(row({ home_rank: null }), 'rank_diff'), null);
    assert.equal(featureValue(row(), 'form_diff'), 10 - 4); // WWDLW=10, LLDWL=4
    assert.equal(featureValue(row({ away_form: null }), 'form_diff'), null);
    assert.equal(featureValue(row(), 'h2h_avg_goals'), 2); // (6+2)/4
    assert.equal(featureValue(row({ h2h_n: 0 }), 'h2h_avg_goals'), null);
    assert.equal(featureValue(row({ h2h_home_goals: null }), 'h2h_avg_goals'), null);
});

test('outcomeValue: all six outcomes + null when unsettled', () => {
    assert.equal(outcomeValue(row(), 'over25'), 1); // 2-1 = 3 goals
    assert.equal(outcomeValue(row({ ft_away: 0 }), 'over25'), 0);
    assert.equal(outcomeValue(row({ ft_home: null }), 'over25'), null);
    assert.equal(outcomeValue(row(), 'btts'), 1);
    assert.equal(outcomeValue(row({ ft_away: 0 }), 'btts'), 0);
    assert.equal(outcomeValue(row(), 'home_win'), 1);
    assert.equal(outcomeValue(row(), 'draw'), 0);
    assert.equal(outcomeValue(row(), 'away_win'), 0);
    assert.equal(outcomeValue(row({ ft_home: 1, ft_away: 1 }), 'draw'), 1);
    assert.equal(outcomeValue(row(), 'tip_hit'), 1);
    assert.equal(outcomeValue(row({ tip_outcome: 'miss' }), 'tip_hit'), 0);
    assert.equal(outcomeValue(row({ tip_outcome: null }), 'tip_hit'), null);
    assert.throws(() => outcomeValue(row(), 'nope'), TypeError);
});

test('binValue: bin starts, negatives, min/max clamps, float precision', () => {
    assert.equal(binValue('x', undefined), 'x'); // no bin spec = category passthrough
    assert.equal(binValue(7, { width: 5 }), 5);
    assert.equal(binValue(-7, { width: 5 }), -10); // floor, not trunc
    assert.equal(binValue(23, { width: 2, min: 0, max: 24 }), 22);
    assert.equal(binValue(24, { width: 2, min: 0, max: 24 }), 22); // >= max clamps into last bin
    assert.equal(binValue(-3, { width: 2, min: 0, max: 24 }), 0); // below min clamps up
    assert.equal(binValue(1.0, { width: 0.1, min: 0, max: 1 }), 0.9);
    assert.equal(binValue(0.65, { width: 0.05, min: 0, max: 1 }), 0.65); // no float drift
    assert.equal(binValue(0.7, { width: 0.1, min: 0, max: 1 }), 0.7);
    assert.equal(binValue(1.55, { width: 0.25, min: 1 }), 1.5);
    assert.equal(binValue('2.30', { width: 0.5, min: 1 }), 2); // string coerces
    assert.equal(binValue('nope', { width: 1 }), null);
    assert.equal(binValue(null, { width: 1 }), null);
});

test('aggregateOutcomeRate: groups by binned x, rate + count per cell', () => {
    const rows = [
        row({ tip_confidence: '0.62', tip_outcome: 'hit' }),
        row({ tip_confidence: '0.63', tip_outcome: 'miss' }),
        row({ tip_confidence: '0.78', tip_outcome: 'hit' }),
        row({ tip_confidence: null, tip_outcome: 'hit' }), // no x -> skipped
        row({ tip_confidence: '0.61', tip_outcome: null }), // no outcome -> skipped
    ];
    const res = aggregateOutcomeRate(rows, { xKey: 'tip_confidence', outcome: 'tip_hit', minCount: 1 });
    assert.equal(res.rows_used, 3);
    assert.equal(res.rows_skipped, 2);
    assert.equal(res.min_count, 1);
    assert.deepEqual(res.cells, [
        { x: 0.6, count: 2, hits: 1, rate: 0.5 },
        { x: 0.75, count: 1, hits: 1, rate: 1 },
    ]);
});

test('aggregateOutcomeRate: minCount guardrail nulls the rate, keeps the count', () => {
    const rows = [row(), row(), row({ ft_away: 0 })];
    const res = aggregateOutcomeRate(rows, { xKey: 'kickoff_hour', outcome: 'over25', minCount: 5 });
    assert.equal(res.cells.length, 1);
    assert.equal(res.cells[0].count, 3);
    assert.equal(res.cells[0].rate, null); // 3 < minCount 5
});

test('aggregateOutcomeRate: x+y grid and color series cells', () => {
    const rows = [
        row({ kickoff_hour: 12, tip_market: '1X' }),
        row({ kickoff_hour: 12, tip_market: '1X', ft_away: 0 }),
        row({ kickoff_hour: 19, tip_market: 'O 2.5' }),
    ];
    const grid = aggregateOutcomeRate(rows, { xKey: 'kickoff_hour', yKey: 'tip_confidence', outcome: 'over25', minCount: 1 });
    assert.ok(grid.cells.every(c => 'y' in c));
    const series = aggregateOutcomeRate(rows, { xKey: 'kickoff_hour', colorKey: 'tip_market', outcome: 'over25', minCount: 1 });
    assert.deepEqual(series.cells.map(c => c.color).sort(), ['1X', 'O 2.5']);
    assert.equal(series.cells.find(c => c.color === '1X').count, 2);
});

test('aggregateOutcomeRate: high-cardinality categories fold into (other)', () => {
    const rows = [];
    for (let i = 0; i < 20; i++) rows.push(row({ league: `League ${i % 5}` })); // 4 each
    for (let i = 0; i < 3; i++) rows.push(row({ league: `Rare ${i}` })); // 1 each
    const res = aggregateOutcomeRate(rows, { xKey: 'league', outcome: 'over25', minCount: 1, topCategories: 5 });
    const other = res.cells.find(c => c.x === '(other)');
    assert.ok(other, 'rare leagues fold into (other)');
    assert.equal(other.count, 3);
    assert.equal(res.cells.length, 6); // top 5 + (other)
});

test('aggregateOutcomeRate: numeric x sorted ascending, categories by count desc', () => {
    const rows = [row({ kickoff_hour: 20 }), row({ kickoff_hour: 8 }), row({ kickoff_hour: 8 })];
    const num = aggregateOutcomeRate(rows, { xKey: 'kickoff_hour', outcome: 'over25', minCount: 1 });
    assert.deepEqual(num.cells.map(c => c.x), [8, 20]);
    const rows2 = [row({ league: 'B' }), row({ league: 'A' }), row({ league: 'A' })];
    const cat = aggregateOutcomeRate(rows2, { xKey: 'league', outcome: 'over25', minCount: 1 });
    assert.deepEqual(cat.cells.map(c => c.x), ['A', 'B']);
});

test('aggregateOutcomeRate: unknown keys throw TypeError (server maps to 400)', () => {
    assert.throws(() => aggregateOutcomeRate([], { xKey: 'nope', outcome: 'over25' }), TypeError);
    assert.throws(() => aggregateOutcomeRate([], { xKey: 'league', outcome: 'nope' }), TypeError);
    assert.throws(() => aggregateOutcomeRate([], { xKey: 'league', yKey: 'nope', outcome: 'over25' }), TypeError);
});

test('applyLabFilters: numeric ops, category eq/like, null drops the row', () => {
    const rows = [
        row({ tip_price: '1.30', league: 'Premier League' }),
        row({ tip_price: '2.10', league: 'Serie A' }),
        row({ tip_price: null, league: 'Serie A' }),
    ];
    assert.equal(applyLabFilters(rows, [{ key: 'tip_price', op: 'lte', value: 1.5 }]).length, 1);
    assert.equal(applyLabFilters(rows, [{ key: 'league', op: 'eq', value: 'Serie A' }]).length, 2);
    assert.equal(applyLabFilters(rows, [{ key: 'league', op: 'like', value: 'serie' }]).length, 2);
    assert.equal(applyLabFilters(rows, [{ key: 'league', op: 'ne', value: 'Serie A' }]).length, 1);
    // null feature value never matches - even a lax op drops it
    assert.equal(applyLabFilters(rows, [{ key: 'tip_price', op: 'gt', value: 0 }]).length, 2);
    assert.equal(applyLabFilters(rows, []).length, 3);
    assert.throws(() => applyLabFilters(rows, [{ key: 'nope', op: 'eq', value: 1 }]), TypeError);
    assert.throws(() => applyLabFilters(rows, [{ key: 'tip_price', op: 'zap', value: 1 }]), TypeError);
    assert.throws(() => applyLabFilters(rows, [{ key: 'tip_price', op: 'gt', value: 'NaN-y' }]), TypeError);
});
