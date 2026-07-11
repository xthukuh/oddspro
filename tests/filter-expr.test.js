import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    rawValue, evalCondition, evalGroup, filterRows, parseExpr, evalExpr,
} from '../web/src/filterExpr.js';

// Column descriptors the App feeds the client engine (full catalog shape).
const COLUMNS = [
    { key: 'goals', group: 'base' },
    { key: 'score', group: 'base' },
    { key: 'league', group: 'base' },
    { key: 'fixture', group: 'base' },
    { key: 'tip', group: 'base' },
    { key: 'home_form', group: 'stat' },
    { key: 'h2h_count', group: 'stat' },
    { key: 'fs:Total Shots', group: 'stat' },
    { key: '1', group: 'market' },
    { key: 'O 2.5', group: 'market' },
];

const row = (over = {}) => ({
    api_id: 1,
    goals: 3,
    score: '2-1',
    league: 'England - Premier League',
    fixture: 'Arsenal - Chelsea',
    home_form: 'LWWWD', // 3+3+3+1 = 10 pts
    h2h_count: 5,
    tip_market: 'O 2.5',
    tip_confidence: 0.8,
    stats: { 'fs:Total Shots': '10 / 5' }, // sum 15
    markets: { 1: 2.1, 'O 2.5': 1.5 },
    ...over,
});

// --- rawValue -----------------------------------------------------------
test('rawValue returns the displayed underlying value per group', () => {
    const r = row();
    assert.equal(rawValue(r, { key: 'home_form', group: 'stat' }), 'LWWWD');
    assert.equal(rawValue(r, { key: 'tip', group: 'base' }), 'O 2.5');
    assert.equal(rawValue(r, { key: 'O 2.5', group: 'market' }), 1.5);
    assert.equal(rawValue(r, { key: 'fs:Total Shots', group: 'stat' }), '10 / 5');
    assert.equal(rawValue(r, { key: 'missing', group: 'base' }), null);
});

test('evalCondition: date columns compare against a date-string value', () => {
    // start_time sorts as a timestamp; a 'YYYY-MM-DD' value must parse as a date
    // (advanced/group filters evaluate date columns client-side).
    const cols = [{ key: 'start_time', group: 'base' }];
    const r = { start_time: '2026-07-11 15:00:00' };
    assert.equal(evalCondition(r, { key: 'start_time', op: 'gte', value: '2026-07-11' }, cols), true);
    assert.equal(evalCondition(r, { key: 'start_time', op: 'lt', value: '2026-07-11' }, cols), false);
    assert.equal(evalCondition(r, { key: 'start_time', op: 'gt', value: '2026-07-12' }, cols), false);
});

// --- evalCondition: parity with the existing flat-AND semantics ---------
test('evalCondition: numeric comparison uses the derived sort value', () => {
    // home_form 'LWWWD' -> 10 pts > 5
    assert.equal(evalCondition(row(), { key: 'home_form', op: 'gt', value: '5' }, COLUMNS), true);
    assert.equal(evalCondition(row({ home_form: 'LLLLD' }), { key: 'home_form', op: 'gt', value: '5' }, COLUMNS), false);
});

test('evalCondition: like/not-contains match raw text; null raw never satisfies', () => {
    assert.equal(evalCondition(row(), { key: 'home_form', op: 'like', value: 'www' }, COLUMNS), true);
    assert.equal(evalCondition(row({ home_form: 'DLLDL' }), { key: 'home_form', op: 'not-contains', value: 'w' }, COLUMNS), true);
    assert.equal(evalCondition(row({ home_form: null }), { key: 'home_form', op: 'like', value: 'w' }, COLUMNS), false);
    assert.equal(evalCondition(row({ home_form: null }), { key: 'home_form', op: 'not-contains', value: 'w' }, COLUMNS), false);
});

test('evalCondition: in/not-in over a CSV list with number normalization', () => {
    assert.equal(evalCondition(row({ markets: { 1: 2.1 } }), { key: '1', op: 'in', value: '2.1,3.0' }, COLUMNS), true);
    assert.equal(evalCondition(row({ tip_market: '1X' }), { key: 'tip', op: 'not-in', value: '"O 2.5","O 0.5"' }, COLUMNS), true);
    assert.equal(evalCondition(row({ tip_market: null }), { key: 'tip', op: 'in', value: 'O 2.5' }, COLUMNS), false);
});

test('evalCondition: column-to-column compares derived values, missing side fails', () => {
    assert.equal(evalCondition(row({ h2h_count: 2, markets: { 'O 2.5': 1.5 } }), { key: 'h2h_count', op: 'gt', col: 'O 2.5' }, COLUMNS), true);
    assert.equal(evalCondition(row({ h2h_count: 1, markets: { 'O 2.5': 1.5 } }), { key: 'h2h_count', op: 'gt', col: 'O 2.5' }, COLUMNS), false);
    assert.equal(evalCondition(row({ h2h_count: 4, markets: {} }), { key: 'h2h_count', op: 'gt', col: 'O 2.5' }, COLUMNS), false);
});

test('evalCondition: missing value never satisfies, even ne; unknown op is false', () => {
    assert.equal(evalCondition(row({ h2h_count: null }), { key: 'h2h_count', op: 'ne', value: '3' }, COLUMNS), false);
    assert.equal(evalCondition(row(), { key: 'goals', op: 'nope', value: '2' }, COLUMNS), false);
});

test('evalCondition: tip like matches market text, numeric ops use confidence', () => {
    assert.equal(evalCondition(row({ tip_market: 'O 2.5', tip_confidence: 0.8 }), { key: 'tip', op: 'like', value: 'o 2' }, COLUMNS), true);
    assert.equal(evalCondition(row({ tip_market: 'O 2.5', tip_confidence: 0.8 }), { key: 'tip', op: 'gte', value: '0.7' }, COLUMNS), true);
    assert.equal(evalCondition(row({ tip_market: '1X', tip_confidence: 0.6 }), { key: 'tip', op: 'gte', value: '0.7' }, COLUMNS), false);
});

// --- new regex ops: match / not-match (safe) ----------------------------
test('evalCondition: match / not-match are case-insensitive over raw text', () => {
    assert.equal(evalCondition(row({ home_form: 'LWWWD' }), { key: 'home_form', op: 'match', value: '^lw' }, COLUMNS), true);
    assert.equal(evalCondition(row({ home_form: 'DLLDL' }), { key: 'home_form', op: 'match', value: '^lw' }, COLUMNS), false);
    assert.equal(evalCondition(row({ home_form: 'DLLDL' }), { key: 'home_form', op: 'not-match', value: '^lw' }, COLUMNS), true);
    assert.equal(evalCondition(row({ home_form: null }), { key: 'home_form', op: 'match', value: '.*' }, COLUMNS), false);
});

test('evalCondition: an invalid or overlong regex is a false match, never a throw', () => {
    assert.equal(evalCondition(row(), { key: 'home_form', op: 'match', value: '(' }, COLUMNS), false);
    const huge = 'a'.repeat(5000);
    assert.equal(evalCondition(row(), { key: 'home_form', op: 'match', value: huge }, COLUMNS), false);
});

// --- evalGroup: nested AND / OR -----------------------------------------
test('evalGroup: AND requires every item, OR requires any', () => {
    const r = row({ goals: 3, h2h_count: 5 });
    const and = { type: 'group', join: 'and', items: [
        { key: 'goals', op: 'gte', value: '3' },
        { key: 'h2h_count', op: 'gte', value: '4' },
    ] };
    const or = { type: 'group', join: 'or', items: [
        { key: 'goals', op: 'gte', value: '9' },
        { key: 'h2h_count', op: 'gte', value: '4' },
    ] };
    assert.equal(evalGroup(r, and, COLUMNS), true);
    assert.equal(evalGroup(row({ goals: 1, h2h_count: 5 }), and, COLUMNS), false);
    assert.equal(evalGroup(r, or, COLUMNS), true);
    assert.equal(evalGroup(row({ goals: 1, h2h_count: 1 }), or, COLUMNS), false);
});

test('evalGroup: nested (A or B) and C', () => {
    const model = { type: 'group', join: 'and', items: [
        { type: 'group', join: 'or', items: [
            { key: 'goals', op: 'gte', value: '5' },
            { key: 'home_form', op: 'gt', value: '5' },
        ] },
        { key: 'h2h_count', op: 'gte', value: '4' },
    ] };
    assert.equal(evalGroup(row({ goals: 1, home_form: 'LWWWD', h2h_count: 5 }), model, COLUMNS), true);
    assert.equal(evalGroup(row({ goals: 1, home_form: 'LLLLL', h2h_count: 5 }), model, COLUMNS), false);
    assert.equal(evalGroup(row({ goals: 6, home_form: 'LLLLL', h2h_count: 1 }), model, COLUMNS), false);
});

test('evalGroup: an empty group is a neutral pass (no constraint)', () => {
    assert.equal(evalGroup(row(), { type: 'group', join: 'and', items: [] }, COLUMNS), true);
    assert.equal(evalGroup(row(), { type: 'group', join: 'or', items: [] }, COLUMNS), true);
});

// --- filterRows: model + flat-array backward compat ---------------------
test('filterRows: applies a group model over the rows', () => {
    const rows = [row({ goals: 3 }), row({ goals: 1 }), row({ goals: 5 })];
    const model = { type: 'group', join: 'and', items: [{ key: 'goals', op: 'gte', value: '3' }] };
    assert.deepEqual(filterRows(rows, model, COLUMNS).map(r => r.goals), [3, 5]);
});

test('filterRows: a flat array is an implicit top-level AND (backward compatible)', () => {
    const rows = [row({ goals: 3, h2h_count: 5 }), row({ goals: 3, h2h_count: 1 })];
    const flat = [
        { key: 'goals', op: 'gte', value: '3' },
        { key: 'h2h_count', op: 'gte', value: '4' },
    ];
    assert.deepEqual(filterRows(rows, flat, COLUMNS).map(r => r.h2h_count), [5]);
});

test('filterRows: an empty model returns the rows unchanged (same reference)', () => {
    const rows = [row(), row()];
    assert.equal(filterRows(rows, [], COLUMNS), rows);
    assert.equal(filterRows(rows, { type: 'group', join: 'and', items: [] }, COLUMNS), rows);
});

// --- expression mode: parseExpr / evalExpr (no eval) ---------------------
test('parseExpr + evalExpr: arithmetic precedence and parentheses', () => {
    assert.equal(evalExpr(row(), '1 + 2 * 3', COLUMNS), 7);
    assert.equal(evalExpr(row(), '(1 + 2) * 3', COLUMNS), 9);
    assert.equal(evalExpr(row(), '7 % 3', COLUMNS), 1);
    assert.equal(evalExpr(row(), '-4 + 1', COLUMNS), -3);
});

test('evalExpr: $row[...] refs yield the derived sort value', () => {
    assert.equal(evalExpr(row({ goals: 3 }), "$row['goals'] > 2", COLUMNS), true);
    assert.equal(evalExpr(row({ home_form: 'LWWWD' }), "$row['home_form'] >= 10", COLUMNS), true);
    assert.equal(evalExpr(row({ goals: null }), "$row['goals'] > 2", COLUMNS), false);
});

test('evalExpr: boolean logic with && || ! and/or keywords', () => {
    const r = row({ goals: 3, h2h_count: 5 });
    assert.equal(evalExpr(r, "$row['goals'] > 2 && $row['h2h_count'] >= 3", COLUMNS), true);
    assert.equal(evalExpr(r, "$row['goals'] > 9 or $row['h2h_count'] == 5", COLUMNS), true);
    assert.equal(evalExpr(r, "not ($row['goals'] > 9)", COLUMNS), true);
    assert.equal(evalExpr(r, "$row['goals'] = 3 and $row['h2h_count'] <> 4", COLUMNS), true);
});

test('evalExpr: contains / in / raw helpers reuse the display + CSV semantics', () => {
    const r = row({ fixture: 'Arsenal - Chelsea', tip_market: 'O 2.5' });
    assert.equal(evalExpr(r, "contains($row['fixture'], 'arsenal')", COLUMNS), true);
    assert.equal(evalExpr(r, "in(raw('tip'), 'O 2.5, 1X')", COLUMNS), true);
    assert.equal(evalExpr(r, "in(raw('tip'), '1X, X2')", COLUMNS), false);
});

test('parseExpr: throws a descriptive error on bad syntax (for live validation)', () => {
    assert.throws(() => parseExpr('1 + '), /parse|expected|unexpected/i);
    assert.throws(() => parseExpr("$row['goals'] >"), /parse|expected|unexpected/i);
    assert.throws(() => parseExpr('('.repeat(50)), /parse|expected|unexpected|deep|nest/i);
});

test('evalExpr: no access to globals or member/function escapes', () => {
    // bare identifiers that are not whitelisted helpers/keywords are rejected
    assert.throws(() => parseExpr('constructor'), /unknown|unexpected|identifier/i);
    assert.throws(() => parseExpr('globalThis'), /unknown|unexpected|identifier/i);
    assert.throws(() => parseExpr("$row['x'].constructor"), /unexpected|member|parse/i);
    // an overlong expression is rejected before evaluation
    assert.throws(() => parseExpr('1+'.repeat(2000) + '1'), /too long|length|parse/i);
});

test('evalCondition: an expr-type condition evaluates truthiness to a boolean', () => {
    assert.equal(evalCondition(row({ goals: 3 }), { type: 'expr', expr: "$row['goals'] > 2" }, COLUMNS), true);
    assert.equal(evalCondition(row({ goals: 1 }), { type: 'expr', expr: "$row['goals'] > 2" }, COLUMNS), false);
    // a malformed expr condition is a false match, never a throw
    assert.equal(evalCondition(row(), { type: 'expr', expr: '1 +' }, COLUMNS), false);
});
